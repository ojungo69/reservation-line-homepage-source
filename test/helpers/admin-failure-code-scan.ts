import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

// typescript@7 はネイティブ実装 (tsgo) で、createSourceFile などの JS compiler API を
// 同梱しない。この AST スキャナのためだけに TS6 を "typescript-ast" エイリアスで残す
// (コンパイル自体は typescript@7 の tsc を使う)。
import ts from "typescript-ast";

/**
 * Drift-guard scanner for the {@link ADMIN_API_FAILURE_CODES} union.
 *
 * Walks the three layers that admin endpoints return failure codes from and
 * collects the machine-readable codes that appear as string literals in the
 * reliably-detectable Result shapes:
 *
 *   - `{ ok: false, reason: "<code>" }`   (handler / Result-union returns)
 *   - `{ reason: "<code>" }`              (lone parser/validation results)
 *   - `{ error: "<code>" }`               (field-validation results)
 *
 * `reason` is only collected when the object is a failure result — it carries
 * `ok: false`, or it is a lone `{ reason }` object. That gate excludes
 * `reason` keys on unrelated objects (e.g. the audit `actor: { kind, …, reason:
 * "admin_cancel" }` descriptor), which are not API failure codes.
 *
 * Literals are unwrapped through `as` / `satisfies` / parentheses / `<T>`
 * assertions and through both branches of conditional expressions, so the
 * documented `reason: "x" satisfies AdminApiFailureCode` opt-in and ternaries
 * like `cond ? "unsupported_freq" : "invalid_rrule"` are covered.
 *
 * Only snake_case literals are collected. That filter intentionally excludes
 * free-form, user-facing `reason` strings (e.g. Japanese validation messages
 * whose Result type uses `reason: string`), which are not part of the admin
 * API failure-code contract.
 *
 * Codes that appear ONLY inside type aliases (e.g. `| "outside_business_hours"`)
 * or as bare string returns are out of scope — a literal scan cannot reliably
 * distinguish them from unrelated string-literal types. They remain covered by
 * the documented manual adoption workflow and the optional compile-time
 * `satisfies` / `Extract<AdminApiFailureCode, …>` enforcement.
 */

/** Which Result shape a code literal was found in. */
export type FailureCodeShape = "reason" | "error";

export type FailureCodeHit = {
  code: string;
  shape: FailureCodeShape;
  location: string;
};

/** Layers (relative to repo root) that may return admin API failure codes. */
const SCOPE_DIRS = ["src/admin"];
const SCOPE_FILES = ["src/routes/admin-api.ts", "src/routes/shared.ts"];

/** A machine-readable failure code is lower snake_case (no spaces / non-ASCII). */
const FAILURE_CODE_SHAPE = /^[a-z][a-z0-9_]*$/;

const listTsFiles = (dir: string, acc: string[]): string[] => {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) {
      listTsFiles(full, acc);
    } else if (name.endsWith(".ts") && !name.endsWith(".d.ts")) {
      acc.push(full);
    }
  }
  return acc;
};

/** Strip wrappers that don't change the literal value an expression resolves to. */
const unwrapExpression = (expr: ts.Expression): ts.Expression => {
  let current = expr;
  while (
    ts.isAsExpression(current) ||
    ts.isSatisfiesExpression(current) ||
    ts.isParenthesizedExpression(current) ||
    ts.isTypeAssertionExpression(current)
  ) {
    current = current.expression;
  }
  return current;
};

/** All string-literal values an expression can resolve to (incl. ternary branches). */
const collectStringLiterals = (expr: ts.Expression, into: string[] = []): string[] => {
  const node = unwrapExpression(expr);
  if (ts.isStringLiteral(node)) {
    into.push(node.text);
  } else if (ts.isConditionalExpression(node)) {
    collectStringLiterals(node.whenTrue, into);
    collectStringLiterals(node.whenFalse, into);
  }
  return into;
};

/** Unquoted name of an object-literal property (Identifier or string key), else null. */
const propertyName = (name: ts.PropertyName): string | null =>
  ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;

const propertyAssignments = (object: ts.ObjectLiteralExpression): ts.PropertyAssignment[] =>
  object.properties.filter(ts.isPropertyAssignment);

/** String-literal values of property `key` on an object literal (ternary-aware). */
const stringPropertyValues = (object: ts.ObjectLiteralExpression, key: string): string[] => {
  const values: string[] = [];
  for (const property of propertyAssignments(object)) {
    if (propertyName(property.name) !== key) continue;
    collectStringLiterals(property.initializer, values);
  }
  return values;
};

/** True when the object literal carries `ok: false` (optionally wrapped). */
const hasOkFalse = (object: ts.ObjectLiteralExpression): boolean =>
  propertyAssignments(object).some(
    (property) =>
      propertyName(property.name) === "ok" &&
      unwrapExpression(property.initializer).kind === ts.SyntaxKind.FalseKeyword
  );

/** True for a lone `{ reason: … }` object — the parser/validation failure shape. */
const isLoneReason = (object: ts.ObjectLiteralExpression): boolean => {
  const assignments = propertyAssignments(object);
  return assignments.length === 1 && propertyName(assignments[0].name) === "reason";
};

const collectFromFile = (root: string, file: string, hits: FailureCodeHit[]): void => {
  const source = ts.createSourceFile(
    file,
    readFileSync(file, "utf8"),
    ts.ScriptTarget.Latest,
    true
  );
  const relative = file.startsWith(root + "/") ? file.slice(root.length + 1) : file;

  const record = (code: string, shape: FailureCodeShape, node: ts.Node): void => {
    if (!FAILURE_CODE_SHAPE.test(code)) return;
    const { line } = source.getLineAndCharacterOfPosition(node.getStart());
    hits.push({ code, shape, location: `${relative}:${line + 1}` });
  };

  const visit = (node: ts.Node): void => {
    if (ts.isObjectLiteralExpression(node)) {
      // `reason` only counts on a failure result, never on unrelated objects
      // that happen to have a `reason` key (e.g. an audit actor descriptor).
      if (hasOkFalse(node) || isLoneReason(node)) {
        for (const code of stringPropertyValues(node, "reason")) record(code, "reason", node);
      }
      for (const code of stringPropertyValues(node, "error")) record(code, "error", node);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
};

/**
 * Collect every snake_case failure-code literal returned from the admin layers.
 * `root` defaults to the current working directory (the repo root under vitest).
 */
export const collectAdminFailureReasonCodes = (root: string = process.cwd()): FailureCodeHit[] => {
  const files: string[] = [];
  for (const dir of SCOPE_DIRS) listTsFiles(join(root, dir), files);
  for (const file of SCOPE_FILES) files.push(join(root, file));

  const hits: FailureCodeHit[] = [];
  for (const file of files) collectFromFile(root, file, hits);
  return hits;
};
