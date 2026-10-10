/**
 * GraphIngest Orchestrator TypeScript Client
 *
 * Communicates with the GraphIngest control plane (Next.js API routes)
 * to trigger flows, dispatch nodes, stream logs, and store artifacts.
 *
 * Authentication
 * --------------
 * All public endpoints require a per-user API key generated from the
 * dashboard (Settings → API Keys). Provide it via the constructor or set
 * `GRAPHINGEST_API_KEY` in the environment.
 *
 * The `reportTaskCompleted` / `reportTaskFailed` methods talk to the
 * worker-callback endpoint, which is authenticated with a separate
 * `WORKER_CALLBACK_SECRET` known only to the Cloud Run worker. They are
 * exposed for in-cluster use cases (custom worker images) but will fail
 * with 401/403 when called with an SDK key.
 */
export interface LogEntry {
    level?: string;
    message: string;
    task_run_id?: string;
    worker_id?: string;
    metadata?: Record<string, unknown>;
}
export interface ArtifactInput {
    key: string;
    type?: "markdown" | "table" | "plotly" | "image" | "json" | "link";
    data?: unknown;
    description?: string;
    storage_url?: string;
}
export interface TaskCompletedPayload {
    task_run_id: string;
    flow_run_id: string;
    result_url?: string;
    result_data?: Record<string, unknown>;
    duration_ms?: number;
    logs?: LogEntry[];
    artifacts?: ArtifactInput[];
}
export interface TaskFailedPayload {
    task_run_id: string;
    flow_run_id: string;
    error_message: string;
    error_traceback?: string;
    logs?: LogEntry[];
}
export declare class MissingAPIKeyError extends Error {
    constructor(message?: string);
}
export declare class GraphIngestClient {
    private baseUrl;
    private apiKey;
    constructor(options?: {
        baseUrl?: string;
        apiKey?: string;
    });
    private request;
    reportTaskCompleted(payload: TaskCompletedPayload): Promise<unknown>;
    reportTaskFailed(payload: TaskFailedPayload): Promise<unknown>;
    sendLogs(flowRunId: string, logs: LogEntry[]): Promise<unknown>;
    createArtifact(flowRunId: string, artifact: ArtifactInput & {
        task_run_id?: string;
    }): Promise<unknown>;
    triggerFlowRun(flowId: string, parameters?: Record<string, unknown>): Promise<unknown>;
    dispatchNodes(graphRunId: string, nodeKey: string, inputs: unknown[]): Promise<{
        taskRunIds: string[];
        barrierKey?: string;
        count: number;
    }>;
    pollTaskRuns(taskRunIds: string[]): Promise<{
        results: Array<{
            id: string;
            state: string;
            resultData: unknown;
            resultUrl: string | null;
            errorMessage: string | null;
            mapIndex: number | null;
        }>;
        allCompleted: boolean;
    }>;
    acquireFlowControl(opts: {
        graphName: string;
        graphRunId: string;
        concurrencyLimit?: number;
        concurrencyKey?: string;
        throttleLimit?: number;
        throttlePeriodSeconds?: number;
        priority?: number;
    }): Promise<{
        acquired: boolean;
        reason?: string;
        [key: string]: unknown;
    }>;
    releaseFlowControl(graphName: string, graphRunId: string): Promise<{
        released: boolean;
    }>;
    /**
     * SHA-256 of the canonical JSON form of `{taskKey, inputData}` with sorted
     * object keys. This matches `src/lib/orchestrator/cache.ts` on the server
     * and `compute_input_hash` in the Python SDK so that cache hits are
     * portable across runtimes.
     */
    static computeInputHash(taskKey: string, inputData: unknown): string;
    /** Browser-friendly variant using Web Crypto. Returns a Promise<string>. */
    static computeInputHashAsync(taskKey: string, inputData: unknown): Promise<string>;
}
