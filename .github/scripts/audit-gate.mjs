#!/usr/bin/env node
// Dependency audit gate: fails on every high/critical npm advisory except an
// entry in ALLOWED_ADVISORIES whose advisory ID, package, audit target and
// severity all match and whose expiry date has not been reached. It replaces a
// blanket `npm audit --audit-level=high`, which cannot tolerate an advisory
// that has no patched release.
//
// Everything fails closed: a report npm could not produce, a report whose
// records are inconsistent or disagree with its own summary counts, an expired
// or unused entry, and any npm exit status other than "audit completed".
//
// Adding or extending an entry needs the owner's approval. Every entry needs a
// reason and an expiry date, and an entry the audit no longer needs fails the
// gate so it gets deleted instead of lingering.
//
// It audits the committed lockfiles against the registry. It cannot defend
// against code that runs before it in the same job, such as a dependency bin
// on the `npm run` PATH, an npm lifecycle hook or an edit to this file; code
// review covers those, as it did for the blanket audit.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// GHSA-fc5q-39xc-vjpf (picomatch) was withdrawn on 2026-11-18 and no longer
// appears in either audit, so its entry was deleted as the rule above requires.
export const ALLOWED_ADVISORIES = Object.freeze([]);

const TARGETS = Object.freeze(['root', 'admin-app']);
const SEVERITY_RANK = Object.freeze({ info: 0, low: 1, moderate: 2, high: 3, critical: 4 });
const BLOCKING = new Set(['high', 'critical']);
const ENTRY_FIELDS = new Set(['id', 'package', 'targets', 'maxSeverity', 'expires', 'reason']);
const GHSA = /^GHSA(-[23456789cfghjmpqrvwx]{4}){3}$/;
const PACKAGE = /^(@[a-z0-9-~][a-z0-9-._~]*\/)?[a-z0-9-~][a-z0-9-._~]*$/;
const DATE = /^\d{4}-\d{2}-\d{2}$/;
// `npm audit` exits 0 when it found nothing and 1 when it found something;
// any other status means the audit itself did not complete.
const NPM_AUDIT_RAN = new Set([0, 1]);
const USAGE = 'usage: node .github/scripts/audit-gate.mjs root|admin-app';

// The audited repository is the one that holds this file, whatever the caller's cwd.
const REPOSITORY_ROOT = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');

const isRecord = value => typeof value === 'object' && value !== null && !Array.isArray(value);
// typeof first: ['critical'] would coerce to the key 'critical' in Object.hasOwn but never
// match a Set lookup, so a non-string severity could hide an advisory.
const isSeverity = value => typeof value === 'string' && Object.hasOwn(SEVERITY_RANK, value);
const isCalendarDate = value => {
  if (typeof value !== 'string' || !DATE.test(value)) return false;
  const [year, month, day] = value.split('-').map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
};
const advisoryId = url => (typeof url === 'string' ? url.split('/').pop() : '');

function assertTarget(target) {
  if (!TARGETS.includes(target)) throw new Error(USAGE);
}

export function auditArguments(target, cache) {
  assertTarget(target);
  if (typeof cache !== 'string' || !isAbsolute(cache)) throw new Error('npm audit needs an absolute cache directory');
  // Command-line flags outrank every .npmrc layer. Each one below overrides a
  // setting measured (npm 12.2.2) to empty or swap the audited tree while an
  // allowed advisory still "counts as used": offline=true (empty report),
  // registry=<mock>, omit=dev / production, and package-lock=false (a freshly
  // resolved tree instead of the committed lockfile). The cache must be new and
  // empty: npm reuses a cached advisory's severity while its vulnerable range is
  // unchanged, so a persistent cache reports a raised severity at its old level.
  // The explicit --prefix stops npm from switching to a parent directory whose
  // package.json lists this checkout as a workspace, and auditing its lockfile.
  // It also moves the default global config to <prefix>/etc/npmrc, a file in
  // this repository that could set a proxy, so the global config must name a
  // file that does not exist (npm refuses /dev/null twice, and the cache
  // directory starts empty).
  return [
    'audit', '--json', '--userconfig=/dev/null', '--registry=https://registry.npmjs.org/', '--offline=false', `--cache=${cache}`,
    `--globalconfig=${join(cache, 'no-global-npmrc')}`,
    '--audit-level=high', '--include=dev', '--include=optional', '--include=peer', '--package-lock-only',
    '--prefix', target === 'admin-app' ? join(REPOSITORY_ROOT, 'admin-app') : REPOSITORY_ROOT,
  ];
}

export function auditEnvironment(env) {
  const clean = {};
  for (const [key, value] of Object.entries(env)) {
    // npm reads its configuration from npm_config_* in any letter case.
    if (key === 'NODE_ENV' || /^npm_config_/i.test(key)) continue;
    clean[key] = value;
  }
  clean.npm_config_allow_scripts = '';
  return clean;
}

function validateEntry(entry) {
  if (!isRecord(entry)) throw new Error('allowlist entry must be an object');
  for (const key of Object.keys(entry)) if (!ENTRY_FIELDS.has(key)) throw new Error(`allowlist entry has unknown field ${key}`);
  if (typeof entry.id !== 'string' || !GHSA.test(entry.id)) throw new Error(`allowlist entry has invalid id ${String(entry.id)}`);
  const label = entry.id;
  if (typeof entry.package !== 'string' || !PACKAGE.test(entry.package)) throw new Error(`${label}: invalid package`);
  if (!Array.isArray(entry.targets) || entry.targets.length === 0 || new Set(entry.targets).size !== entry.targets.length
    || !entry.targets.every(target => TARGETS.includes(target))) {
    throw new Error(`${label}: invalid targets`);
  }
  if (!BLOCKING.has(entry.maxSeverity)) throw new Error(`${label}: invalid maxSeverity`);
  if (!isCalendarDate(entry.expires)) throw new Error(`${label}: invalid expires`);
  if (typeof entry.reason !== 'string' || entry.reason.trim() === '') throw new Error(`${label}: invalid reason`);
}

export function validateAllowlist(entries) {
  if (!Array.isArray(entries)) throw new Error('allowlist must be an array');
  const seen = new Set();
  for (const entry of entries) {
    validateEntry(entry);
    const key = `${entry.id}\u0000${entry.package}`;
    if (seen.has(key)) throw new Error(`${entry.id}: duplicate entry for ${entry.package}`);
    seen.add(key);
  }
}

function reportedVulnerabilities(report) {
  // npm reports its own failures (network, devEngines) as JSON with exit 1.
  if (isRecord(report) && isRecord(report.error)) {
    const summary = String(report.error.summary ?? '').split('\n')[0];
    throw new Error(`npm audit failed: ${String(report.error.code ?? 'unknown error')} ${summary}`.trim());
  }
  if (!isRecord(report) || report.auditReportVersion !== 2) {
    throw new Error(`npm audit report has unsupported auditReportVersion ${String(report?.auditReportVersion)}`);
  }
  // npm still prints well-formed JSON when its audit endpoint fails, so a
  // missing object means "no audit happened", not "nothing was found".
  if (!isRecord(report.vulnerabilities)) throw new Error('npm audit report has no vulnerabilities object');
  return report.vulnerabilities;
}

function validateRecord(name, record, vulnerabilities) {
  if (!isRecord(record) || !isSeverity(record.severity) || !Array.isArray(record.via)) {
    throw new Error(`npm audit report: ${name} has an invalid record`);
  }
  for (const element of record.via) {
    if (typeof element === 'string') {
      if (!Object.hasOwn(vulnerabilities, element)) throw new Error(`npm audit report: ${name} references ${element}, which is not in the report`);
    } else if (!isRecord(element) || !isSeverity(element.severity) || typeof element.name !== 'string'
      || !GHSA.test(advisoryId(element.url))) {
      throw new Error(`npm audit report: ${name} has an invalid advisory`);
    }
  }
}

function assertSummaryCounts(summary, counts) {
  if (!isRecord(summary)) throw new Error('npm audit report has no metadata.vulnerabilities counts');
  for (const [key, value] of Object.entries(counts)) {
    if (summary[key] !== value) throw new Error(`npm audit report metadata ${key} is ${String(summary[key])} but the records count ${value}`);
  }
}

// Called once every element is valid. A high/critical package must still
// resolve to a high/critical advisory: its own, or one reached by following
// `via` names. Visited names stop a reference cycle from spinning.
function reachesBlocking(vulnerabilities, name, seen) {
  if (seen.has(name)) return false;
  seen.add(name);
  return vulnerabilities[name].via.some(element =>
    typeof element === 'string' ? reachesBlocking(vulnerabilities, element, seen) : BLOCKING.has(element.severity));
}

// npm sets a record to the highest severity among its advisories. An advisory
// reached through a dependency is never above that dependency's own severity,
// so a record sits at or above each own advisory and at or below the highest
// of its own advisories and its dependencies.
function severityAgrees(record, vulnerabilities) {
  const rank = SEVERITY_RANK[record.severity];
  const own = record.via.filter(element => typeof element !== 'string').map(element => SEVERITY_RANK[element.severity]);
  const reach = record.via.map(element => SEVERITY_RANK[typeof element === 'string' ? vulnerabilities[element].severity : element.severity]);
  return !own.some(value => value > rank) && rank <= Math.max(...reach);
}

function validateReport(report) {
  const vulnerabilities = reportedVulnerabilities(report);
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0, total: 0 };
  for (const [name, record] of Object.entries(vulnerabilities)) {
    validateRecord(name, record, vulnerabilities);
    counts[record.severity] += 1;
    counts.total += 1;
  }
  assertSummaryCounts(report.metadata?.vulnerabilities, counts);
  for (const [name, record] of Object.entries(vulnerabilities)) {
    if (BLOCKING.has(record.severity) && !reachesBlocking(vulnerabilities, name, new Set())) {
      throw new Error(`npm audit report: ${name} reaches no high or critical advisory`);
    }
  }
  for (const [name, record] of Object.entries(vulnerabilities)) {
    if (!severityAgrees(record, vulnerabilities)) {
      throw new Error(`npm audit report: ${name} has severity ${record.severity}, which disagrees with its advisories`);
    }
  }
  return vulnerabilities;
}

function addBlocking(blocking, id, severity, name) {
  const found = blocking.get(id) ?? { advisory: id, severity, packages: new Set() };
  if (SEVERITY_RANK[severity] > SEVERITY_RANK[found.severity]) found.severity = severity;
  found.packages.add(name);
  blocking.set(id, found);
}

// Judge each advisory on its own severity: the package-level one is the
// maximum over every advisory hitting the package. Matching entries go to `used`.
function blockingAdvisories(vulnerabilities, covering, used) {
  const blocking = new Map();
  for (const [name, record] of Object.entries(vulnerabilities)) {
    for (const element of record.via) {
      if (typeof element === 'string' || !BLOCKING.has(element.severity)) continue;
      const id = advisoryId(element.url);
      const entry = covering.find(candidate => candidate.id === id && candidate.package === name && element.name === name
        && SEVERITY_RANK[element.severity] <= SEVERITY_RANK[candidate.maxSeverity]);
      if (entry) used.add(entry);
      else addBlocking(blocking, id, element.severity, name);
    }
  }
  return blocking;
}

/**
 * @returns {{advisory: string, severity: string, packages: string[]}[]}
 *   one entry per blocking advisory, sorted by advisory ID.
 */
export function evaluateAudit(report, { target, today, allowlist }) {
  validateAllowlist(allowlist);
  assertTarget(target);
  if (!isCalendarDate(today)) throw new Error('today must be YYYY-MM-DD');
  for (const entry of allowlist) {
    if (today >= entry.expires) throw new Error(`allowlist entry ${entry.id} expired on ${entry.expires}; decide again whether to extend it or fix the dependency`);
  }
  const vulnerabilities = validateReport(report);
  const covering = allowlist.filter(entry => entry.targets.includes(target));
  const used = new Set();
  const blocking = blockingAdvisories(vulnerabilities, covering, used);
  if (blocking.size > 0) {
    return [...blocking.values()]
      .sort((a, b) => a.advisory.localeCompare(b.advisory))
      .map(found => ({ ...found, packages: [...found.packages].sort((a, b) => a.localeCompare(b)) }));
  }
  // Only once nothing else is wrong: a leftover entry is standing permission
  // to ignore that advisory the next time it turns up somewhere else.
  const stale = covering.filter(entry => !used.has(entry));
  if (stale.length > 0) {
    throw new Error(`${stale.map(entry => entry.id).join(', ')} no longer appears in the ${target} audit; remove ${target} from the entry's targets, or delete the entry`);
  }
  return [];
}

export function runAudit({ target, env = process.env, today, allowlist = ALLOWED_ADVISORIES, spawn = spawnSync }) {
  assertTarget(target);
  validateAllowlist(allowlist);
  const cache = resolve(mkdtempSync(join(tmpdir(), 'audit-gate-npm-cache-')));
  let audit;
  try {
    audit = spawn('npm', auditArguments(target, cache), {
      cwd: REPOSITORY_ROOT, encoding: 'utf8', env: auditEnvironment(env), maxBuffer: 64 * 1024 * 1024,
    });
  } finally {
    rmSync(cache, { recursive: true, force: true });
  }
  if (audit.error) throw new Error(`could not run npm audit: ${audit.error.message}`);
  if (!NPM_AUDIT_RAN.has(audit.status)) {
    throw new Error(`npm audit exited ${audit.status}, so the audit did not complete: ${String(audit.stderr ?? '').trim()}`);
  }
  let report;
  try {
    report = JSON.parse(audit.stdout);
  } catch {
    throw new Error('npm audit did not print a JSON report');
  }
  return evaluateAudit(report, { target, today, allowlist });
}

export function main(argv, {
  env = process.env, today = new Date().toISOString().slice(0, 10), allowlist = ALLOWED_ADVISORIES, spawn = spawnSync, log = console.log,
} = {}) {
  if (argv.length !== 1) throw new Error(USAGE);
  const [target] = argv;
  const blocking = runAudit({ target, env, today, allowlist, spawn });
  for (const { advisory, severity, packages } of blocking) {
    log(`::error::${severity} advisory ${advisory} affects ${packages.join(', ')}`);
  }
  if (blocking.length > 0) throw new Error(`${blocking.length} unlisted high/critical advisories in the ${target} audit`);
  const allowed = allowlist.filter(entry => entry.targets.includes(target)).map(entry => entry.id).sort((a, b) => a.localeCompare(b)).join(', ') || 'none';
  log(`no unlisted high/critical advisories for ${target} (allowed: ${allowed})`);
}

// Compare real paths: a check that misses a symlinked invocation would exit 0
// without auditing anything, which is the one outcome a gate must never have.
const invokedDirectly = () => {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
};

if (invokedDirectly()) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.log(`::error::${error.message}`);
    process.exitCode = 1;
  }
}
