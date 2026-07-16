/**
 * Problem: PDF Report Generation Takes Too Long
 *
 * Users click "Generate Report" and wait 3 minutes with a spinner.
 * Close the tab = report lost. Server restart = start over.
 *
 * Solution: Dispatch as background job, return job ID instantly,
 * frontend polls for status.
 *
 * Run: npx tsx pdf_report.ts
 */

import { node, graph, deploy } from "graphingest";

const queryDatabase = node(
  { name: "query-database", cacheTtl: 300, maxRetries: 2 },
  async (params: { type: string; dateRange: string }) => {
    // In production: run SQL queries
    return { reportType: params.type, rows: 15000, dateRange: params.dateRange };
  }
);

const generateCharts = node(
  { name: "generate-charts", maxRetries: 2 },
  async (data: { reportType: string; rows: number }) => {
    return {
      charts: [
        { type: "bar", title: "Revenue by Month" },
        { type: "line", title: "User Growth" },
      ],
      rowsProcessed: data.rows,
    };
  }
);

const renderPdf = node({ name: "render-pdf" },
  async (charts: { charts: any[]; rowsProcessed: number }) => ({
    url: "https://storage.example.com/reports/quarterly-2025.pdf",
    pages: 24,
    chartsIncluded: charts.charts.length,
  })
);

const generateReport = graph({
  name: "generate-report",
  retryPolicy: { maxRetries: 2, delayMs: 5000 },
  timeoutMs: 600_000,
}, async (params: { type: string; dateRange: string }) => {
  const data = await queryDatabase(params);
  const charts = await generateCharts(data);
  return await renderPdf(charts);
});

await deploy();

// Dispatch and get job ID (what your API endpoint does)
const future = await (generateReport as any).arun({ type: "quarterly", dateRange: "Q3_2025" });
console.log(`Report dispatched! Job ID: ${future.taskRunId}`);

// Poll for result (what your frontend does via your backend)
const result = await future.result({ timeoutMs: 120_000 });
console.log(`Download: ${result.url} (${result.pages} pages)`);
