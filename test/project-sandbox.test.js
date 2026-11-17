'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateSandboxImage, hasProjectTests, buildSandboxArgs, runSandboxTests } = require('../project-sandbox');
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
