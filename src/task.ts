/**
 * GraphIngest SDK: node() and graph() wrappers for TypeScript
 *
 * @node lifecycle:
 *   On Enter  → Set NodeRunContext; attach streaming logger.
 *   On Execute → Run function; capture all logs.
 *   On Exit   → Report COMPLETED + result_data.
 *
 * @graph lifecycle:
 *   On Enter  → Validate parameters (Zod if provided); set GraphRunContext; attach streaming logger.
 *   On Execute → Run function with timeout + retry loop.
 *   On Exit   → Fire state hooks (onCompletion / onFailure / onCancellation).
 */

import { randomUUID } from "node:crypto";
import { GraphIngestClient, LogEntry } from "./client";
import { GraphRunContext, NodeRunContext, GraphRunContextData } from "./context";
import { StreamingLogger } from "./logger";

let _client: GraphIngestClient | null = null;

function getClient(): GraphIngestClient {
  if (!_client) {
    _client = new GraphIngestClient();
  }
  return _client;
}

// ---------------------------------------------------------------------------
// Platform limits (tier-based)
// ---------------------------------------------------------------------------

export interface TierLimits {
  nodeDefaultTimeout: number;       // seconds
  nodeMaxTimeout: number;           // seconds
  graphDefaultTimeout: number;      // seconds
  graphMaxTimeout: number;          // seconds
  monthlyExecutionMinutes: number;  // 0 = unlimited
  maxPipelines: number;             // 0 = unlimited
}

export const PLATFORM_LIMITS: Record<string, TierLimits> = {
  free: {
    nodeDefaultTimeout: 300,       // 5 min
    nodeMaxTimeout: 600,           // 10 min
    graphDefaultTimeout: 900,      // 15 min
    graphMaxTimeout: 1800,         // 30 min
    monthlyExecutionMinutes: 60,   // 60 min/mo total
    maxPipelines: 5,
  },
  pro: {
    nodeDefaultTimeout: 600,       // 10 min
    nodeMaxTimeout: 3600,          // 60 min
    graphDefaultTimeout: 3600,     // 1 hr
    graphMaxTimeout: 21600,        // 6 hr
    monthlyExecutionMinutes: 0,    // unlimited
    maxPipelines: 0,               // unlimited
  },
  enterprise: {
    nodeDefaultTimeout: 3600,      // 60 min
    nodeMaxTimeout: 86400,         // 24 hr
    graphDefaultTimeout: 21600,    // 6 hr
    graphMaxTimeout: 86400,        // 24 hr
    monthlyExecutionMinutes: 0,    // unlimited
    maxPipelines: 0,               // unlimited
  },
};

function getTier(): string {
  return (process.env.GRAPHINGEST_TIER || "free").toLowerCase();
}

function getLimits(): TierLimits {
  return PLATFORM_LIMITS[getTier()] || PLATFORM_LIMITS.free;
}

function clampTimeout(
  requested: number | undefined,
  defaultKey: keyof TierLimits,
  maxKey: keyof TierLimits
): number {
  const limits = getLimits();
  if (requested == null || requested <= 0) return limits[defaultKey];
  if (requested > limits[maxKey]) {
    console.warn(
      `[graphingest] Requested timeout ${requested}s exceeds ${getTier()} tier max (${limits[maxKey]}s). Clamped.`
    );
    return limits[maxKey];
  }
  return requested;
}

// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------

export class NodeTimeoutError extends Error {
  constructor(message = "Node execution timed out") {
    super(message);
    this.name = "NodeTimeoutError";
  }
}

export class GraphTimeoutError extends Error {
  constructor(message = "Graph execution timed out") {
    super(message);
    this.name = "GraphTimeoutError";
  }
}

function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new GraphTimeoutError()),
      timeoutMs
    );
    promise.then(
      (val) => { clearTimeout(timer); resolve(val); },
      (err) => { clearTimeout(timer); reject(err); }
    );
  });
}

// ---------------------------------------------------------------------------
// Parameter validation helper
// ---------------------------------------------------------------------------

type ZodSchema = { parse: (data: unknown) => unknown; safeParse: (data: unknown) => { success: boolean; error?: unknown; data?: unknown } };

function validateParameters(
  args: unknown[],
  schema?: ZodSchema
): Record<string, unknown> {
  if (!schema) {
    return { args };
  }

  const result = schema.safeParse(args.length === 1 ? args[0] : args);
  if (!result.success) {
    throw new TypeError(`Parameter validation failed: ${JSON.stringify(result.error)}`);
  }
  return result.data as Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Hook types
// ---------------------------------------------------------------------------

export type StateHook = (ctx: GraphRunContextData, resultOrError: unknown) => void | Promise<void>;

async function callHooks(
  hooks: StateHook[],
  ctx: GraphRunContextData,
  resultOrError: unknown
): Promise<void> {
  for (const hook of hooks) {
    try {
      await hook(ctx, resultOrError);
    } catch (err) {
      console.warn(`[graphingest] State hook failed:`, err);
    }
  }
}

// ---------------------------------------------------------------------------
// @node options
// ---------------------------------------------------------------------------

export interface NodeOptions {
  name?: string;
  cacheTtl?: number;
  maxRetries?: number;
  tags?: string[];
  version?: string;
  /** Max execution time in seconds. Defaults to tier limit (Free: 5min, Pro: 10min, Enterprise: 60min). */
  timeoutSeconds?: number;
}

// ---------------------------------------------------------------------------
// Retry policy
// ---------------------------------------------------------------------------

export interface RetryPolicy {
  /** Total retry attempts (0 = no retries). */
  maxRetries: number;
  /** Initial delay in milliseconds between retries. */
  delayMs?: number;
  /** Multiplier applied to delay after each attempt (default 2). */
  backoffFactor?: number;
  /** Upper bound on the computed delay in ms (default 120_000). */
  maxDelayMs?: number;
  /** If true (default), adds random jitter (50%-150%) to avoid thundering herd. */
  jitter?: boolean;
}

function computeRetryDelay(policy: RetryPolicy, attempt: number): number {
  const base = policy.delayMs ?? 0;
  const factor = policy.backoffFactor ?? 2;
  const maxDelay = policy.maxDelayMs ?? 120_000;
  let delay = base * Math.pow(factor, attempt);
  delay = Math.min(delay, maxDelay);
  if (policy.jitter !== false) {
    delay = delay * (0.5 + Math.random()); // 50%-150% of delay
  }
  return delay;
}

// ---------------------------------------------------------------------------
// @graph options
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Flow control policies
// ---------------------------------------------------------------------------

export interface ConcurrencyPolicy {
  /** Maximum number of concurrent runs. 0 = unlimited. */
  limit: number;
  /** Optional parameter key for per-key concurrency (e.g. "userId"). */
  key?: string;
  /** Max seconds to wait for a slot. 0 = fail immediately. */
  waitTimeoutSeconds?: number;
  /** Seconds between slot re-checks (default 2). */
  pollIntervalSeconds?: number;
}

export interface ThrottlePolicy {
  /** Maximum number of runs allowed in the window. */
  limit: number;
  /** Sliding window size in seconds (default 60). */
  periodSeconds?: number;
}

export class FlowControlError extends Error {
  reason: string;
  details: Record<string, unknown>;
  constructor(reason: string, details: Record<string, unknown>) {
    super(`Flow control blocked: ${reason} — ${JSON.stringify(details)}`);
    this.name = "FlowControlError";
    this.reason = reason;
    this.details = details;
  }
}

export interface GraphOptions {
  name?: string;
  description?: string;
  version?: string;
  tags?: string[];
  /** @deprecated Use retryPolicy instead */
  retries?: number;
  /** @deprecated Use retryPolicy instead */
  retryDelayMs?: number;
  timeoutMs?: number;
  validateSchema?: ZodSchema;
  onCompletion?: StateHook[];
  onFailure?: StateHook[];
  onCancellation?: StateHook[];
  retryPolicy?: RetryPolicy;
  concurrency?: ConcurrencyPolicy;
  throttle?: ThrottlePolicy;
  priority?: number;
}

// ---------------------------------------------------------------------------
// NodeFuture: handle for async node execution
// ---------------------------------------------------------------------------

export class NodeFuture {
  private _taskRunId: string;
  private _nodeKey: string;
  private _client: GraphIngestClient;
  private _result: unknown = undefined;
  private _error: string | null = null;
  private _resolved = false;

  constructor(taskRunId: string, nodeKey: string, client: GraphIngestClient) {
    this._taskRunId = taskRunId;
    this._nodeKey = nodeKey;
    this._client = client;
  }

  get taskRunId(): string {
    return this._taskRunId;
  }

  /**
   * Block until the node completes and return its result.
   */
  async result(opts?: { pollIntervalMs?: number; timeoutMs?: number }): Promise<unknown> {
    if (this._resolved) {
      if (this._error) throw new Error(`Node ${this._nodeKey} failed: ${this._error}`);
      return this._result;
    }

    const pollInterval = opts?.pollIntervalMs ?? 1000;
    const timeout = opts?.timeoutMs;
    const start = performance.now();

    while (true) {
      const status = await this._client.pollTaskRuns([this._taskRunId]);
      const results = status.results;
      if (results.length > 0) {
        const r = results[0];
        if (r.state === "COMPLETED") {
          this._result = r.resultData;
          this._resolved = true;
          return this._result;
        }
        if (r.state === "FAILED") {
          this._error = r.errorMessage || "Unknown error";
          this._resolved = true;
          throw new Error(`Node ${this._nodeKey} failed: ${this._error}`);
        }
      }

      if (timeout && performance.now() - start > timeout) {
        throw new Error(`NodeFuture timed out after ${timeout}ms waiting for ${this._nodeKey}`);
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }
  }
}

// ---------------------------------------------------------------------------
// node()
// ---------------------------------------------------------------------------

/**
 * Wraps an async function as an Ingest graph node with full lifecycle management.
 *
 * Features:
 *   - NodeRunContext available via NodeRunContext.get()
 *   - Streaming logger POSTs logs to dashboard in real-time
 *   - Tags + version metadata
 *   - Automatic result serialization + reporting
 *
 * Usage:
 *   const extractData = node({ name: "extract-data", cacheTtl: 3600 },
 *     async (url: string) => {
 *       const res = await fetch(url);
 *       return res.json();
 *     }
 *   );
 */
export function node<TArgs extends unknown[], TResult>(
  options: NodeOptions,
  fn: (...args: TArgs) => Promise<TResult>
): (...args: TArgs) => Promise<TResult> {
  const nodeKey = options.name || fn.name || "anonymous";

  const wrapped = async (...args: TArgs): Promise<TResult> => {
    const client = getClient();
    const nodeRunId = process.env.NODE_RUN_ID || process.env.TASK_RUN_ID || "";
    const graphRunId = process.env.GRAPH_RUN_ID || process.env.FLOW_RUN_ID || "";

    const nodeCtx = {
      nodeRunId,
      nodeKey,
      graphRunId,
      retryCount: 0,
    };

    // Set up streaming logger
    let streamingLogger: StreamingLogger | null = null;
    if (graphRunId) {
      streamingLogger = new StreamingLogger({
        flowRunId: graphRunId,
        taskRunId: nodeRunId,
        client,
      });
    }

    const logs: LogEntry[] = [];
    const addLog = (level: string, message: string) => {
      const entry: LogEntry = {
        level,
        message,
        worker_id: process.env.WORKER_ID || "unknown",
        metadata: { timestamp: new Date().toISOString() },
      };
      logs.push(entry);
      streamingLogger?.log(level, message);
    };

    const nodeTimeout = clampTimeout(options.timeoutSeconds, "nodeDefaultTimeout", "nodeMaxTimeout");

    return NodeRunContext.runAsync(nodeCtx, async () => {
      const startTime = performance.now();
      addLog("INFO", `Starting node: ${nodeKey} (timeout=${nodeTimeout}s)`);

      try {
        const result = await withTimeout(fn(...args), nodeTimeout * 1000);
        const durationMs = Math.round(performance.now() - startTime);
        addLog("INFO", `Node ${nodeKey} completed in ${durationMs}ms`);

        let resultData: Record<string, unknown> | undefined;
        try {
          const serialized = JSON.stringify(result);
          if (serialized.length <= 65536) {
            resultData = JSON.parse(serialized);
          }
        } catch {
          // Non-serializable
        }

        try {
          await client.reportTaskCompleted({
            task_run_id: nodeRunId,
            flow_run_id: graphRunId,
            result_data: resultData,
            duration_ms: durationMs,
            logs,
          });
        } catch (reportErr) {
          console.error("Failed to report node completion:", reportErr);
        }

        return result;
      } catch (err) {
        if (err instanceof GraphTimeoutError) {
          throw new NodeTimeoutError(`Node ${nodeKey} timed out after ${nodeTimeout}s`);
        }
        const durationMs = Math.round(performance.now() - startTime);
        const errorMessage = err instanceof Error ? err.message : String(err);
        const errorTraceback = err instanceof Error ? err.stack || "" : "";
        addLog("ERROR", `Node ${nodeKey} failed: ${errorMessage}`);

        try {
          await client.reportTaskFailed({
            task_run_id: nodeRunId,
            flow_run_id: graphRunId,
            error_message: errorMessage,
            error_traceback: errorTraceback,
            logs,
          });
        } catch (reportErr) {
          console.error("Failed to report node failure:", reportErr);
        }

        throw err;
      } finally {
        streamingLogger?.close();
      }
    });
  };

  Object.defineProperty(wrapped, "_nodeKey", { value: nodeKey });
  Object.defineProperty(wrapped, "_cacheTtl", { value: options.cacheTtl });
  Object.defineProperty(wrapped, "_maxRetries", { value: options.maxRetries ?? 3 });
  Object.defineProperty(wrapped, "_tags", { value: options.tags ?? [] });
  Object.defineProperty(wrapped, "_version", { value: options.version });

  // ── .map() and .submit() ──

  const mapFn = async (
    items: unknown[],
    opts?: { pollIntervalMs?: number; timeoutMs?: number }
  ): Promise<unknown[]> => {
    const ctx = GraphRunContext.get();
    if (!ctx) throw new Error(".map() must be called from within a graph() function");

    const client = getClient();
    const { taskRunIds } = await client.dispatchNodes(ctx.graphRunId, nodeKey, items);
    console.log(`[graphingest] Mapped ${taskRunIds.length} invocations of node '${nodeKey}'`);

    const pollInterval = opts?.pollIntervalMs ?? 1000;
    const timeout = opts?.timeoutMs;
    const start = performance.now();

    // Poll until all complete
    let status: Awaited<ReturnType<typeof client.pollTaskRuns>>;
    while (true) {
      status = await client.pollTaskRuns(taskRunIds);
      if (status.allCompleted) break;
      if (timeout && performance.now() - start > timeout) {
        throw new Error(`.map() timed out after ${timeout}ms waiting for ${nodeKey}`);
      }
      await new Promise((r) => setTimeout(r, pollInterval));
    }

    // Collect results in dispatch order
    const byId = new Map(status.results.map((r) => [r.id, r]));
    return taskRunIds.map((id) => {
      const r = byId.get(id);
      if (r?.state === "FAILED") {
        throw new Error(`Node ${nodeKey} (mapped) failed: ${r.errorMessage}`);
      }
      return r?.resultData;
    });
  };

  const submitFn = async (inputData: unknown): Promise<NodeFuture> => {
    const ctx = GraphRunContext.get();
    if (!ctx) throw new Error(".submit() must be called from within a graph() function");

    const client = getClient();
    const { taskRunIds } = await client.dispatchNodes(ctx.graphRunId, nodeKey, [inputData]);
    console.log(`[graphingest] Submitted node '${nodeKey}' → ${taskRunIds[0]}`);
    return new NodeFuture(taskRunIds[0], nodeKey, client);
  };

  Object.defineProperty(wrapped, "map", { value: mapFn });
  Object.defineProperty(wrapped, "submit", { value: submitFn });

  return wrapped as ((...args: TArgs) => Promise<TResult>) & {
    map: typeof mapFn;
    submit: typeof submitFn;
  };
}

// ---------------------------------------------------------------------------
// graph()
// ---------------------------------------------------------------------------

/**
 * Wraps an async function as an Ingest graph entrypoint.
 *
 * Features:
 *   - Graph-level retries with configurable delay
 *   - Timeout enforcement
 *   - Parameter validation via Zod schema
 *   - GraphRunContext available via GraphRunContext.get()
 *   - Streaming logger POSTs logs to dashboard in real-time
 *   - State hooks: onCompletion, onFailure, onCancellation
 *   - Tags + version metadata
 *
 * Usage:
 *   const myPipeline = graph({
 *     name: "etl-pipeline",
 *     retries: 2,
 *     retryDelayMs: 5000,
 *     timeoutMs: 600_000,
 *     onFailure: [(ctx, err) => console.error("FAILED:", err)],
 *   }, async (source: string) => {
 *     const data = await extract(source);
 *     await load(data);
 *   });
 */
export function graph<TArgs extends unknown[], TResult>(
  options: GraphOptions,
  fn: (...args: TArgs) => Promise<TResult>
): (...args: TArgs) => Promise<TResult> {
  const graphName = options.name || fn.name || "anonymous";
  const graphDesc = options.description || undefined;
  const graphTimeout = clampTimeout(
    options.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : undefined,
    "graphDefaultTimeout",
    "graphMaxTimeout"
  );
  const timeoutMs = graphTimeout * 1000;
  const onCompletion = options.onCompletion ?? [];
  const onFailure = options.onFailure ?? [];
  const onCancellation = options.onCancellation ?? [];

  // Build effective retry config: retryPolicy takes priority over legacy args
  let effectivePolicy: RetryPolicy;
  if (options.retryPolicy) {
    effectivePolicy = options.retryPolicy;
  } else if ((options.retries ?? 0) > 0) {
    effectivePolicy = {
      maxRetries: options.retries!,
      delayMs: options.retryDelayMs ?? 0,
      backoffFactor: 1, // fixed delay for legacy
      jitter: false,
    };
  } else {
    effectivePolicy = { maxRetries: 0 };
  }
  const effectiveRetries = effectivePolicy.maxRetries;

  const wrapped = async (...args: TArgs): Promise<TResult> => {
    const client = getClient();

    // Detect parent graph context for subgraph nesting
    const parentCtx = GraphRunContext.get();
    let graphRunId: string;
    let parentGraphRunId: string | undefined;

    if (parentCtx) {
      // Subgraph: generate a new run ID, link to parent
      graphRunId = randomUUID();
      parentGraphRunId = parentCtx.graphRunId;
      console.log(`[graphingest] Subgraph '${graphName}' spawned from parent '${parentCtx.graphName}'`);
    } else {
      graphRunId = process.env.GRAPH_RUN_ID || process.env.FLOW_RUN_ID || randomUUID();
      parentGraphRunId = undefined;
    }

    // Validate parameters
    let validated: Record<string, unknown>;
    try {
      validated = validateParameters(args, options.validateSchema);
    } catch (err) {
      throw err;
    }

    // Flow control: acquire concurrency slot / check throttle
    const _concurrency = options.concurrency;
    const _throttle = options.throttle;
    const _priority = options.priority ?? 0;
    const hasFlowControl =
      (_concurrency && _concurrency.limit > 0) ||
      (_throttle && _throttle.limit > 0);

    if (hasFlowControl) {
      const concurrencyKey = _concurrency?.key
        ? String((validated as Record<string, unknown>)[_concurrency.key] ?? "")
        : "";

      const acquireOnce = async (): Promise<boolean> => {
        const res = await client.acquireFlowControl({
          graphName,
          graphRunId,
          concurrencyLimit: _concurrency?.limit ?? 0,
          concurrencyKey,
          throttleLimit: _throttle?.limit ?? 0,
          throttlePeriodSeconds: _throttle?.periodSeconds ?? 60,
          priority: _priority,
        });
        return !!res.acquired;
      };

      let acquired = await acquireOnce();
      if (!acquired && _concurrency?.waitTimeoutSeconds && _concurrency.waitTimeoutSeconds > 0) {
        const pollMs = (_concurrency.pollIntervalSeconds ?? 2) * 1000;
        const deadline = Date.now() + _concurrency.waitTimeoutSeconds * 1000;
        while (!acquired && Date.now() < deadline) {
          await new Promise((r) => setTimeout(r, pollMs));
          acquired = await acquireOnce();
        }
      }
      if (!acquired) {
        throw new FlowControlError("concurrency_or_throttle_limit", {
          graphName,
          graphRunId,
          concurrencyLimit: _concurrency?.limit,
          throttleLimit: _throttle?.limit,
        });
      }
      console.log(`[graphingest] Flow control: slot acquired for ${graphName} (run=${graphRunId})`);
    }

    const ctx: GraphRunContextData = {
      graphRunId,
      graphName,
      graphVersion: options.version,
      parameters: validated,
      tags: options.tags ?? [],
      parentGraphRunId,
    };

    // Set up streaming logger
    let streamingLogger: StreamingLogger | null = null;
    if (graphRunId) {
      streamingLogger = new StreamingLogger({
        flowRunId: graphRunId,
        client,
      });
    }

    const releaseSlot = async () => {
      if (hasFlowControl) {
        try {
          await client.releaseFlowControl(graphName, graphRunId);
        } catch (e) {
          console.warn(`[graphingest] Failed to release flow control slot:`, e);
        }
      }
    };

    return GraphRunContext.runAsync(ctx, async () => {
      streamingLogger?.info(`Starting graph: ${graphName} (run=${graphRunId})`);
      const startTime = performance.now();
      const attempts = 1 + effectiveRetries;
      let lastError: unknown = null;

      for (let attempt = 0; attempt < attempts; attempt++) {
        try {
          let result: TResult;

          if (timeoutMs) {
            result = await withTimeout(fn(...args), timeoutMs);
          } else {
            result = await fn(...args);
          }

          const duration = ((performance.now() - startTime) / 1000).toFixed(2);
          streamingLogger?.info(`Graph ${graphName} completed in ${duration}s`);
          streamingLogger?.close();
          await releaseSlot();

          await callHooks(onCompletion, ctx, result);
          return result;

        } catch (err) {
          lastError = err;

          if (err instanceof GraphTimeoutError) {
            streamingLogger?.error(`Graph ${graphName} timed out after ${timeoutMs}ms`);
            streamingLogger?.close();
            await releaseSlot();
            await callHooks(onCancellation, ctx, err);
            throw err;
          }

          if (attempt < effectiveRetries) {
            const delay = computeRetryDelay(effectivePolicy, attempt);
            const msg = err instanceof Error ? err.message : String(err);
            streamingLogger?.warning(
              `Graph ${graphName} attempt ${attempt + 1}/${attempts} failed: ${msg}. ` +
              `Retrying in ${delay.toFixed(0)}ms...`
            );
            if (delay > 0) {
              await new Promise((r) => setTimeout(r, delay));
            }
          } else {
            const duration = ((performance.now() - startTime) / 1000).toFixed(2);
            streamingLogger?.error(`Graph ${graphName} failed after ${duration}s`);
            streamingLogger?.close();
            await releaseSlot();
            await callHooks(onFailure, ctx, err);
            throw err;
          }
        }
      }

      // Unreachable, but satisfies TS
      await releaseSlot();
      throw lastError;
    });
  };

  Object.defineProperty(wrapped, "_graphName", { value: graphName });
  Object.defineProperty(wrapped, "_graphDescription", { value: graphDesc });
  Object.defineProperty(wrapped, "_graphVersion", { value: options.version });
  Object.defineProperty(wrapped, "_graphTags", { value: options.tags ?? [] });
  Object.defineProperty(wrapped, "_graphRetries", { value: effectiveRetries });
  Object.defineProperty(wrapped, "_graphTimeoutMs", { value: timeoutMs });

  return wrapped;
}
