"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.NodeFuture = exports.FlowControlError = exports.GraphTimeoutError = exports.NodeTimeoutError = exports.PLATFORM_LIMITS = void 0;
exports.node = node;
exports.graph = graph;
const node_crypto_1 = require("node:crypto");
const client_1 = require("./client");
const context_1 = require("./context");
const logger_1 = require("./logger");
let _client = null;
function getClient() {
    if (!_client) {
        _client = new client_1.GraphIngestClient();
    }
    return _client;
}
exports.PLATFORM_LIMITS = {
    free: {
        nodeDefaultTimeout: 300, // 5 min
        nodeMaxTimeout: 600, // 10 min
        graphDefaultTimeout: 900, // 15 min
        graphMaxTimeout: 1800, // 30 min
        monthlyExecutionMinutes: 60, // 60 min/mo total
        maxPipelines: 5,
    },
    pro: {
        nodeDefaultTimeout: 600, // 10 min
        nodeMaxTimeout: 3600, // 60 min
        graphDefaultTimeout: 3600, // 1 hr
        graphMaxTimeout: 21600, // 6 hr
        monthlyExecutionMinutes: 0, // unlimited
        maxPipelines: 0, // unlimited
    },
    enterprise: {
        nodeDefaultTimeout: 3600, // 60 min
        nodeMaxTimeout: 86400, // 24 hr
        graphDefaultTimeout: 21600, // 6 hr
        graphMaxTimeout: 86400, // 24 hr
        monthlyExecutionMinutes: 0, // unlimited
        maxPipelines: 0, // unlimited
    },
};
function getTier() {
    return (process.env.GRAPHINGEST_TIER || "free").toLowerCase();
}
function getLimits() {
    return exports.PLATFORM_LIMITS[getTier()] || exports.PLATFORM_LIMITS.free;
}
function clampTimeout(requested, defaultKey, maxKey) {
    const limits = getLimits();
    if (requested == null || requested <= 0)
        return limits[defaultKey];
    if (requested > limits[maxKey]) {
        console.warn(`[graphingest] Requested timeout ${requested}s exceeds ${getTier()} tier max (${limits[maxKey]}s). Clamped.`);
        return limits[maxKey];
    }
    return requested;
}
// ---------------------------------------------------------------------------
// Timeout helper
// ---------------------------------------------------------------------------
class NodeTimeoutError extends Error {
    constructor(message = "Node execution timed out") {
        super(message);
        this.name = "NodeTimeoutError";
    }
}
exports.NodeTimeoutError = NodeTimeoutError;
class GraphTimeoutError extends Error {
    constructor(message = "Graph execution timed out") {
        super(message);
        this.name = "GraphTimeoutError";
    }
}
exports.GraphTimeoutError = GraphTimeoutError;
function withTimeout(promise, timeoutMs) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new GraphTimeoutError()), timeoutMs);
        promise.then((val) => { clearTimeout(timer); resolve(val); }, (err) => { clearTimeout(timer); reject(err); });
    });
}
function validateParameters(args, schema) {
    if (!schema) {
        return { args };
    }
    const result = schema.safeParse(args.length === 1 ? args[0] : args);
    if (!result.success) {
        throw new TypeError(`Parameter validation failed: ${JSON.stringify(result.error)}`);
    }
    return result.data;
}
async function callHooks(hooks, ctx, resultOrError) {
    for (const hook of hooks) {
        try {
            await hook(ctx, resultOrError);
        }
        catch (err) {
            console.warn(`[graphingest] State hook failed:`, err);
        }
    }
}
function computeRetryDelay(policy, attempt) {
    const base = policy.delayMs ?? 0;
    const factor = policy.backoffFactor ?? 2;
    const maxDelay = policy.maxDelayMs ?? 120000;
    let delay = base * Math.pow(factor, attempt);
    delay = Math.min(delay, maxDelay);
    if (policy.jitter !== false) {
        delay = delay * (0.5 + Math.random()); // 50%-150% of delay
    }
    return delay;
}
class FlowControlError extends Error {
    constructor(reason, details) {
        super(`Flow control blocked: ${reason} — ${JSON.stringify(details)}`);
        this.name = "FlowControlError";
        this.reason = reason;
        this.details = details;
    }
}
exports.FlowControlError = FlowControlError;
// ---------------------------------------------------------------------------
// NodeFuture: handle for async node execution
// ---------------------------------------------------------------------------
class NodeFuture {
    constructor(taskRunId, nodeKey, client) {
        this._result = undefined;
        this._error = null;
        this._resolved = false;
        this._taskRunId = taskRunId;
        this._nodeKey = nodeKey;
        this._client = client;
    }
    get taskRunId() {
        return this._taskRunId;
    }
    /**
     * Block until the node completes and return its result.
     */
    async result(opts) {
        if (this._resolved) {
            if (this._error)
                throw new Error(`Node ${this._nodeKey} failed: ${this._error}`);
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
exports.NodeFuture = NodeFuture;
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
function node(options, fn) {
    const nodeKey = options.name || fn.name || "anonymous";
    const wrapped = async (...args) => {
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
        let streamingLogger = null;
        if (graphRunId) {
            streamingLogger = new logger_1.StreamingLogger({
                flowRunId: graphRunId,
                taskRunId: nodeRunId,
                client,
            });
        }
        const logs = [];
        const addLog = (level, message) => {
            const entry = {
                level,
                message,
                worker_id: process.env.WORKER_ID || "unknown",
                metadata: { timestamp: new Date().toISOString() },
            };
            logs.push(entry);
            streamingLogger?.log(level, message);
        };
        const nodeTimeout = clampTimeout(options.timeoutSeconds, "nodeDefaultTimeout", "nodeMaxTimeout");
        return context_1.NodeRunContext.runAsync(nodeCtx, async () => {
            const startTime = performance.now();
            addLog("INFO", `Starting node: ${nodeKey} (timeout=${nodeTimeout}s)`);
            try {
                const result = await withTimeout(fn(...args), nodeTimeout * 1000);
                const durationMs = Math.round(performance.now() - startTime);
                addLog("INFO", `Node ${nodeKey} completed in ${durationMs}ms`);
                let resultData;
                try {
                    const serialized = JSON.stringify(result);
                    if (serialized.length <= 65536) {
                        resultData = JSON.parse(serialized);
                    }
                }
                catch {
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
                }
                catch (reportErr) {
                    console.error("Failed to report node completion:", reportErr);
                }
                return result;
            }
            catch (err) {
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
                }
                catch (reportErr) {
                    console.error("Failed to report node failure:", reportErr);
                }
                throw err;
            }
            finally {
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
    const mapFn = async (items, opts) => {
        const ctx = context_1.GraphRunContext.get();
        if (!ctx)
            throw new Error(".map() must be called from within a graph() function");
        const client = getClient();
        const { taskRunIds } = await client.dispatchNodes(ctx.graphRunId, nodeKey, items);
        console.log(`[graphingest] Mapped ${taskRunIds.length} invocations of node '${nodeKey}'`);
        const pollInterval = opts?.pollIntervalMs ?? 1000;
        const timeout = opts?.timeoutMs;
        const start = performance.now();
        // Poll until all complete
        let status;
        while (true) {
            status = await client.pollTaskRuns(taskRunIds);
            if (status.allCompleted)
                break;
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
    const submitFn = async (inputData) => {
        const ctx = context_1.GraphRunContext.get();
        if (!ctx)
            throw new Error(".submit() must be called from within a graph() function");
        const client = getClient();
        const { taskRunIds } = await client.dispatchNodes(ctx.graphRunId, nodeKey, [inputData]);
        console.log(`[graphingest] Submitted node '${nodeKey}' → ${taskRunIds[0]}`);
        return new NodeFuture(taskRunIds[0], nodeKey, client);
    };
    Object.defineProperty(wrapped, "map", { value: mapFn });
    Object.defineProperty(wrapped, "submit", { value: submitFn });
    return wrapped;
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
function graph(options, fn) {
    const graphName = options.name || fn.name || "anonymous";
    const graphDesc = options.description || undefined;
    const graphTimeout = clampTimeout(options.timeoutMs ? Math.ceil(options.timeoutMs / 1000) : undefined, "graphDefaultTimeout", "graphMaxTimeout");
    const timeoutMs = graphTimeout * 1000;
    const onCompletion = options.onCompletion ?? [];
    const onFailure = options.onFailure ?? [];
    const onCancellation = options.onCancellation ?? [];
    // Build effective retry config: retryPolicy takes priority over legacy args
    let effectivePolicy;
    if (options.retryPolicy) {
        effectivePolicy = options.retryPolicy;
    }
    else if ((options.retries ?? 0) > 0) {
        effectivePolicy = {
            maxRetries: options.retries,
            delayMs: options.retryDelayMs ?? 0,
            backoffFactor: 1, // fixed delay for legacy
            jitter: false,
        };
    }
    else {
        effectivePolicy = { maxRetries: 0 };
    }
    const effectiveRetries = effectivePolicy.maxRetries;
    const wrapped = async (...args) => {
        const client = getClient();
        // Detect parent graph context for subgraph nesting
        const parentCtx = context_1.GraphRunContext.get();
        let graphRunId;
        let parentGraphRunId;
        if (parentCtx) {
            // Subgraph: generate a new run ID, link to parent
            graphRunId = (0, node_crypto_1.randomUUID)();
            parentGraphRunId = parentCtx.graphRunId;
            console.log(`[graphingest] Subgraph '${graphName}' spawned from parent '${parentCtx.graphName}'`);
        }
        else {
            graphRunId = process.env.GRAPH_RUN_ID || process.env.FLOW_RUN_ID || (0, node_crypto_1.randomUUID)();
            parentGraphRunId = undefined;
        }
        // Validate parameters
        let validated;
        try {
            validated = validateParameters(args, options.validateSchema);
        }
        catch (err) {
            throw err;
        }
        // Flow control: acquire concurrency slot / check throttle
        const _concurrency = options.concurrency;
        const _throttle = options.throttle;
        const _priority = options.priority ?? 0;
        const hasFlowControl = (_concurrency && _concurrency.limit > 0) ||
            (_throttle && _throttle.limit > 0);
        if (hasFlowControl) {
            const concurrencyKey = _concurrency?.key
                ? String(validated[_concurrency.key] ?? "")
                : "";
            const acquireOnce = async () => {
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
        const ctx = {
            graphRunId,
            graphName,
            graphVersion: options.version,
            parameters: validated,
            tags: options.tags ?? [],
            parentGraphRunId,
        };
        // Set up streaming logger
        let streamingLogger = null;
        if (graphRunId) {
            streamingLogger = new logger_1.StreamingLogger({
                flowRunId: graphRunId,
                client,
            });
        }
        const releaseSlot = async () => {
            if (hasFlowControl) {
                try {
                    await client.releaseFlowControl(graphName, graphRunId);
                }
                catch (e) {
                    console.warn(`[graphingest] Failed to release flow control slot:`, e);
                }
            }
        };
        return context_1.GraphRunContext.runAsync(ctx, async () => {
            streamingLogger?.info(`Starting graph: ${graphName} (run=${graphRunId})`);
            const startTime = performance.now();
            const attempts = 1 + effectiveRetries;
            let lastError = null;
            for (let attempt = 0; attempt < attempts; attempt++) {
                try {
                    let result;
                    if (timeoutMs) {
                        result = await withTimeout(fn(...args), timeoutMs);
                    }
                    else {
                        result = await fn(...args);
                    }
                    const duration = ((performance.now() - startTime) / 1000).toFixed(2);
                    streamingLogger?.info(`Graph ${graphName} completed in ${duration}s`);
                    streamingLogger?.close();
                    await releaseSlot();
                    await callHooks(onCompletion, ctx, result);
                    return result;
                }
                catch (err) {
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
                        streamingLogger?.warning(`Graph ${graphName} attempt ${attempt + 1}/${attempts} failed: ${msg}. ` +
                            `Retrying in ${delay.toFixed(0)}ms...`);
                        if (delay > 0) {
                            await new Promise((r) => setTimeout(r, delay));
                        }
                    }
                    else {
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
