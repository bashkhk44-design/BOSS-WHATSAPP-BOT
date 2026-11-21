'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Cloudflare staging deployment is restricted to the unified staging branch', () => {
  const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'deploy-cloudflare-platform-staging.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert.match(
    workflow,
    /github\.ref == 'refs\/heads\/staging\/unified-platform-tls-migrations'\s*&&\s*inputs\.confirmation == 'DEPLOY-BOSS-STAGING'/,
  );
  assert.match(
    workflow,
    /EXPECTED_REF="refs\/heads\/staging\/unified-platform-tls-migrations"/,
  );
  assert.match(workflow, /\[ "\$GITHUB_REF" != "\$EXPECTED_REF" \]/);
  assert.match(workflow, /PLATFORM_BOT_WEBHOOK_MODE": "disabled"/);
  assert.match(workflow, /boss-bot-platform-ingress-staging/);
});
