/**
 * Problem: Vercel Cron Job Timeouts
 *
 * Your Next.js app has a nightly sync triggered by Vercel cron.
 * Vercel functions timeout at 10s (Hobby) or 60s (Pro).
 * Your sync takes 30 minutes. It fails every night.
 *
 * Solution: GraphIngest dispatches to Cloud Run workers.
 * Your cron route returns in <1s. Pipeline runs for hours.
 *
 * Run: npx tsx vercel_cron_timeout.ts
 */

import { node, graph, deploy } from "graphingest";

const syncSource = node(
  { name: "sync-source", cacheTtl: 1800, maxRetries: 3 },
  async (source: { name: string; apiUrl: string }) => {
    const resp = await fetch(source.apiUrl);
    const data = await resp.json();
    return {
      source: source.name,
      recordsSynced: Array.isArray(data) ? data.length : 1,
    };
  }
);

const nightlySync = graph({
  name: "nightly-sync",
  timeoutMs: 7_200_000, // 2 hours — impossible on Vercel, easy here
  retryPolicy: { maxRetries: 2, delayMs: 30_000, backoffFactor: 2 },
}, async (sources: Array<{ name: string; apiUrl: string }>) => {
  const results = await (syncSource as any).map(sources);
  const total = results.reduce((sum: number, r: any) => sum + r.recordsSynced, 0);
  return { sourcesSynced: results.length, totalRecords: total };
});

// ── Your Next.js cron handler would look like: ──
// export async function GET() {
//   const client = new GraphIngestClient();
//   const run = await client.triggerFlowRun("nightly-sync", { sources: [...] });
//   return Response.json({ runId: run.id }); // returns in <1s
// }

await deploy();
const result = await nightlySync([
  { name: "users", apiUrl: "https://jsonplaceholder.typicode.com/users" },
  { name: "posts", apiUrl: "https://jsonplaceholder.typicode.com/posts" },
  { name: "comments", apiUrl: "https://jsonplaceholder.typicode.com/comments" },
]);
console.log(`Synced ${result.totalRecords} records from ${result.sourcesSynced} sources`);
