import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import {
  ALLOWED_ADVISORIES,
  auditArguments,
  auditEnvironment,
  evaluateAudit,
  main,
  runAudit,
  validateAllowlist,
} from './audit-gate.mjs';

const gate = fileURLToPath(new URL('./audit-gate.mjs', import.meta.url));
const repositoryRoot = fileURLToPath(new URL('../..', import.meta.url)).replace(/\/$/, '');
const GHSA = 'GHSA-fc5q-39xc-vjpf';
const OTHER = 'GHSA-mh99-v99m-4gvg';
const TODAY = '2026-11-18';
const ENTRY = Object.freeze({
  id: GHSA,
  package: 'picomatch',
  targets: Object.freeze(['root', 'admin-app']),
  maxSeverity: 'high',
  expires: '2026-12-18',
  reason: 'No patched release; build tooling only.',
});

function advisory(name, id = GHSA, severity = 'high') {
  return { source: 1247710, name, dependency: name, title: 'ReDoS', url: `https://github.com/advisories/${id}`, severity, range: '<=4.0.7' };
}

function report(vulnerabilities, metadata = {}) {
  const counts = { info: 0, low: 0, moderate: 0, high: 0, critical: 0 };
  for (const entry of Object.values(vulnerabilities)) if (Object.hasOwn(counts, entry?.severity)) counts[entry.severity] += 1;
  return {
    auditReportVersion: 2,
    vulnerabilities,
    metadata: { vulnerabilities: { ...counts, total: Object.keys(vulnerabilities).length, ...metadata } },
  };
}

// Shaped like the measured 2026-11-18 report: only picomatch carries the advisory
// object, everything else reaches it by name, and vitest/coverage-v8 form a cycle.
function measuredTree() {
  return {
    picomatch: { name: 'picomatch', severity: 'high', isDirect: false, via: [advisory('picomatch')], range: '<=4.0.7' },
    fdir: { name: 'fdir', severity: 'high', isDirect: false, via: ['picomatch'] },
    tinyglobby: { name: 'tinyglobby', severity: 'high', isDirect: false, via: ['fdir', 'picomatch'] },
    vite: { name: 'vite', severity: 'high', isDirect: false, via: ['picomatch', 'tinyglobby'] },
    vitest: { name: 'vitest', severity: 'high', isDirect: true, via: ['@vitest/coverage-v8', 'picomatch', 'tinyglobby'] },
    '@vitest/coverage-v8': { name: '@vitest/coverage-v8', severity: 'high', isDirect: true, via: ['vitest'] },
  };
}

const evaluate = (audit, options = {}) => evaluateAudit(audit, { target: 'root', today: TODAY, allowlist: [ENTRY], ...options });
const cacheOf = args => args.find(arg => arg.startsWith('--cache='))?.slice('--cache='.length);

test('allows the measured picomatch chain for both targets', () => {
  assert.deepEqual(evaluate(report(measuredTree())), []);
  assert.deepEqual(evaluate(report(measuredTree()), { target: 'admin-app' }), []);
});

test('blocks an unlisted advisory and reports every package that carries it', () => {
  const tree = measuredTree();
  tree.undici = { name: 'undici', severity: 'high', via: [advisory('undici', OTHER)] };
  tree.other = { name: 'other', severity: 'critical', via: [advisory('other', OTHER, 'critical')] };
  assert.deepEqual(evaluate(report(tree)), [{ advisory: OTHER, severity: 'critical', packages: ['other', 'undici'] }]);
});

test('judges each advisory on its own severity, not the package aggregate', () => {
  const tree = measuredTree();
  tree.picomatch.via.push(advisory('picomatch', OTHER, 'moderate'));
  assert.deepEqual(evaluate(report(tree)), []);
});

test('still blocks an unlisted high next to the allowed one on the same package', () => {
  const tree = measuredTree();
  tree.picomatch.via.push(advisory('picomatch', OTHER));
  assert.deepEqual(evaluate(report(tree)), [{ advisory: OTHER, severity: 'high', packages: ['picomatch'] }]);
});

test('blocks the allowed advisory on a package the entry does not name', () => {
  const tree = measuredTree();
  tree.vite.via.push(advisory('vite'));
  assert.deepEqual(evaluate(report(tree)), [{ advisory: GHSA, severity: 'high', packages: ['vite'] }]);
});

test('blocks an advisory whose own name differs from the record that carries it', () => {
  const tree = measuredTree();
  tree.picomatch.via = [advisory('not-picomatch')];
  assert.deepEqual(evaluate(report(tree)), [{ advisory: GHSA, severity: 'high', packages: ['picomatch'] }]);
});

test('blocks the advisory for a target the entry does not cover', () => {
  const entry = { ...ENTRY, targets: ['root'] };
  assert.deepEqual(evaluate(report(measuredTree()), { allowlist: [entry] }), []);
  assert.deepEqual(evaluate(report(measuredTree()), { allowlist: [entry], target: 'admin-app' }), [
    { advisory: GHSA, severity: 'high', packages: ['picomatch'] },
  ]);
});

test('blocks a severity above the approved one and allows it when approved', () => {
  const tree = measuredTree();
  tree.picomatch.severity = 'critical';
  tree.picomatch.via = [advisory('picomatch', GHSA, 'critical')];
  assert.deepEqual(evaluate(report(tree)), [{ advisory: GHSA, severity: 'critical', packages: ['picomatch'] }]);
  assert.deepEqual(evaluate(report(tree), { allowlist: [{ ...ENTRY, maxSeverity: 'critical' }] }), []);
});

test('fails on and after the expiry date, for every target', () => {
  assert.deepEqual(evaluate(report(measuredTree()), { today: '2026-12-17' }), []);
  assert.throws(() => evaluate(report(measuredTree()), { today: '2026-12-18' }), /GHSA-fc5q-39xc-vjpf expired on 2026-12-18/);
  const rootOnly = { ...ENTRY, targets: ['root'] };
  assert.throws(() => evaluate(report({}), { allowlist: [rootOnly], target: 'admin-app', today: '2027-01-01' }), /expired/);
  assert.throws(() => evaluate(report(measuredTree()), { today: '2026/11/18' }), /today must be YYYY-MM-DD/);
});

test('fails on an entry that the audited target no longer needs', () => {
  assert.throws(() => evaluate(report({}), { target: 'admin-app' }), /GHSA-fc5q-39xc-vjpf no longer appears in the admin-app audit/);
  assert.deepEqual(evaluate(report({}), { target: 'admin-app', allowlist: [{ ...ENTRY, targets: ['root'] }] }), []);
});

test('reports real findings before complaining about a stale entry', () => {
  const tree = { undici: { name: 'undici', severity: 'high', via: [advisory('undici', OTHER)] } };
  assert.deepEqual(evaluate(report(tree)), [{ advisory: OTHER, severity: 'high', packages: ['undici'] }]);
});

test('rejects every malformed allowlist entry', () => {
  assert.doesNotThrow(() => validateAllowlist(ALLOWED_ADVISORIES));
  assert.throws(() => validateAllowlist({}), /must be an array/);
  const invalid = {
    id: 'GHSA-ab12-cd34-ef56',
    package: '',
    targets: [],
    duplicateTarget: ['root', 'root'],
    unknownTarget: ['production'],
    maxSeverity: 'moderate',
    expires: '2026-02-30',
    reason: '   ',
  };
  for (const [field, value] of Object.entries(invalid)) {
    const key = field === 'duplicateTarget' || field === 'unknownTarget' ? 'targets' : field;
    assert.throws(() => validateAllowlist([{ ...ENTRY, [key]: value }]), new RegExp(`invalid ${key}`), `${field} must be rejected`);
  }
  assert.throws(() => validateAllowlist([{ ...ENTRY, expires: '2026-1-1' }]), /invalid expires/);
  assert.throws(() => validateAllowlist([{ ...ENTRY, expire: '2027-01-01' }]), /unknown field expire/);
  assert.throws(() => validateAllowlist([ENTRY, { ...ENTRY }]), /duplicate entry/);
  assert.throws(() => evaluate(report(measuredTree()), { allowlist: [{ ...ENTRY, reason: '' }] }), /invalid reason/);
});

test('fails closed when npm produced no usable report', () => {
  for (const value of [null, {}, { error: { code: 'ENETUNREACH' } }]) {
    assert.throws(() => evaluate(value), /audit report/);
  }
  // An array would walk zero records and match zero counts; it must be rejected on its own.
  assert.throws(() => evaluate({ ...report({}), vulnerabilities: [] }), /no vulnerabilities object/);
  assert.throws(() => evaluate({ ...report(measuredTree()), auditReportVersion: 1 }), /auditReportVersion 1/);
  assert.throws(() => evaluate({ auditReportVersion: 2, vulnerabilities: measuredTree() }), /metadata/);
});

test('fails closed on any invalid element, even next to the allowed advisory', () => {
  const cases = {
    'missing reference': tree => tree.vite.via.push('missing-package'),
    'advisory without severity': tree => tree.picomatch.via.push({ ...advisory('picomatch', OTHER), severity: undefined }),
    'unknown record severity': tree => { tree.fdir.severity = 'severe'; },
    'via is not an array': tree => { tree.fdir.via = 'picomatch'; },
    'advisory without GHSA url': tree => tree.picomatch.via.push({ ...advisory('picomatch'), url: 'https://example.invalid/1' }),
    'number element': tree => tree.vite.via.push(42),
    // ['critical'] coerces to the key 'critical' but is not the string a Set lookup matches.
    'advisory severity that is not a string': tree => tree.picomatch.via.push({ ...advisory('picomatch', OTHER), severity: ['critical'] }),
    'record severity that is not a string': tree => { tree.fdir.severity = ['high']; },
  };
  for (const [name, mutate] of Object.entries(cases)) {
    const tree = measuredTree();
    mutate(tree);
    assert.throws(() => evaluate(report(tree)), /audit report/, name);
  }
});

test('fails closed on a high package that reaches only a moderate advisory', () => {
  const tree = measuredTree();
  tree.ws = { name: 'ws', severity: 'high', via: ['ws-core'] };
  tree['ws-core'] = { name: 'ws-core', severity: 'moderate', via: [advisory('ws-core', OTHER, 'moderate')] };
  assert.throws(() => evaluate(report(tree)), /ws reaches no high or critical advisory/);
});

test('fails closed on a via cycle that never reaches an advisory', () => {
  const tree = measuredTree();
  tree.a = { name: 'a', severity: 'high', via: ['b'] };
  tree.b = { name: 'b', severity: 'high', via: ['a'] };
  assert.throws(() => evaluate(report(tree)), /reaches no high or critical advisory/);
});

test('fails closed when the summary counts disagree with the records', () => {
  const tree = measuredTree();
  const counted = report({ ...tree, undici: { name: 'undici', severity: 'high', via: [advisory('undici', OTHER)] } });
  delete counted.vulnerabilities.undici;
  assert.throws(() => evaluate(counted), /metadata high is 7 but the records count 6/);
  assert.throws(() => evaluate(report(tree, { total: 7 })), /metadata total is 7 but the records count 6/);
});

test('pins the npm audit arguments for each target', () => {
  // Each flag overrides a project/global .npmrc setting that was measured to empty or swap the
  // audited tree under npm 12.2.2: offline=true, registry=<mock>, package-lock=false, omit=dev,
  // and a persistent cache, whose advisory entries keep an old severity.
  const base = [
    'audit', '--json', '--userconfig=/dev/null', '--registry=https://registry.npmjs.org/', '--offline=false', '--cache=/fresh',
    '--audit-level=high', '--include=dev', '--include=optional', '--include=peer', '--package-lock-only',
  ];
  assert.deepEqual(auditArguments('root', '/fresh'), base);
  assert.deepEqual(auditArguments('admin-app', '/fresh'), [...base, '--prefix', 'admin-app']);
  assert.throws(() => auditArguments('production', '/fresh'), /usage/);
  // npm would otherwise create (and keep) a cache directory named after the value.
  for (const cache of [undefined, 'relative/cache']) assert.throws(() => auditArguments('root', cache), /absolute cache directory/);
});

test('strips inherited npm configuration and production mode from the child environment', () => {
  const env = auditEnvironment({
    PATH: '/bin', HOME: '/home/x', NODE_ENV: 'production', NPM_CONFIG_OMIT: 'dev', npm_config_omit: 'dev',
    Npm_Config_Production: 'true', npm_config_allow_scripts: 'evil', npm_execpath: '/npm-cli.js',
  });
  assert.deepEqual(env, { PATH: '/bin', HOME: '/home/x', npm_execpath: '/npm-cli.js', npm_config_allow_scripts: '' });
});

test('runs npm in the repository root with a fresh cache, the pinned arguments and the cleaned environment', () => {
  const calls = [];
  const spawn = (command, args, options) => {
    const cache = cacheOf(args);
    calls.push({ command, args, env: options.env, cwd: options.cwd, cache, entries: readdirSync(cache) });
    return { status: 1, stdout: JSON.stringify(report(measuredTree())), stderr: '' };
  };
  const options = { target: 'admin-app', env: { PATH: '/bin', NODE_ENV: 'production' }, today: TODAY, allowlist: [ENTRY], spawn };
  assert.deepEqual(runAudit(options), []);
  assert.deepEqual(runAudit(options), []);
  assert.equal(calls.length, 2);
  for (const call of calls) {
    assert.deepEqual(call, {
      command: 'npm', args: auditArguments('admin-app', call.cache), env: { PATH: '/bin', npm_config_allow_scripts: '' },
      cwd: repositoryRoot, cache: call.cache, entries: [],
    });
    assert.ok(isAbsolute(call.cache));
    assert.equal(existsSync(call.cache), false, 'the audit cache must be removed afterwards');
  }
  assert.notEqual(calls[0].cache, calls[1].cache, 'each audit needs its own cache');
});

test('main prints the allowed advisories on success and every blocking advisory on failure', () => {
  const lines = [];
  const options = advisories => ({
    env: {}, today: TODAY, allowlist: [ENTRY], log: line => lines.push(line),
    spawn: () => ({ status: 1, stdout: JSON.stringify(report(advisories)), stderr: '' }),
  });
  main(['admin-app'], options(measuredTree()));
  assert.deepEqual(lines, ['no unlisted high/critical advisories for admin-app (allowed: GHSA-fc5q-39xc-vjpf)']);
  lines.length = 0;
  const tree = { ...measuredTree(), undici: { name: 'undici', severity: 'high', via: [advisory('undici', OTHER)] } };
  assert.throws(() => main(['root'], options(tree)), /1 unlisted high\/critical advisories in the root audit/);
  assert.deepEqual(lines, ['::error::high advisory GHSA-mh99-v99m-4gvg affects undici']);
  assert.throws(() => main([], options(measuredTree())), /usage/);
  lines.length = 0;
  main(['root'], { ...options({}), allowlist: [] });
  assert.deepEqual(lines, ['no unlisted high/critical advisories for root (allowed: none)']);
});

test('fails when npm did not complete the audit or printed no JSON, and still removes the cache', () => {
  const options = { target: 'root', env: {}, today: TODAY, allowlist: [ENTRY] };
  const caches = [];
  const npm = outcome => (_command, args) => {
    caches.push(cacheOf(args));
    if (outcome instanceof Error) throw outcome;
    return outcome;
  };
  assert.throws(() => runAudit({ ...options, spawn: npm({ status: 2, stdout: '', stderr: 'boom' }) }), /npm audit exited 2/);
  assert.throws(() => runAudit({ ...options, spawn: npm({ status: null, error: new Error('ENOENT'), stdout: '' }) }), /could not run npm audit: ENOENT/);
  assert.throws(() => runAudit({ ...options, spawn: npm({ status: 1, stdout: 'not json', stderr: '' }) }), /did not print a JSON report/);
  assert.throws(() => runAudit({ ...options, spawn: npm(new Error('spawn threw')) }), /spawn threw/);
  assert.equal(caches.length, 4);
  for (const cache of caches) {
    assert.ok(typeof cache === 'string' && isAbsolute(cache), `no absolute --cache in ${String(cache)}`);
    assert.equal(existsSync(cache), false, `left behind ${cache}`);
  }
  assert.throws(() => runAudit({ ...options, target: 'prod', spawn: () => assert.fail('npm must not run') }), /usage/);
  assert.throws(() => runAudit({ ...options, allowlist: [{ ...ENTRY, reason: '' }], spawn: () => assert.fail('npm must not run') }), /invalid reason/);
});

function withStubNpm(t, behaviour) {
  const root = mkdtempSync(join(tmpdir(), 'audit-gate-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const probe = join(root, 'probe.json');
  writeFileSync(join(root, 'npm'), `#!/usr/bin/env node
const fs = require('node:fs');
const env = {};
for (const [key, value] of Object.entries(process.env)) if (/^(node_env|npm_config_)/i.test(key)) env[key] = value;
const argv = process.argv.slice(2);
const cache = (argv.find(arg => arg.startsWith('--cache=')) ?? '').slice('--cache='.length);
const cacheEntries = cache && fs.existsSync(cache) ? fs.readdirSync(cache) : null;
fs.writeFileSync(${JSON.stringify(probe)}, JSON.stringify({ argv, env, cwd: process.cwd(), cacheEntries }));
process.stdout.write(${JSON.stringify(behaviour.stdout ?? '')});
process.exit(${Number(behaviour.status ?? 0)});
`);
  chmodSync(join(root, 'npm'), 0o755);
  const run = (...args) => spawnSync(process.execPath, [gate, ...args], {
    encoding: 'utf8',
    cwd: root,
    env: {
      PATH: `${root}:${process.env.PATH ?? '/usr/bin:/bin'}`,
      NODE_ENV: 'production', NPM_CONFIG_OMIT: 'dev', npm_config_omit: 'dev', npm_config_allow_scripts: 'evil',
    },
  });
  return { run, probe: () => JSON.parse(readFileSync(probe, 'utf8')) };
}

test('the CLI audits the repository root through the real process boundary with a cleaned environment', t => {
  const clean = report({});
  const stub = withStubNpm(t, { status: 0, stdout: JSON.stringify(clean) });
  // Started from an unrelated directory: npm must still run in the repository that holds the gate.
  const result = stub.run('root');
  // A clean audit passes only when no entry covers the target; a covering entry is then unused
  // (or expired) and must fail. This holds on every date and for every allowlist.
  const expected = ALLOWED_ADVISORIES.some(entry => entry.targets.includes('root')) ? 1 : 0;
  assert.equal(result.status, expected, result.stdout + result.stderr);
  const probe = stub.probe();
  const cache = cacheOf(probe.argv);
  assert.deepEqual(probe, {
    argv: auditArguments('root', cache), env: { npm_config_allow_scripts: '' }, cwd: repositoryRoot, cacheEntries: [],
  });
  assert.equal(existsSync(cache), false, 'the audit cache must be removed afterwards');
});

test('the CLI prints each blocking advisory and fails', t => {
  const tree = { ...measuredTree(), undici: { name: 'undici', severity: 'high', via: [advisory('undici', OTHER)] } };
  const stub = withStubNpm(t, { status: 1, stdout: JSON.stringify(report(tree)) });
  const result = stub.run('admin-app');
  assert.equal(result.status, 1);
  assert.match(result.stdout, /::error::/);
  const { argv } = stub.probe();
  assert.deepEqual(argv, auditArguments('admin-app', cacheOf(argv)));
});

test('the CLI still runs when invoked through a symlinked path', t => {
  const root = mkdtempSync(join(tmpdir(), 'audit-gate-link-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const link = join(root, 'gate.mjs');
  symlinkSync(gate, link);
  const result = spawnSync(process.execPath, [link], { encoding: 'utf8', env: { PATH: process.env.PATH ?? '/usr/bin:/bin' } });
  // A main-module check that misses the symlink would exit 0 without auditing anything.
  assert.equal(result.status, 1, result.stdout + result.stderr);
  assert.match(result.stdout, /::error::usage/);
});

test('the CLI rejects a missing or unknown target without running npm', t => {
  const stub = withStubNpm(t, { status: 0, stdout: '{}' });
  for (const args of [[], ['production'], ['root', 'extra']]) {
    const result = stub.run(...args);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /::error::usage: node \.github\/scripts\/audit-gate\.mjs root\|admin-app/);
  }
  assert.throws(() => stub.probe(), /ENOENT/);
});
