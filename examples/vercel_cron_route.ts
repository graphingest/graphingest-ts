/**
 * Vercel cron entrypoint.
 *
 * Hobby functions stop at 10s. Pro stops at 60s. This route does neither:
 * it asks GraphIngest to start the pipeline and returns immediately.
 * The pipeline itself lives in vercel_cron_timeout.ts and can run for hours.
 *
 * Drop this file in at app/api/cron/sync/route.ts.
 *
 * vercel.json:
 *   { "crons": [{ "path": "/api/cron/sync", "schedule": "0 3 * * *" }] }
 *
 * Env:
 *   GRAPHINGEST_API_KEY   — Settings → API Keys
 *   GRAPHINGEST_FLOW_ID   — flow id from the dashboard after deploy()
 *   CRON_SECRET            — optional; Vercel sends Authorization: Bearer <secret>
 */

import { GraphIngestClient } from "graphingest";

export async function GET(request: Request) {
  const secret = process.env.CRON_SECRET;
  if (secret && request.headers.get("authorization") !== `Bearer ${secret}`) {
    return new Response("Unauthorized", { status: 401 });
  }

  const flowId = process.env.GRAPHINGEST_FLOW_ID;
  if (!flowId) {
    return Response.json({ error: "GRAPHINGEST_FLOW_ID is not set" }, { status: 500 });
  }

  const client = new GraphIngestClient();
  const res = await client.triggerFlowRun(flowId, {
    sources: [
      { name: "users", apiUrl: "https://jsonplaceholder.typicode.com/users" },
      { name: "posts", apiUrl: "https://jsonplaceholder.typicode.com/posts" },
    ],
  });

  const runId = (res as { data?: { id?: string } }).data?.id ?? null;
  return Response.json({ runId, status: "dispatched" });
}
