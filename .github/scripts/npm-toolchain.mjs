import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { appendFileSync, existsSync, lstatSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { basename, delimiter, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// This standalone file is part of the immutable public quality tuple.
const version = '12.2.2';
const integrity = 'sha512-KglgbZyacf7jH+FHuNRqVuCzQi8VhI2a7J87Ix43FsPTuZoGWmIXXGdZtBUOA79vwL+IJREqURVzupA7PsQTcA==';
const contract = {
  engines: { node: '>=24.15.0 <25', npm: version },
  packageManager: 'npm@' + version,
  devEngines: {
    runtime: { name: 'node', version: '>=24.15.0 <25', onFail: 'error' },
    packageManager: { name: 'npm', version, onFail: 'error' },
  },
};
const json = path => JSON.parse(readFileSync(path, 'utf8'));
const owner = () => ({ run: process.env.GITHUB_RUN_ID ?? 'local', attempt: process.env.GITHUB_RUN_ATTEMPT ?? '1', job: process.env.GITHUB_JOB ?? 'local' });

function projectContract(legacy) {
  const [major, minor] = process.versions.node.split('.').map(Number);
  assert(major === 24 && minor >= 15, 'Node must be >=24.15.0 <25');
  const manifests = ['package.json', 'admin-app/package.json'].map(json);
  if (legacy && manifests.every(manifest => Object.keys(contract).every(key => !Object.hasOwn(manifest, key)) && !Object.hasOwn(manifests[1], 'allowScripts'))) return;
  for (const manifest of manifests) {
    for (const [key, value] of Object.entries(contract)) assert.deepEqual(manifest[key], value, 'Project toolchain mismatch: ' + key);
  }
  assert.deepEqual(manifests[1].allowScripts, {}, 'Admin install scripts must be explicitly denied');
}

function ownedDirectory(directory, missing = false) {
  assert(process.env.RUNNER_TEMP, 'RUNNER_TEMP is required');
  const runner = realpathSync(process.env.RUNNER_TEMP);
  assert(typeof directory === 'string' && dirname(directory) === runner && /^npm-toolchain-[A-Za-z0-9]{6}$/.test(basename(directory)), 'Unsafe toolchain directory');
  const stat = lstatSync(directory, { throwIfNoEntry: false });
  if (!stat && missing) return false;
  assert(stat?.isDirectory() && !stat.isSymbolicLink() && stat.uid === process.getuid() && realpathSync(directory) === directory, 'Unowned toolchain directory');
  const receipt = join(directory, '.owner.json');
  const receiptStat = lstatSync(receipt);
  assert(receiptStat.isFile() && !receiptStat.isSymbolicLink() && receiptStat.nlink === 1, 'Invalid toolchain ownership receipt');
  assert.deepEqual(json(receipt), owner(), 'Toolchain belongs to another job');
  return true;
}

function cleanup(directory) {
  if (!directory) return;
  if (!ownedDirectory(directory, true)) return;
  rmSync(directory, { recursive: true });
  assert(!existsSync(directory), 'Toolchain cleanup failed');
  console.log('Removed job-local npm toolchain');
}

function installedToolchain(directory) {
  ownedDirectory(directory);
  assert.deepEqual(json(join(directory, 'package.json')), { name: 'isolated-npm-toolchain', private: true, dependencies: { npm: version } }, 'Unexpected tool-only manifest');
  const lock = json(join(directory, 'package-lock.json'));
  const entry = lock.packages?.['node_modules/npm'];
  assert(lock.lockfileVersion === 3 && entry?.version === version, 'Unexpected npm lock version');
  assert.equal(entry.resolved, 'https://registry.npmjs.org/npm/-/npm-' + version + '.tgz', 'Unexpected npm archive URL');
  assert.equal(entry.integrity, integrity, 'Unexpected npm archive integrity');
  assert.deepEqual(lock.packages[''].dependencies, { npm: version }, 'Unexpected tool-only dependencies');
  assert(Object.keys(lock.packages).every(path => path === '' || path === 'node_modules/npm' || (path.startsWith('node_modules/npm/node_modules/') && lock.packages[path].inBundle === true)), 'Unexpected unbundled toolchain dependency');
  const manifest = json(join(directory, 'node_modules/npm/package.json'));
  assert(manifest.name === 'npm' && manifest.version === version, 'Unexpected installed npm');
  for (const name of ['npm', 'npx']) {
    const target = join(directory, 'node_modules/npm/bin', name + '-cli.js');
    assert.equal(manifest.bin?.[name], 'bin/' + name + '-cli.js', 'Unexpected npm executable');
    assert(lstatSync(target).isFile() && !lstatSync(target).isSymbolicLink(), 'Non-regular npm executable');
    assert.equal(realpathSync(join(directory, 'node_modules/.bin', name)), target, 'Escaping npm executable');
  }
}

async function run(command, args, env = process.env) {
  return await new Promise((accept, reject) => {
    const child = execFile(command, args, { env, timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, stdout, stderr) => {
      for (const signal of ['SIGINT', 'SIGTERM']) process.removeListener(signal, cancel);
      if (error) reject(new Error('Toolchain command failed: ' + (error.signal ?? error.code) + '\n' + stderr));
      else accept(stdout.trim());
    });
    const cancel = () => child.kill('SIGTERM');
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, cancel);
  });
}

async function bootstrap(legacy) {
  projectContract(legacy);
  assert(process.env.RUNNER_TEMP && process.env.GITHUB_OUTPUT && process.env.GITHUB_PATH, 'RUNNER_TEMP, GITHUB_OUTPUT and GITHUB_PATH are required');
  const directory = mkdtempSync(join(realpathSync(process.env.RUNNER_TEMP), 'npm-toolchain-'));
  const created = lstatSync(directory);
  try {
    appendFileSync(process.env.GITHUB_OUTPUT, 'directory=' + directory + '\n');
    writeFileSync(join(directory, '.owner.json'), JSON.stringify(owner()), { mode: 0o600 });
    writeFileSync(join(directory, 'package.json'), JSON.stringify({ name: 'isolated-npm-toolchain', private: true, dependencies: { npm: version } }));
    writeFileSync(join(directory, 'global.npmrc'), '');
    const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^npm_config_/i.test(key) && !['NODE_OPTIONS', 'NODE_PATH'].includes(key)));
    await run('npm', ['install', '--prefix', directory, '--ignore-scripts', '--package-lock=true', '--no-audit', '--no-fund', '--registry=https://registry.npmjs.org', '--userconfig=/dev/null', '--globalconfig=' + join(directory, 'global.npmrc'), '--cache=' + join(directory, 'cache')], env);
    installedToolchain(directory);
    assert.equal(await run(process.execPath, [join(directory, 'node_modules/npm/bin/npm-cli.js'), '--version'], env), version, 'npm version mismatch');
    appendFileSync(process.env.GITHUB_PATH, join(directory, 'node_modules/.bin') + '\n');
    console.log('Prepared npm ' + version + ' for this job');
  } catch (error) {
    // Creation identity also covers failure before the ownership receipt was written.
    const current = lstatSync(directory, { throwIfNoEntry: false });
    if (current) {
      assert(current.isDirectory() && !current.isSymbolicLink() && current.dev === created.dev && current.ino === created.ino, 'Toolchain directory was replaced');
      rmSync(directory, { recursive: true });
      assert(!existsSync(directory), 'Toolchain cleanup failed');
    }
    throw error;
  }
}

async function verify(legacy) {
  projectContract(legacy);
  const directory = process.env.TOOLCHAIN_DIRECTORY;
  installedToolchain(directory);
  for (const name of ['npm', 'npx']) {
    const executable = (process.env.PATH ?? '').split(delimiter).map(path => join(path, name)).find(existsSync);
    assert(executable && realpathSync(executable) === join(directory, 'node_modules/npm/bin', name + '-cli.js'), 'PATH does not select the job-local ' + name);
  }
  assert.equal(await run(process.execPath, [join(directory, 'node_modules/npm/bin/npm-cli.js'), '--version']), version, 'npm version mismatch');
  console.log('Verified Node ' + process.versions.node + ' / npm ' + version);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const [command, flag, ...extra] = process.argv.slice(2);
    assert(!extra.length && ['bootstrap', 'verify', 'cleanup'].includes(command) && (flag === undefined || (flag === '--legacy' && command !== 'cleanup')), 'Usage: npm-toolchain.mjs bootstrap|verify [--legacy] | cleanup');
    if (command === 'bootstrap') await bootstrap(flag === '--legacy');
    else if (command === 'verify') await verify(flag === '--legacy');
    else cleanup(process.env.TOOLCHAIN_DIRECTORY);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
