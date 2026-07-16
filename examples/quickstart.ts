/**
 * GraphIngest Quick Start — TypeScript
 *
 * Save this file and run:
 *   npm install graphingest
 *   export GRAPHINGEST_API_URL=https://graphingest.io
 *   export GRAPHINGEST_API_KEY=your-api-key
 *   npx tsx quickstart.ts
 */

import { node, graph, deploy } from "graphingest";

// ── Step 1: Define your nodes ──

const fetchPage = node(
  { name: "fetch-page", cacheTtl: 3600, maxRetries: 3 },
  async (url: string) => {
    const resp = await fetch(url);
    const text = await resp.text();
    return { url, status: resp.status, length: text.length };
  }
);

const summarize = node({ name: "summarize" }, async (page: { url: string; status: number; length: number }) => {
  return `Page ${page.url}: ${page.length} chars, status ${page.status}`;
});

// ── Step 2: Compose into a graph ──

const scrapePipeline = graph(
  {
    name: "web-scraper",
    retryPolicy: { maxRetries: 2, delayMs: 1000, backoffFactor: 2, jitter: true },
    timeoutMs: 300_000,
  },
  async (urls: string[]) => {
    // Fan-out: fetch all URLs in parallel
    const pages = await (fetchPage as any).map(urls);

    // Process each result
    const summaries = [];
    for (const page of pages) {
      summaries.push(await summarize(page));
    }

    return { total: summaries.length, summaries };
  }
);

// ── Step 3: Deploy and run ──

await deploy();

const result = await scrapePipeline([
  "https://example.com",
  "https://httpbin.org/get",
  "https://jsonplaceholder.typicode.com/posts/1",
]);
console.log(result);
