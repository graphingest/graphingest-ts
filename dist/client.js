"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.GraphIngestClient = exports.MissingAPIKeyError = void 0;
const node_crypto_1 = require("node:crypto");
class MissingAPIKeyError extends Error {
    constructor(message) {
        super(message ??
            "GraphIngestClient requires an apiKey. Generate one in the dashboard under Settings → API Keys, then set GRAPHINGEST_API_KEY.");
        this.name = "MissingAPIKeyError";
    }
}
exports.MissingAPIKeyError = MissingAPIKeyError;
class GraphIngestClient {
    constructor(options) {
        this.baseUrl = (options?.baseUrl ||
            process.env.GRAPHINGEST_API_URL ||
            process.env.INGEST_API_URL ||
            "").replace(/\/$/, "");
        this.apiKey =
            options?.apiKey ||
                process.env.GRAPHINGEST_API_KEY ||
                process.env.INGEST_API_KEY ||
                "";
        if (!this.baseUrl) {
            throw new Error("GraphIngestClient requires baseUrl or GRAPHINGEST_API_URL");
        }
        if (!this.apiKey) {
            throw new MissingAPIKeyError();
        }
    }
    async request(path, method = "GET", body) {
        const res = await fetch(`${this.baseUrl}${path}`, {
            method,
            headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${this.apiKey}`,
            },
            body: body ? JSON.stringify(body) : undefined,
        });
        if (!res.ok) {
            const text = await res.text().catch(() => "");
            throw new Error(`GraphIngest API error ${res.status}: ${text}`);
        }
        return res.json();
    }
    // ── Worker-internal (not for SDK users) ───────────────────────
    async reportTaskCompleted(payload) {
        return this.request("/api/webhook/worker-callback", "POST", {
            ...payload,
            status: "COMPLETED",
        });
    }
    async reportTaskFailed(payload) {
        return this.request("/api/webhook/worker-callback", "POST", {
            ...payload,
            status: "FAILED",
        });
    }
    // ── User-facing SDK API ───────────────────────────────────────
    async sendLogs(flowRunId, logs) {
        if (!logs.length)
            return { data: [] };
        return this.request(`/api/runs/${flowRunId}/logs`, "POST", logs);
    }
    async createArtifact(flowRunId, artifact) {
        return this.request(`/api/runs/${flowRunId}/artifacts`, "POST", artifact);
    }
    async triggerFlowRun(flowId, parameters) {
        return this.request(`/api/flows/${flowId}/runs`, "POST", {
            parameters: parameters || {},
        });
    }
    async dispatchNodes(graphRunId, nodeKey, inputs) {
        return this.request("/api/nodes/dispatch", "POST", {
            graphRunId,
            nodeKey,
            inputs,
        });
    }
    async pollTaskRuns(taskRunIds) {
        return this.request("/api/nodes/status", "POST", { taskRunIds });
    }
    // ── Flow Control ──────────────────────────────────────────────
    async acquireFlowControl(opts) {
        return this.request("/api/flow-control", "POST", {
            action: "acquire",
            graphName: opts.graphName,
            graphRunId: opts.graphRunId,
            concurrencyLimit: opts.concurrencyLimit ?? 0,
            concurrencyKey: opts.concurrencyKey ?? "",
            throttleLimit: opts.throttleLimit ?? 0,
            throttlePeriodSeconds: opts.throttlePeriodSeconds ?? 0,
            priority: opts.priority ?? 0,
        });
    }
    async releaseFlowControl(graphName, graphRunId) {
        return this.request("/api/flow-control", "POST", {
            action: "release",
            graphName,
            graphRunId,
        });
    }
    // ── Hashing (must match server canonicalisation) ──────────────
    /**
     * SHA-256 of the canonical JSON form of `{taskKey, inputData}` with sorted
     * object keys. This matches `src/lib/orchestrator/cache.ts` on the server
     * and `compute_input_hash` in the Python SDK so that cache hits are
     * portable across runtimes.
     */
    static computeInputHash(taskKey, inputData) {
        const canonical = canonicalJSONStringify({ taskKey, inputData });
        // Prefer Node's crypto (sync, available everywhere we run the SDK).
        if (typeof node_crypto_1.createHash === "function") {
            return (0, node_crypto_1.createHash)("sha256").update(canonical, "utf8").digest("hex");
        }
        throw new Error("computeInputHash requires Node's crypto module. Use computeInputHashAsync in the browser.");
    }
    /** Browser-friendly variant using Web Crypto. Returns a Promise<string>. */
    static async computeInputHashAsync(taskKey, inputData) {
        const canonical = canonicalJSONStringify({ taskKey, inputData });
        const subtle = (globalThis.crypto && globalThis.crypto.subtle) || node_crypto_1.webcrypto.subtle;
        const buf = await subtle.digest("SHA-256", new TextEncoder().encode(canonical));
        return Array.from(new Uint8Array(buf))
            .map((b) => b.toString(16).padStart(2, "0"))
            .join("");
    }
}
exports.GraphIngestClient = GraphIngestClient;
/**
 * Deterministic JSON serializer:
 *   • object keys sorted lexicographically
 *   • arrays preserve order
 *   • undefined / functions stripped (mirrors JSON.stringify default)
 *   • non-finite numbers throw — same behaviour as Python's allow_nan=False.
 */
function canonicalJSONStringify(value) {
    const stringify = (v) => {
        if (v === null)
            return "null";
        const t = typeof v;
        if (t === "number") {
            if (!Number.isFinite(v)) {
                throw new TypeError("Cannot serialize non-finite number for hashing");
            }
            return JSON.stringify(v);
        }
        if (t === "string" || t === "boolean")
            return JSON.stringify(v);
        if (t === "bigint")
            return JSON.stringify(v.toString());
        if (Array.isArray(v)) {
            return "[" + v.map((x) => stringify(x ?? null)).join(",") + "]";
        }
        if (t === "object") {
            const entries = Object.entries(v)
                .filter(([, val]) => val !== undefined && typeof val !== "function")
                .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
            return ("{" +
                entries
                    .map(([k, val]) => JSON.stringify(k) + ":" + stringify(val))
                    .join(",") +
                "}");
        }
        // undefined / function — drop
        return "null";
    };
    return stringify(value);
}
