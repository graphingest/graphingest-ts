"use strict";
/**
 * Streaming Run Logger
 *
 * Buffers log entries and flushes them to the control plane via
 * POST /api/runs/{flowRunId}/logs for real-time dashboard streaming.
 */
Object.defineProperty(exports, "__esModule", { value: true });
exports.StreamingLogger = void 0;
exports.getRunLogger = getRunLogger;
const client_1 = require("./client");
class StreamingLogger {
    constructor(options) {
        this.buffer = [];
        this.timer = null;
        this.flowRunId = options.flowRunId;
        this.taskRunId = options.taskRunId;
        this.client = options.client ?? new client_1.GraphIngestClient();
        this.bufferSize = options.bufferSize ?? 20;
        this.flushIntervalMs = options.flushIntervalMs ?? 2000;
        this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
    }
    log(level, message, metadata) {
        this.buffer.push({
            level,
            message,
            worker_id: process.env.WORKER_ID ?? "sdk",
            metadata: {
                ...metadata,
                task_run_id: this.taskRunId,
                timestamp: new Date().toISOString(),
            },
        });
        if (this.buffer.length >= this.bufferSize) {
            this.flush();
        }
    }
    debug(message, metadata) {
        this.log("DEBUG", message, metadata);
    }
    info(message, metadata) {
        this.log("INFO", message, metadata);
    }
    warning(message, metadata) {
        this.log("WARNING", message, metadata);
    }
    error(message, metadata) {
        this.log("ERROR", message, metadata);
    }
    flush() {
        if (this.buffer.length === 0)
            return;
        const batch = [...this.buffer];
        this.buffer = [];
        this.client.sendLogs(this.flowRunId, batch).catch(() => {
            // Silently drop on failure — don't block execution
        });
    }
    close() {
        if (this.timer) {
            clearInterval(this.timer);
            this.timer = null;
        }
        this.flush();
    }
    /** Get buffered records (for batch reporting alongside task completion). */
    getBuffered() {
        return [...this.buffer];
    }
}
exports.StreamingLogger = StreamingLogger;
/**
 * Get a streaming logger bound to the current flow/task run context.
 *
 * Usage:
 *   import { getRunLogger } from "@ingest/sdk";
 *   const logger = getRunLogger();
 *   logger.info("Processing started");
 */
function getRunLogger(flowRunId, taskRunId) {
    // Try to resolve from context if not provided
    if (!flowRunId) {
        // Lazy import to avoid circular dependency
        const { GraphRunContext } = require("./context");
        const ctx = GraphRunContext.get();
        if (ctx)
            flowRunId = ctx.graphRunId;
    }
    if (!taskRunId) {
        const { NodeRunContext } = require("./context");
        const tctx = NodeRunContext.get();
        if (tctx)
            taskRunId = tctx.nodeRunId;
    }
    if (!flowRunId) {
        throw new Error("Cannot create run logger: no flowRunId provided and no active GraphRunContext.");
    }
    return new StreamingLogger({ flowRunId, taskRunId });
}
