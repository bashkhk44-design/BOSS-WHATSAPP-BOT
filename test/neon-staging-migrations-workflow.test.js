'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

test('Neon staging migration preflight heredoc contains valid JavaScript', () => {
  const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'neon-staging-migrations.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf8');
  const marker = "          node <<'NODE'\\n";
  const markerIndex = workflow.indexOf(marker);
  assert.notEqual(markerIndex, -1, 'the read-only preflight Node heredoc must exist');

  const sourceStart = markerIndex + marker.length;
  const sourceEnd = workflow.indexOf('\\n          NODE', sourceStart);
  assert.notEqual(sourceEnd, -1, 'the preflight Node heredoc must be closed');

  const script = workflow.slice(sourceStart, sourceEnd)
    .split('\\n')
    .map(line => line.startsWith('          ') ? line.slice(10) : line)
    .join('\\n');

  assert.match(script, /const expectedHost/);
  assert.doesNotThrow(() => new vm.Script(script), 'the embedded preflight script must parse');
});
