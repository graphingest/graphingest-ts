/**
 * GraphIngest ETL Pipeline — TypeScript
 *
 * Multi-source ETL with fan-out, subgraphs, and async dispatch.
 *
 * Run:
 *   npm install graphingest
 *   npx tsx etl_pipeline.ts
 */

import { node, graph, deploy, GraphRunContext } from "graphingest";

// ── Nodes ──

const extractFromApi = node(
  { name: "extract-api", cacheTtl: 1800, maxRetries: 3 },
  async (source: { name: string; url: string }) => {
    const resp = await fetch(source.url);
    const data = await resp.json();
    const records = Array.isArray(data) ? data : data.results ?? data.data ?? [data];
    return {
      source: source.name,
      recordCount: records.length,
      records: records.slice(0, 100),
    };
  }
);

const transformRecord = node({ name: "transform-record" }, async (record: Record<string, unknown>) => {
  const cleaned: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(record)) {
    const cleanKey = key.toLowerCase().replace(/[\s-]/g, "_");
    cleaned[cleanKey] = typeof value === "string" ? value.trim() : value;
  }
  cleaned._processed = true;
  return cleaned;
});

const loadToDb = node({ name: "load-to-db", maxRetries: 2 }, async (batch: { source: string; records: unknown[] }) => {
  console.log(`Loading ${batch.records.length} records from ${batch.source}`);
  // In production: await db.insertMany("raw_data", batch.records);
  return { source: batch.source, loadedCount: batch.records.length, status: "success" };
});

// ── Subgraph: single source ETL ──

const etlSingleSource = graph(
  {
    name: "single-source-etl",
    retryPolicy: { maxRetries: 2, delayMs: 1000 },
    timeoutMs: 120_000,
  },
  async (source: { name: string; url: string }) => {
    const raw = await extractFromApi(source);
    const transformed = [];
    for (const record of raw.records as Record<string, unknown>[]) {
      transformed.push(await transformRecord(record));
    }
    return await loadToDb({ source: raw.source, records: transformed });
  }
);

// ── Main pipeline ──

const etlPipeline = graph(
  {
    name: "multi-source-etl",
    retryPolicy: { maxRetries: 3, delayMs: 2000, backoffFactor: 3, jitter: true },
    timeoutMs: 600_000,
    onCompletion: [(ctx, result) => console.log("Pipeline completed:", result)],
    onFailure: [(ctx, err) => console.error("Pipeline FAILED:", err)],
  },
  async (sources: Array<{ name: string; url: string }>) => {
    const ctx = GraphRunContext.get()!;
    console.log(`Starting ETL pipeline (run=${ctx.graphRunId})`);

    // Fan-out: extract from all sources in parallel
    const rawData = await (extractFromApi as any).map(sources);

    // Run each source through the subgraph
    const results = [];
    for (const source of sources) {
      results.push(await etlSingleSource(source));
    }

    const totalLoaded = results.reduce((sum: number, r: any) => sum + r.loadedCount, 0);
    return { sourcesProcessed: results.length, totalRecordsLoaded: totalLoaded, results };
  }
);

// ── Run ──

await deploy();

const result = await etlPipeline([
  { name: "users", url: "https://jsonplaceholder.typicode.com/users" },
  { name: "posts", url: "https://jsonplaceholder.typicode.com/posts" },
  { name: "todos", url: "https://jsonplaceholder.typicode.com/todos" },
]);
console.log(JSON.stringify(result, null, 2));
