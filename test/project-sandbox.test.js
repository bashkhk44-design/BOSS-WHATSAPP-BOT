'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateSandboxImage, validateRuntimeNodeModules, hasProjectTests, buildSandboxArgs, runSandboxTests } = require('../project-sandbox');
const IMAGE = 'node:22-alpine@sha256:' + 'a'.repeat(64);

test('sandbox requires immutable image digest', () => {
  assert.throws(() => validateSandboxImage('node:22-alpine'), /sha256 digest/);
  assert.equal(validateSandboxImage(IMAGE), IMAGE);
});
test('test discovery identifies supported test files', () => {
  assert.equal(hasProjectTests([{ path: 'index.js' }]), false);
  assert.equal(hasProjectTests([{ path: 'test/app.test.js' }]), true);
  assert.equal(hasProjectTests([{ path: 'src/app.spec.cjs' }]), true);
});
test('docker arguments enforce isolation and resource bounds', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-'));
  try {
    const built = buildSandboxArgs({ projectDir: dir, image: IMAGE });
    assert.equal(built.timeout, 60000);
    for (const flag of ['--network=none', '--read-only', '--memory=256m', '--cpus=0.5', '--pids-limit=64', '--cap-drop=ALL', '--security-opt=no-new-privileges', '--pull=never']) {
      assert.ok(built.args.includes(flag), flag);
    }
    assert.ok(!built.args.includes('--privileged'));
    assert.ok(!built.args.includes('--network=host'));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('no container is started when no tests exist', () => {
  let called = false;
  const result = runSandboxTests({ projectDir: '/not-used', files: [{ path: 'index.js' }], image: IMAGE, spawn: () => { called = true; } });
  assert.equal(result.status, 'skipped');
  assert.equal(called, false);
});
test('runner invokes isolated docker container without passing secrets', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-'));
  try {
    let invocation;
    const result = runSandboxTests({
      projectDir: dir, files: [{ path: 'test/app.test.js' }], image: IMAGE,
      spawn: (command, args, options) => {
        invocation = { command, args, options };
        return { status: 0, stdout: 'tests passed', stderr: '' };
      }
    });
    assert.equal(invocation.command, 'docker');
    assert.ok(invocation.args.includes('--network=none'));
    assert.equal(invocation.options.env.BOTS_ENCRYPTION_KEY, undefined);
    assert.equal(result.status, 'passed');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});
test('runner reports container failure', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-'));
  try {
    const result = runSandboxTests({
      projectDir: dir, files: [{ path: 'test/app.test.js' }], image: IMAGE,
      spawn: () => ({ status: 125, stdout: '', stderr: 'image unavailable' })
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.passed, false);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});


test('runtime node_modules is mounted read-only at the project resolution path', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-project-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-runtime-'));
  try {
    const built = buildSandboxArgs({
      projectDir, image: IMAGE, runtimeNodeModulesDir: runtimeDir
    });
    const mountIndex = built.args.indexOf('--mount', built.args.indexOf('--mount') + 1);
    assert.ok(mountIndex >= 0);
    assert.equal(
      built.args[mountIndex + 1],
      'type=bind,src=' + fs.realpathSync(runtimeDir) + ',dst=/workspace/node_modules,readonly'
    );
    assert.equal(validateRuntimeNodeModules(runtimeDir), fs.realpathSync(runtimeDir));
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});

test('runtime node_modules rejects symlink roots', () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-runtime-link-'));
  const target = path.join(parent, 'target');
  const link = path.join(parent, 'link');
  try {
    fs.mkdirSync(target);
    fs.symlinkSync(target, link, 'dir');
    assert.throws(() => validateRuntimeNodeModules(link), /real directory/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('runner passes the verified runtime mount without exposing environment secrets', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-project-'));
  const runtimeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-runtime-'));
  try {
    let invocation;
    const result = runSandboxTests({
      projectDir, runtimeNodeModulesDir: runtimeDir,
      files: [{ path: 'test/app.test.js' }], image: IMAGE,
      spawn: (command, args, options) => {
        invocation = { command, args, options };
        return { status: 0, stdout: 'tests passed', stderr: '' };
      }
    });
    assert.equal(invocation.command, 'docker');
    assert.ok(invocation.args.some(arg => arg.includes('dst=/workspace/node_modules,readonly')));
    assert.equal(invocation.options.env.BOTS_ENCRYPTION_KEY, undefined);
    assert.equal(result.status, 'passed');
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
    fs.rmSync(runtimeDir, { recursive: true, force: true });
  }
});
