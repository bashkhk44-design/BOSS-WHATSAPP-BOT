'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { testProjectBundle } = require('../ai-tester');

function makeBundle(lockContent = JSON.stringify({
  name: 'fixture',
  version: '1.0.0',
  lockfileVersion: 3,
  packages: {
    '': { name: 'fixture', version: '1.0.0' },
    'node_modules/demo': {
      version: '1.0.0',
      resolved: 'https://registry.npmjs.org/demo/-/demo-1.0.0.tgz',
      integrity: 'sha512-' + Buffer.alloc(64).toString('base64')
    }
  }
})) {
  return {
    files: [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'fixture',
          version: '1.0.0',
          scripts: { test: 'node --test' },
          dependencies: { demo: '1.0.0' }
        })
      },
      { path: 'package-lock.json', content: lockContent },
      {
        path: 'boss-manifest.json',
        content: JSON.stringify({
          version: 1,
          requiredEnv: [],
          optionalEnv: [],
          startScript: 'test'
        })
      },
      {
        path: 'test/app.test.js',
        content: "const test = require('node:test');\ntest('fixture', () => {});\n"
      }
    ]
  };
}

test('runtime test fails closed when locked dependencies have no verified artifact', async () => {
  const previousEnabled = process.env.BOSS_SANDBOX_ENABLED;
  const previousImage = process.env.BOSS_SANDBOX_IMAGE;
  process.env.BOSS_SANDBOX_ENABLED = 'YES';
  delete process.env.BOSS_SANDBOX_IMAGE;
  try {
    const result = await testProjectBundle({ bundle: makeBundle() });
    assert.equal(result.sandbox.status, 'failed');
    assert.equal(result.sandbox.passed, false);
    assert.match(result.sandbox.details, /verified offline dependency artifacts are required/i);
    assert.equal(result.passed, false);
  } finally {
    if (previousEnabled === undefined) delete process.env.BOSS_SANDBOX_ENABLED;
    else process.env.BOSS_SANDBOX_ENABLED = previousEnabled;
    if (previousImage === undefined) delete process.env.BOSS_SANDBOX_IMAGE;
    else process.env.BOSS_SANDBOX_IMAGE = previousImage;
  }
});

test('runtime test fails closed for malformed package-lock instead of throwing', async () => {
  const previousEnabled = process.env.BOSS_SANDBOX_ENABLED;
  const previousImage = process.env.BOSS_SANDBOX_IMAGE;
  process.env.BOSS_SANDBOX_ENABLED = 'YES';
  delete process.env.BOSS_SANDBOX_IMAGE;
  try {
    const result = await testProjectBundle({ bundle: makeBundle('{invalid-json') });
    assert.equal(result.sandbox.status, 'failed');
    assert.equal(result.sandbox.passed, false);
    assert.match(result.sandbox.details, /valid package-lock/i);
    assert.equal(result.passed, false);
  } finally {
    if (previousEnabled === undefined) delete process.env.BOSS_SANDBOX_ENABLED;
    else process.env.BOSS_SANDBOX_ENABLED = previousEnabled;
    if (previousImage === undefined) delete process.env.BOSS_SANDBOX_IMAGE;
    else process.env.BOSS_SANDBOX_IMAGE = previousImage;
  }
});
