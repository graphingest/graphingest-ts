/**
 * GraphIngest deploy() — push code to the platform.
 *
 * Scans your project for node()/graph() calls, optionally reads a local
 * .env file, and uploads everything to the GraphIngest platform.
 */
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
export declare function deploy(options?: DeployOptions): Promise<DeployResult>;
