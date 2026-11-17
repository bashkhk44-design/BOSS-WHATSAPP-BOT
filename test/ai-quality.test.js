'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { validateBundle } = require('../ai-builder');
const { validateManifest, scanForEmbeddedSecrets, testProjectBundle } = require('../ai-tester');
const { providers } = require('../ai-router');

function validBundle() {
  return {
    files: [
      {
        path: 'package.json',
        content: JSON.stringify({
          name: 'sample-bot',
          version: '1.0.0',
          scripts: { start: 'node index.js' }
        })
      },
      {
        path: 'boss-manifest.json',
        content: JSON.stringify({
          version: 1,
          requiredEnv: [],
          optionalEnv: [],
          startScript: 'start',
          healthCheck: '/health'
        })
      },
      {
        path: 'index.js',
        content: "console.log('sample');"
      }
    ]
  };
}

test('bundle validation accepts a safe project bundle', () => {
  assert.equal(validateBundle(validBundle()).files.length, 3);
});

test('bundle validation rejects path traversal', () => {
  const bundle = validBundle();
  bundle.files.push({ path: '../escape.js', content: 'x' });
  assert.throws(() => validateBundle(bundle), /مسار ملف غير آمن/);
});

test('manifest validation checks the declared start script', () => {
  const pkg = { scripts: { start: 'node index.js' } };
  const manifest = {
    version: 1,
    requiredEnv: ['DATABASE_URL'],
    optionalEnv: [],
    startScript: 'start',
    healthCheck: '/health'
  };
  assert.equal(validateManifest(manifest, pkg).startScript, 'start');
  assert.throws(
    () => validateManifest({ ...manifest, startScript: 'missing' }, pkg),
    /غير موجود/
  );
});

test('secret scanner detects embedded Telegram credentials', () => {
  const findings = scanForEmbeddedSecrets([
    { path: 'index.js', content: 'const token = "12345678:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijk";' }
  ]);
  assert.equal(findings.length, 1);
  assert.equal(findings[0].name, 'TELEGRAM_BOT_TOKEN');
});

test('project bundle static checks pass for a valid minimal bundle', async () => {
  const result = await testProjectBundle({ bundle: validBundle() });
  assert.equal(result.passed, true, JSON.stringify(result.checks));
});

test('alternative AI providers require explicit opt-in', () => {
  const names = [
    'GEMINI_API_KEY',
    'GROQ_API_KEY',
    'OPENROUTER_API_KEY',
    'AI_ENABLE_GROQ_FREE',
    'AI_ENABLE_OPENROUTER'
  ];
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));

  try {
    process.env.GEMINI_API_KEY = 'test-gemini';
    process.env.GROQ_API_KEY = 'test-groq';
    process.env.OPENROUTER_API_KEY = 'test-openrouter';
    delete process.env.AI_ENABLE_GROQ_FREE;
    delete process.env.AI_ENABLE_OPENROUTER;

    assert.deepEqual(providers().map(provider => provider.id), ['gemini']);

    process.env.AI_ENABLE_GROQ_FREE = 'true';
    process.env.AI_ENABLE_OPENROUTER = 'true';
    assert.deepEqual(
      providers().map(provider => provider.id),
      ['gemini', 'groq', 'openrouter']
    );
  } finally {
    for (const name of names) {
      if (previous[name] === undefined) delete process.env[name];
      else process.env[name] = previous[name];
    }
  }
});
