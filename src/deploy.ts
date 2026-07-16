/**
 * GraphIngest deploy() — push code to the platform.
 *
 * Scans your project for node()/graph() calls, optionally reads a local
 * .env file, and uploads everything to the GraphIngest platform.
 */

import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative, resolve, extname } from "node:path";
import { GraphIngestClient } from "./client";

// ---------------------------------------------------------------------------
// .env parser
// ---------------------------------------------------------------------------

function parseEnvFile(filePath: string): Record<string, string> {
  const vars: Record<string, string> = {};
  if (!existsSync(filePath)) return vars;

  const content = readFileSync(filePath, "utf-8");
  for (const raw of content.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const eqIdx = line.indexOf("=");
    if (eqIdx === -1) continue;
    const key = line.slice(0, eqIdx).trim();
    let val = line.slice(eqIdx + 1).trim();
    // Strip surrounding quotes
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (key) vars[key] = val;
  }
  return vars;
}

// ---------------------------------------------------------------------------
// Source file scanner
// ---------------------------------------------------------------------------

const DECORATOR_RE = /(?:node|graph)\s*\(/;
const SKIP_DIRS = new Set([
  "node_modules",
  ".git",
  ".next",
  "dist",
  "build",
  ".venv",
  "__pycache__",
]);

function findSourceFiles(dir: string, ext: string): string[] {
  const results: string[] = [];

  function walk(current: string) {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      if (entry.name.startsWith(".") || SKIP_DIRS.has(entry.name)) continue;
      const full = join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full);
      } else if (extname(entry.name) === ext) {
        try {
          const content = readFileSync(full, "utf-8");
          if (DECORATOR_RE.test(content)) {
            results.push(full);
          }
        } catch {
          // skip unreadable files
        }
      }
    }
  }

  walk(dir);
  return results;
}

// ---------------------------------------------------------------------------
// deploy()
// ---------------------------------------------------------------------------

export interface DeployOptions {
  /**
   * Optional path to a .env file (relative or absolute).
   * Accepts any name: ".env", ".env.local", "config/prod.env", etc.
   * If omitted, env vars are read from the dashboard only.
   */
  envPath?: string;
  /** Path to package.json for dependencies (default: "package.json") */
  packageJson?: string;
  /** Project root directory (default: process.cwd()) */
  projectDir?: string;
}

export interface DeployResult {
  functions: string[];
  dashboardEnvVars?: string[];
  [key: string]: unknown;
}

/**
 * Push your code to the GraphIngest platform.
 *
 * Scans for files containing node()/graph() calls and uploads them.
 * The platform builds an execution environment and makes your functions
 * available for .run(), .map(), .arun().
 *
 * Environment variables:
 *   - If `envPath` is provided, reads that file and uploads those variables.
 *     Dashboard variables with the same key take precedence at runtime.
 *   - If `envPath` is omitted, all env vars come from the dashboard.
 *
 * @example
 * // Dashboard-only:
 * await deploy();
 *
 * // With a local .env file:
 * await deploy({ envPath: ".env" });
 *
 * // .env.local or absolute path:
 * await deploy({ envPath: ".env.local" });
 * await deploy({ envPath: "/home/me/secrets/prod.env" });
 */
export async function deploy(options?: DeployOptions): Promise<DeployResult> {
  const projectDir = options?.projectDir ?? process.cwd();
  const pkgJsonPath = options?.packageJson ?? "package.json";

  // 1. Find source files with node()/graph()
  console.log("Scanning for node()/graph() functions...");
  const tsFiles = findSourceFiles(projectDir, ".ts");
  const jsFiles = findSourceFiles(projectDir, ".js");
  const sourceFiles = [...tsFiles, ...jsFiles];

  if (sourceFiles.length === 0) {
    throw new Error(
      `No TypeScript/JavaScript files with node() or graph() found in ${projectDir}`
    );
  }
  console.log(
    `  Found ${sourceFiles.length} file(s) with node()/graph() calls`
  );

  // 2. Read env file (only if envPath provided)
  let envVars: Record<string, string> = {};
  if (options?.envPath) {
    const resolved = resolve(projectDir, options.envPath);
    envVars = parseEnvFile(resolved);
    if (Object.keys(envVars).length > 0) {
      console.log(`Environment variables (from ${options.envPath}):`);
      for (const key of Object.keys(envVars).sort()) {
        console.log(`  ✓ ${key}`);
      }
    } else {
      console.log(
        `  Warning: ${options.envPath} not found or empty — using dashboard variables only`
      );
    }
  } else {
    console.log("  No envPath provided — using dashboard variables only");
  }

  // 3. Read package.json dependencies
  const resolvedPkgJson = resolve(projectDir, pkgJsonPath);
  let dependencies: Record<string, string> | undefined;
  if (existsSync(resolvedPkgJson)) {
    try {
      const pkg = JSON.parse(readFileSync(resolvedPkgJson, "utf-8"));
      dependencies = pkg.dependencies;
      const depCount = Object.keys(dependencies ?? {}).length;
      console.log(`  Found ${depCount} dependencies in ${pkgJsonPath}`);
    } catch {
      console.log(`  Warning: could not parse ${pkgJsonPath}`);
    }
  } else {
    console.log(
      `  No ${pkgJsonPath} found — only graphingest will be installed`
    );
  }

  // 4. Prepare payload
  const files: Record<string, string> = {};
  for (const filepath of sourceFiles) {
    const relPath = relative(projectDir, filepath);
    files[relPath] = readFileSync(filepath, "utf-8");
  }

  const payload = {
    files,
    dependencies,
    env_vars: envVars,
    language: "typescript",
  };

  // 5. Upload to platform
  console.log("Uploading to GraphIngest platform...");
  const client = new GraphIngestClient();
  const res = await fetch(`${(client as any).baseUrl}/api/deploy`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${(client as any).apiKey}`,
    },
    body: JSON.stringify(payload),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Deploy failed (${res.status}): ${text}`);
  }

  const result = (await res.json()) as DeployResult;

  // 6. Show dashboard env var summary
  const dashboardVars = result.dashboardEnvVars ?? [];
  if (dashboardVars.length > 0) {
    const dashboardOnly = dashboardVars.filter((k) => !(k in envVars));
    const overrides = dashboardVars.filter((k) => k in envVars);
    if (dashboardOnly.length > 0) {
      console.log("Dashboard variables:");
      for (const key of dashboardOnly.sort()) {
        console.log(`  ✓ ${key}`);
      }
    }
    if (overrides.length > 0) {
      console.log("Dashboard overrides (take precedence over env file):");
      for (const key of overrides.sort()) {
        console.log(`  ⚠ ${key}`);
      }
    }
  }

  // 7. Report success
  const functions = result.functions ?? [];
  console.log(`Deployed. ${functions.length} function(s) registered:`);
  for (const fn of functions) {
    console.log(`  • ${fn}`);
  }

  return result;
}
