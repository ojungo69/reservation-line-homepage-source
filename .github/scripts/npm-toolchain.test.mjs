import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const helper = fileURLToPath(new URL('./npm-toolchain.mjs', import.meta.url));
const integrity = 'sha512-KglgbZyacf7jH+FHuNRqVuCzQi8VhI2a7J87Ix43FsPTuZoGWmIXXGdZtBUOA79vwL+IJREqURVzupA7PsQTcA==';
const contract = {
  engines: { node: '>=24.15.0 <25', npm: '12.2.2' },
  packageManager: 'npm@12.2.2',
  devEngines: {
    runtime: { name: 'node', version: '>=24.15.0 <25', onFail: 'error' },
    packageManager: { name: 'npm', version: '12.2.2', onFail: 'error' },
  },
};

function installerProbe() {
  const fs = require('node:fs');
  const p = require('node:path');
  const args = process.argv.slice(2);
  const root = args[args.indexOf('--prefix') + 1];
  fs.writeFileSync(process.env.PROBE_ARGS, JSON.stringify(args));
  if (process.env.PROBE_MODE === 'install-failure') process.exit(42);
  if (process.env.PROBE_MODE === 'wait') { setInterval(() => {}, 1000); return; }
  fs.mkdirSync(p.join(root, 'node_modules/npm/bin'), { recursive: true });
  fs.mkdirSync(p.join(root, 'node_modules/.bin'), { recursive: true });
  const entry = { version: '12.2.2', resolved: 'https://registry.npmjs.org/npm/-/npm-12.2.2.tgz', integrity: process.env.PROBE_INTEGRITY };
  if (process.env.PROBE_MODE === 'digest') entry.integrity = 'sha512-wrong';
  if (process.env.PROBE_MODE === 'version') entry.version = '12.2.3';
  if (process.env.PROBE_MODE === 'url') entry.resolved = 'https://example.invalid/npm.tgz';
  const packages = { '': { name: 'isolated-npm-toolchain', dependencies: { npm: '12.2.2' } }, 'node_modules/npm': entry };
  if (process.env.PROBE_MODE === 'extra') packages['node_modules/other'] = { version: '1.0.0' };
  if (process.env.PROBE_MODE === 'unbundled') packages['node_modules/npm/node_modules/other'] = { version: '1.0.0' };
  fs.writeFileSync(p.join(root, 'package-lock.json'), JSON.stringify({ lockfileVersion: 3, packages }));
  fs.writeFileSync(p.join(root, 'node_modules/npm/package.json'), JSON.stringify({ name: 'npm', version: '12.2.2', bin: { npm: 'bin/npm-cli.js', npx: 'bin/npx-cli.js' } }));
  const executable = "require('node:fs').writeFileSync(process.env.PROBE_MARKER,'executed'); console.log(process.env.PROBE_MODE === 'bin-version' ? '12.2.3' : '12.2.2');";
  for (const name of ['npm', 'npx']) {
    fs.writeFileSync(p.join(root, 'node_modules/npm/bin', name + '-cli.js'), executable);
    fs.symlinkSync('../npm/bin/' + name + '-cli.js', p.join(root, 'node_modules/.bin', name));
  }
  if (process.env.PROBE_MODE === 'bin-path') {
    fs.unlinkSync(p.join(root, 'node_modules/.bin/npm'));
    fs.symlinkSync(process.execPath, p.join(root, 'node_modules/.bin/npm'));
  }
}

function fixture(t, mode = '') {
  const root = mkdtempSync(join(tmpdir(), 'npm-toolchain-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  for (const path of ['runner', 'project/admin-app', 'bin']) mkdirSync(join(root, path), { recursive: true });
  for (const path of ['package.json', 'admin-app/package.json']) writeFileSync(join(root, 'project', path), JSON.stringify({ ...contract, allowScripts: {} }));
  const installer = join(root, 'bin/npm');
  writeFileSync(installer, '#!' + process.execPath + '\n(' + installerProbe.toString() + ')();\n');
  chmodSync(installer, 0o700);
  const env = { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, RUNNER_TEMP: join(root, 'runner'), GITHUB_OUTPUT: join(root, 'outputs'), GITHUB_PATH: join(root, 'paths'), GITHUB_RUN_ID: '123', GITHUB_RUN_ATTEMPT: '2', GITHUB_JOB: 'fixture', PROBE_MODE: mode, PROBE_INTEGRITY: integrity, PROBE_ARGS: join(root, 'args'), PROBE_MARKER: join(root, 'executed') };
  const run = (...args) => spawnSync(process.execPath, [helper, ...args], { cwd: join(root, 'project'), env, encoding: 'utf8' });
  const directory = () => readFileSync(env.GITHUB_OUTPUT, 'utf8').trim().split('=')[1];
  return { root, env, run, directory };
}

test('rejects an unapproved archive before executing npm or publishing PATH', t => {
  const f = fixture(t, 'digest');
  const result = f.run('bootstrap');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /integrity/);
  assert.equal(existsSync(f.env.PROBE_MARKER), false);
  assert.equal(existsSync(f.env.GITHUB_PATH), false);
  assert.equal(existsSync(f.directory()), false);
});

for (const mode of ['version', 'url', 'extra', 'unbundled', 'bin-path', 'install-failure']) {
  test('bootstrap fails closed and cleans its exact directory: ' + mode, t => {
    const f = fixture(t, mode);
    const result = f.run('bootstrap');
    assert.equal(result.status, 1, result.stderr);
    assert.equal(existsSync(f.env.PROBE_MARKER), false);
    assert.equal(existsSync(f.env.GITHUB_PATH), false);
    assert.equal(existsSync(f.directory()), false);
  });
}

test('installs only the pinned tool, verifies PATH, and cleans without touching siblings', t => {
  const f = fixture(t);
  const result = f.run('bootstrap');
  assert.equal(result.status, 0, result.stderr);
  const directory = f.directory();
  assert.equal(readFileSync(f.env.GITHUB_PATH, 'utf8'), join(directory, 'node_modules/.bin') + '\n');
  assert.deepEqual(JSON.parse(readFileSync(f.env.PROBE_ARGS, 'utf8')), [
    'install', '--prefix', directory, '--ignore-scripts', '--package-lock=true', '--no-audit', '--no-fund',
    '--registry=https://registry.npmjs.org', '--userconfig=/dev/null', '--globalconfig=' + join(directory, 'global.npmrc'), '--cache=' + join(directory, 'cache'),
  ]);
  f.env.TOOLCHAIN_DIRECTORY = directory;
  f.env.PATH = join(directory, 'node_modules/.bin') + ':' + f.env.PATH;
  assert.equal(f.run('verify').status, 0);
  const sibling = join(f.env.RUNNER_TEMP, 'keep-me');
  writeFileSync(sibling, 'untouched');
  assert.equal(f.run('cleanup').status, 0);
  assert.equal(existsSync(directory), false);
  assert.equal(readFileSync(sibling, 'utf8'), 'untouched');
  assert.equal(f.run('cleanup').status, 0);
});

test('wrong executable version never reaches later steps', t => {
  const f = fixture(t, 'bin-version');
  const result = f.run('bootstrap');
  assert.equal(result.status, 1, result.stderr);
  assert.match(result.stderr, /version mismatch/);
  assert.equal(existsSync(f.env.GITHUB_PATH), false);
  assert.equal(existsSync(f.directory()), false);
});

test('verify refuses a PATH shadow and rechecks installed archive metadata', t => {
  const f = fixture(t);
  assert.equal(f.run('bootstrap').status, 0);
  f.env.TOOLCHAIN_DIRECTORY = f.directory();
  assert.match(f.run('verify').stderr, /PATH does not select/);
  f.env.PATH = join(f.directory(), 'node_modules/.bin') + ':' + f.env.PATH;
  const lockPath = join(f.directory(), 'package-lock.json');
  const lock = JSON.parse(readFileSync(lockPath, 'utf8'));
  lock.packages['node_modules/npm'].integrity = 'sha512-wrong';
  writeFileSync(lockPath, JSON.stringify(lock));
  assert.match(f.run('verify').stderr, /integrity/);
  assert.equal(f.run('cleanup').status, 0);
});

for (const field of ['engines', 'packageManager', 'devEngines', 'allowScripts']) {
  test('rejects a partial/mismatched project contract before install: ' + field, t => {
    const f = fixture(t);
    const path = join(f.root, 'project/admin-app/package.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    delete manifest[field];
    writeFileSync(path, JSON.stringify(manifest));
    assert.equal(f.run('bootstrap').status, 1);
    assert.equal(f.run('bootstrap', '--legacy').status, 1);
    assert.equal(existsSync(f.env.PROBE_ARGS), false);
  });
}

test('bridge mode accepts truly absent old fields and also the complete new contract', t => {
  const f = fixture(t);
  for (const path of ['package.json', 'admin-app/package.json']) writeFileSync(join(f.root, 'project', path), '{}');
  assert.equal(f.run('bootstrap').status, 1);
  const result = f.run('bootstrap', '--legacy');
  assert.equal(result.status, 0, result.stderr);
  f.env.TOOLCHAIN_DIRECTORY = f.directory();
  f.env.PATH = join(f.directory(), 'node_modules/.bin') + ':' + f.env.PATH;
  assert.equal(f.run('verify', '--legacy').status, 0);
  assert.equal(f.run('cleanup').status, 0);
  for (const path of ['package.json', 'admin-app/package.json']) writeFileSync(join(f.root, 'project', path), JSON.stringify({ ...contract, allowScripts: {} }));
  assert.equal(f.run('bootstrap', '--legacy').status, 0);
});

test('cleanup refuses other jobs, traversal, and symlink replacement', t => {
  const f = fixture(t);
  assert.equal(f.run('bootstrap').status, 0);
  const directory = f.directory();
  f.env.TOOLCHAIN_DIRECTORY = directory;
  f.env.GITHUB_JOB = 'other';
  assert.match(f.run('cleanup').stderr, /another job/);
  assert.equal(existsSync(directory), true);
  f.env.GITHUB_JOB = 'fixture';
  f.env.TOOLCHAIN_DIRECTORY = directory + '/../keep';
  assert.match(f.run('cleanup').stderr, /Unsafe toolchain/);
  f.env.TOOLCHAIN_DIRECTORY = directory;
  rmSync(directory, { recursive: true });
  symlinkSync(join(f.root, 'project'), directory);
  assert.match(f.run('cleanup').stderr, /Unowned toolchain/);
  assert.equal(existsSync(join(f.root, 'project/package.json')), true);
});

test('cancellation during install cleans the directory and never publishes PATH', async t => {
  const f = fixture(t, 'wait');
  const child = spawn(process.execPath, [helper, 'bootstrap'], { cwd: join(f.root, 'project'), env: f.env, stdio: 'ignore' });
  t.after(() => child.kill('SIGKILL'));
  const closed = new Promise(resolve => child.once('close', (code, signal) => resolve({ code, signal })));
  for (let i = 0; i < 100 && !existsSync(f.env.PROBE_ARGS); i++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(existsSync(f.env.PROBE_ARGS), true);
  child.kill('SIGTERM');
  const result = await closed;
  assert.equal(result.code, 1);
  assert.equal(existsSync(f.directory()), false);
  assert.equal(existsSync(f.env.GITHUB_PATH), false);
});

test('invalid invocation and missing runner identity fail before creating tool state', t => {
  const f = fixture(t);
  assert.equal(f.run('install').status, 1);
  assert.equal(f.run('cleanup', '--legacy').status, 1);
  assert.equal(f.run('bootstrap', '--force').status, 1);
  delete f.env.RUNNER_TEMP;
  assert.match(f.run('bootstrap').stderr, /RUNNER_TEMP/);
  assert.equal(existsSync(f.env.PROBE_ARGS), false);
});

for (const name of ['GITHUB_OUTPUT', 'GITHUB_PATH']) {
  test('cleans even when writing the runner communication file fails: ' + name, t => {
    const f = fixture(t);
    f.env[name] = f.root;
    const result = f.run('bootstrap');
    assert.equal(result.status, 1);
    assert.match(result.stderr, /EISDIR/);
    assert.deepEqual(readdirSync(f.env.RUNNER_TEMP), []);
  });
}
