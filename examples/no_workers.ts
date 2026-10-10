/**
 * TypeScript orchestration without a worker process.
 *
 * Define the graph, call deploy(), and the platform runs it.
 * When nothing is running, there is nothing to keep warm.
 *
 * Run:
 *   npm install graphingest
 *   npx tsx no_workers.ts
 */

import { node, graph, deploy } from "graphingest";

const fetchPage = node(
  { name: "fetch-page", cacheTtl: 3600, maxRetries: 3 },
  async (url: string) => {
    const resp = await fetch(url);
    return { url, status: resp.status };
  }
);

const pipeline = graph(
  {
    name: "web-scraper",
    timeoutMs: 3_600_000,
    retryPolicy: { maxRetries: 2, delayMs: 1_000, backoffFactor: 2 },
  },
  async (urls: string[]) => {
    const pages = await (fetchPage as { map: (items: string[]) => Promise<unknown[]> }).map(urls);
    return { fetched: pages.length };
  }
);

await deploy();

const result = await pipeline([
  "https://example.com",
  "https://jsonplaceholder.typicode.com/posts/1",
]);
console.log(result);
