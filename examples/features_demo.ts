/**
 * GraphIngest SDK — Feature Demo (TypeScript)
 * =============================================
 *
 * Demonstrates the 3 new SDK capabilities:
 *   1. Exponential backoff + jitter  (RetryPolicy)
 *   2. .map() / .submit() fan-out    (parallel Cloud Run dispatch)
 *   3. Subgraphs                     (nested graph() inside graph())
 *
 * Prerequisites:
 *   npm install graphingest
 *   export GRAPHINGEST_API_URL=http://localhost:3000
 *   export GRAPHINGEST_API_KEY=your-key
 */

import {
  node,
  graph,
  GraphRunContext,
  type RetryPolicy,
} from "../src/index";

// ---------------------------------------------------------------------------
// 1. Define some node functions
// ---------------------------------------------------------------------------

const extract = node({ name: "extract" }, async (url: string) => {
  console.log(`  [extract] Fetching ${url}`);
  return { url, rows: 42 };
});

const transform = node({ name: "transform" }, async (data: { url: string; rows: number }) => {
  console.log(`  [transform] Processing ${data.url}`);
  return { ...data, transformed: true };
});

const load = node({ name: "load" }, async (record: { url: string; rows: number; transformed: boolean }) => {
  console.log(`  [load] Loaded ${record.url} (${record.rows} rows)`);
  return `loaded:${record.url}`;
});

// ---------------------------------------------------------------------------
// 2. Subgraph: a reusable ETL sub-pipeline
// ---------------------------------------------------------------------------

const etlSingleSource = graph(
  {
    name: "etl-single-source",
    retryPolicy: {
      maxRetries: 2,
      delayMs: 1000,
      backoffFactor: 2, // delays: ~1s, ~2s
      jitter: true,
    },
  },
  async (url: string) => {
    const data = await extract(url);
    const transformed = await transform(data);
    const result = await load(transformed);
    return result;
  }
);

// ---------------------------------------------------------------------------
// 3. Top-level graph with .map(), .submit(), and subgraph calls
// ---------------------------------------------------------------------------

const multiSourcePipeline = graph(
  {
    name: "multi-source-pipeline",
    retryPolicy: {
      maxRetries: 3,
      delayMs: 2000,
      backoffFactor: 3, // delays: ~2s, ~6s, ~18s
      maxDelayMs: 30_000,
      jitter: true,
    },
    timeoutMs: 600_000,
  },
  async (urls: string[]) => {
    const ctx = GraphRunContext.get();
    console.log(`Pipeline started: run=${ctx?.graphRunId}`);

    // ── Feature 1: .map() fan-out ─────────────────────────────────────
    // Dispatches len(urls) parallel Cloud Run invocations of "extract".
    // Blocks until all complete. Returns ordered results.
    console.log(`\n→ Fan-out: extracting ${urls.length} sources in parallel...`);
    const extracted = await (extract as any).map(urls);
    console.log(`  Got ${extracted.length} results`);

    // ── Feature 2: .submit() async dispatch ───────────────────────────
    // Fire off a transform in the background while we do other work.
    console.log("\n→ Submitting async transform...");
    const future = await (transform as any).submit(extracted[0]);
    // ... do other work here ...
    const firstTransformed = await future.result({ timeoutMs: 60_000 });
    console.log(`  Async result:`, firstTransformed);

    // ── Feature 3: Subgraph ───────────────────────────────────────────
    // Call another graph() from within this graph().
    // It gets its own graphRunId with parentGraphRunId linking back.
    console.log("\n→ Running subgraph for remaining sources...");
    const subResults: string[] = [];
    for (const url of urls.slice(1)) {
      const result = await etlSingleSource(url);
      subResults.push(result);
    }

    return {
      totalSources: urls.length,
      firstResult: firstTransformed,
      subResults,
    };
  }
);

// ---------------------------------------------------------------------------
// Run it
// ---------------------------------------------------------------------------

async function main() {
  const result = await multiSourcePipeline([
    "https://api.example.com/dataset-a",
    "https://api.example.com/dataset-b",
    "https://api.example.com/dataset-c",
  ]);
  console.log("\n✓ Pipeline complete:", result);
}

main().catch(console.error);
