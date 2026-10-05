import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

import { createApp } from "../src/app";

/**
 * Drift guard: docs/admin-authz-matrix.md must list every registered
 * `/api/admin/*` route (and no ghosts). Source of truth for "what exists"
 * is Hono's runtime route table from createApp() — not a regex over source
 * text, because admin-api.ts registers four reservation actions in a for-loop
 * that a static scan would under-count.
 */

/** Backtick cells shaped like `METHOD /api/admin/...` (one method per cell). */
const DOC_ENDPOINT_RE =
  /`(GET|POST|PUT|PATCH|DELETE)\s+(\/api\/admin[^\s?`]*)(?:\?[^`\s]*)?[^`]*`/g;

function collectSourceAdminEndpoints(): Set<string> {
  const app = createApp();
  const endpoints = new Set<string>();
  for (const route of app.routes) {
    // Middleware registers as method="ALL"; real handlers are GET/POST/etc.
    if (route.method === "ALL") continue;
    if (!route.path.startsWith("/api/admin")) continue;
    endpoints.add(`${route.method} ${route.path}`);
  }
  return endpoints;
}

function collectDocAdminEndpoints(markdown: string): Set<string> {
  const endpoints = new Set<string>();
  // Endpoint-table rows only: start with `|` and have enough pipe separators for
  // a matrix row (`| Endpoint | staff | owner | system_admin | guard |` = 6).
  // Scanning whole-file backticks would still pass if an endpoint moved from the
  // table into prose.
  const MIN_ENDPOINT_ROW_PIPES = 6;
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|")) continue;
    let pipeCount = 0;
    for (let i = 0; i < line.length; i += 1) {
      if (line.charCodeAt(i) === 124 /* | */) pipeCount += 1;
    }
    if (pipeCount < MIN_ENDPOINT_ROW_PIPES) continue;

    DOC_ENDPOINT_RE.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = DOC_ENDPOINT_RE.exec(line)) !== null) {
      endpoints.add(`${match[1]} ${match[2]}`);
    }
  }
  return endpoints;
}

function sortedDiff(from: Set<string>, against: Set<string>): string[] {
  return [...from].filter((item) => !against.has(item)).sort();
}

describe("admin-authz-matrix sync", () => {
  it("documents every /api/admin route registered by createApp(), and no ghosts", () => {
    const source = collectSourceAdminEndpoints();
    const markdown = readFileSync(
      resolve(process.cwd(), "docs/admin-authz-matrix.md"),
      "utf8"
    );
    const doc = collectDocAdminEndpoints(markdown);

    // Fail closed if the parser picks up nothing (notation drift would otherwise go green).
    expect(
      doc.size,
      "docs/admin-authz-matrix.md yielded 0 endpoint cells. " +
        "Parser expects backtick cells like `METHOD /api/admin/...`."
    ).toBeGreaterThan(0);

    const missingInDoc = sortedDiff(source, doc);
    const ghostsInDoc = sortedDiff(doc, source);

    const lines: string[] = [];
    if (missingInDoc.length > 0) {
      lines.push(
        `Source routes missing from docs/admin-authz-matrix.md (${missingInDoc.length}):`,
        ...missingInDoc.map((e) => `  - ${e}`)
      );
    }
    if (ghostsInDoc.length > 0) {
      lines.push(
        `Doc endpoints with no registered route (${ghostsInDoc.length}):`,
        ...ghostsInDoc.map((e) => `  - ${e}`)
      );
    }

    expect(
      { missingInDoc, ghostsInDoc },
      lines.length === 0
        ? ""
        : `admin-authz-matrix is out of sync with createApp() routes.\n${lines.join("\n")}`
    ).toEqual({ missingInDoc: [], ghostsInDoc: [] });
  });
});
