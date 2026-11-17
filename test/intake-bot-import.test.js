'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

test('importing intake bot does not load runtime dependencies or start polling', () => {
  const beforeSigterm = process.listenerCount('SIGTERM');
  const beforeSigint = process.listenerCount('SIGINT');

  const intake = require('../intake-bot');

  assert.equal(typeof intake.createIntakeRuntime, 'function');
  assert.equal(typeof intake.startIntakeBot, 'function');
  assert.equal(typeof intake.stopIntakeBot, 'function');

  for (const modulePath of ['./db', './project-db', './ai-intake', 'grammy']) {
    assert.equal(
      require.cache[require.resolve(modulePath, { paths: [__dirname, process.cwd()] })],
      undefined,
      modulePath + ' must not load during intake-bot import'
    );
  }

  assert.equal(process.listenerCount('SIGTERM'), beforeSigterm);
  assert.equal(process.listenerCount('SIGINT'), beforeSigint);
});

test('stopping an unused intake runtime does not initialize dependencies', async () => {
  const { stopIntakeBot } = require('../intake-bot');

  await stopIntakeBot();

  for (const modulePath of ['./db', './project-db', './ai-intake', 'grammy']) {
    assert.equal(
      require.cache[require.resolve(modulePath, { paths: [__dirname, process.cwd()] })],
      undefined,
      modulePath + ' must remain unloaded when stopping an unused runtime'
    );
  }
});
