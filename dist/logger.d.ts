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
export declare class StreamingLogger {
    private flowRunId;
    private taskRunId?;
    private client;
    private bufferSize;
    private flushIntervalMs;
    private buffer;
    private timer;
    constructor(options: StreamingLoggerOptions);
    log(level: string, message: string, metadata?: Record<string, unknown>): void;
    debug(message: string, metadata?: Record<string, unknown>): void;
    info(message: string, metadata?: Record<string, unknown>): void;
    warning(message: string, metadata?: Record<string, unknown>): void;
    error(message: string, metadata?: Record<string, unknown>): void;
    flush(): void;
    close(): void;
    /** Get buffered records (for batch reporting alongside task completion). */
    getBuffered(): LogEntry[];
}
/**
 * Get a streaming logger bound to the current flow/task run context.
 *
 * Usage:
 *   import { getRunLogger } from "@ingest/sdk";
 *   const logger = getRunLogger();
 *   logger.info("Processing started");
 */
export declare function getRunLogger(flowRunId?: string, taskRunId?: string): StreamingLogger;
