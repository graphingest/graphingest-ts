# GraphIngest TypeScript SDK

TypeScript SDK for the [GraphIngest](https://graphingest.io) workflow orchestration platform — define pipeline nodes and graphs with typed wrappers, deploy with one call.

## Installation

```bash
npm install graphingest
```

## Quick Start

```typescript
import { node, graph, deploy } from "graphingest";

const extract = node({ name: "extract", cacheTtl: 3600 },
  async (url: string) => ({ url, rows: 100 })
);

const transform = node({ name: "transform" },
  async (data: Record<string, unknown>) => ({ cleaned: true, ...data })
);

const pipeline = graph({
  name: "etl-pipeline",
  retryPolicy: { maxRetries: 3, delayMs: 1000, backoffFactor: 2, jitter: true },
  timeoutMs: 600_000,
}, async (url: string) => {
  const data = await extract(url);
  return await transform(data);
});

await deploy();
```

## Features

- **`node()` wrapper** — Define individual tasks with caching, retries, and timeouts
- **`graph()` wrapper** — Compose nodes into pipelines with retry policies and state hooks
- **`.map()` fan-out** — Parallel execution across multiple inputs
- **`.arun()` async dispatch** — Fire-and-forget with `NodeFuture`
- **`deploy()`** — Push code to platform with zero config
- **Full type inference** — End-to-end TypeScript types
- **ESM & CJS** — Works in both module systems
- **Built-in ReAct agents** — AI agent orchestration with tool calling

## Fan-Out (.map)

```typescript
const pipeline = graph({ name: "parallel-pipeline" },
  async (urls: string[]) => {
    const results = await extract.map(urls, { timeoutMs: 60_000 });
    return results;
  }
);
```

## Async Dispatch (.arun)

```typescript
const pipeline = graph({ name: "async-pipeline" },
  async (data: Record<string, unknown>) => {
    const future = await transform.arun(data);
    await doOtherStuff();
    const result = await future.result({ timeoutMs: 120_000 });
    return result;
  }
);
```

## AI Agent Orchestration

```typescript
import { agent } from "graphingest";

const researcher = agent({
  name: "researcher",
  tools: [search],
  model: "standard",
  systemPrompt: "You are a research assistant.",
}, async (query: string) => query);

const answer = await researcher("What are the latest advances in fusion energy?");
```

## Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `GRAPHINGEST_API_URL` | Yes | Control plane URL |
| `GRAPHINGEST_API_KEY` | Yes | API key |

## Documentation

Full documentation at [graphingest.io/docs](https://graphingest.io/docs)

## License

MIT
