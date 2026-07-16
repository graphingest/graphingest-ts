/**
 * Streaming Run Logger
 *
 * Buffers log entries and flushes them to the control plane via
 * POST /api/runs/{flowRunId}/logs for real-time dashboard streaming.
 */

import { GraphIngestClient, LogEntry } from "./client";

export interface StreamingLoggerOptions {
  flowRunId: string;
  taskRunId?: string;
  client?: GraphIngestClient;
  bufferSize?: number;
  flushIntervalMs?: number;
}

export class StreamingLogger {
  private flowRunId: string;
  private taskRunId?: string;
  private client: GraphIngestClient;
  private bufferSize: number;
  private flushIntervalMs: number;
  private buffer: LogEntry[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: StreamingLoggerOptions) {
    this.flowRunId = options.flowRunId;
    this.taskRunId = options.taskRunId;
    this.client = options.client ?? new GraphIngestClient();
    this.bufferSize = options.bufferSize ?? 20;
    this.flushIntervalMs = options.flushIntervalMs ?? 2000;

    this.timer = setInterval(() => this.flush(), this.flushIntervalMs);
  }

  log(level: string, message: string, metadata?: Record<string, unknown>): void {
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

  debug(message: string, metadata?: Record<string, unknown>): void {
    this.log("DEBUG", message, metadata);
  }

  info(message: string, metadata?: Record<string, unknown>): void {
    this.log("INFO", message, metadata);
  }

  warning(message: string, metadata?: Record<string, unknown>): void {
    this.log("WARNING", message, metadata);
  }

  error(message: string, metadata?: Record<string, unknown>): void {
    this.log("ERROR", message, metadata);
  }

  flush(): void {
    if (this.buffer.length === 0) return;

    const batch = [...this.buffer];
    this.buffer = [];

    this.client.sendLogs(this.flowRunId, batch).catch(() => {
      // Silently drop on failure — don't block execution
    });
  }

  close(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.flush();
  }

  /** Get buffered records (for batch reporting alongside task completion). */
  getBuffered(): LogEntry[] {
    return [...this.buffer];
  }
}

/**
 * Get a streaming logger bound to the current flow/task run context.
 *
 * Usage:
 *   import { getRunLogger } from "@ingest/sdk";
 *   const logger = getRunLogger();
 *   logger.info("Processing started");
 */
export function getRunLogger(
  flowRunId?: string,
  taskRunId?: string
): StreamingLogger {
  // Try to resolve from context if not provided
  if (!flowRunId) {
    // Lazy import to avoid circular dependency
    const { GraphRunContext } = require("./context");
    const ctx = GraphRunContext.get();
    if (ctx) flowRunId = ctx.graphRunId;
  }

  if (!taskRunId) {
    const { NodeRunContext } = require("./context");
    const tctx = NodeRunContext.get();
    if (tctx) taskRunId = tctx.nodeRunId;
  }

  if (!flowRunId) {
    throw new Error(
      "Cannot create run logger: no flowRunId provided and no active GraphRunContext."
    );
  }

  return new StreamingLogger({ flowRunId, taskRunId });
}
