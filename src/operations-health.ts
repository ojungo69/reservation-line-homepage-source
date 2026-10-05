import { WorkerEntrypoint } from "cloudflare:workers";
import type { WorkerBindings } from "./bindings";
import { readOperationsHealth } from "./operations-health-query";

// Named entrypoints are reached through explicit Service bindings, not the
// default Worker fetch/route. The only output is a fixed allowlist of states.
export class OperationsHealth extends WorkerEntrypoint<WorkerBindings> {
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method !== "GET" || url.pathname !== "/job-health" || url.search) {
      return new Response(null, { status: 404 });
    }
    const headers = { "Cache-Control": "no-store" };
    try {
      const states = await readOperationsHealth(this.env.DB, this.env);
      const sources = [
        ...(states.calendar ? ["calendar"] : []),
        ...(states.import ? ["google_import"] : []),
        ...(states.notification ? ["notification"] : [])
      ];
      return Response.json(
        { status: sources.length ? "stalled" : "ok", sources },
        { status: sources.length ? 503 : 200, headers }
      );
    } catch {
      return Response.json({ status: "unknown", sources: [] }, { status: 503, headers });
    }
  }
}
