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
import { GraphIngestClient } from "./client";
import { GraphRunContextData } from "./context";
export interface TierLimits {
    nodeDefaultTimeout: number;
    nodeMaxTimeout: number;
    graphDefaultTimeout: number;
    graphMaxTimeout: number;
    monthlyExecutionMinutes: number;
    maxPipelines: number;
}
export declare const PLATFORM_LIMITS: Record<string, TierLimits>;
export declare class NodeTimeoutError extends Error {
    constructor(message?: string);
}
export declare class GraphTimeoutError extends Error {
    constructor(message?: string);
}
type ZodSchema = {
    parse: (data: unknown) => unknown;
    safeParse: (data: unknown) => {
        success: boolean;
        error?: unknown;
        data?: unknown;
    };
};
export type StateHook = (ctx: GraphRunContextData, resultOrError: unknown) => void | Promise<void>;
export interface NodeOptions {
    name?: string;
    cacheTtl?: number;
    maxRetries?: number;
    tags?: string[];
    version?: string;
    /** Max execution time in seconds. Defaults to tier limit (Free: 5min, Pro: 10min, Enterprise: 60min). */
    timeoutSeconds?: number;
}
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
export declare class FlowControlError extends Error {
    reason: string;
    details: Record<string, unknown>;
    constructor(reason: string, details: Record<string, unknown>);
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
export declare class NodeFuture {
    private _taskRunId;
    private _nodeKey;
    private _client;
    private _result;
    private _error;
    private _resolved;
    constructor(taskRunId: string, nodeKey: string, client: GraphIngestClient);
    get taskRunId(): string;
    /**
     * Block until the node completes and return its result.
     */
    result(opts?: {
        pollIntervalMs?: number;
        timeoutMs?: number;
    }): Promise<unknown>;
}
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
export declare function node<TArgs extends unknown[], TResult>(options: NodeOptions, fn: (...args: TArgs) => Promise<TResult>): (...args: TArgs) => Promise<TResult>;
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
export declare function graph<TArgs extends unknown[], TResult>(options: GraphOptions, fn: (...args: TArgs) => Promise<TResult>): (...args: TArgs) => Promise<TResult>;
export {};
