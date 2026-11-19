'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');

test('Termux worker preflight verifies PostgreSQL TLS certificates by default', () => {
  const script = fs.readFileSync('scripts/termux-worker.sh', 'utf8');

  assert.match(
    script,
    /ssl:\s*process\.env\.DATABASE_SSL\s*===\s*'disable'\s*\?\s*false\s*:\s*true/
  );

  assert.doesNotMatch(script, /rejectUnauthorized\s*:\s*false/);
});
