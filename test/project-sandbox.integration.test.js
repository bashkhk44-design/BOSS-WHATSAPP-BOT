'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runSandboxTests } = require('../project-sandbox');

test('executes a project test inside the network-disabled Docker sandbox', () => {
  const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'boss-sandbox-integration-'));
  try {
    fs.writeFileSync(path.join(projectDir, 'smoke.test.js'), [
      "const test = require('node:test');",
      "const assert = require('node:assert/strict');",
      "test('isolated runtime smoke test', () => assert.equal(2 + 2, 4));"
    ].join('\\n'));
    fs.chmodSync(projectDir, 0o755);
    const result = runSandboxTests({
      projectDir,
      files: [{ path: 'smoke.test.js' }],
      image: process.env.BOSS_SANDBOX_IMAGE,
      timeoutMs: 30000
    });
    assert.equal(result.status, 'passed', result.details || result.reason);
    assert.equal(result.passed, true);
  } finally {
    fs.rmSync(projectDir, { recursive: true, force: true });
  }
});
