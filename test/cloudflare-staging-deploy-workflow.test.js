'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('Cloudflare staging deployment is restricted to the unified staging branch and current Worker', () => {
  const workflowPath = path.join(__dirname, '..', '.github', 'workflows', 'deploy-cloudflare-platform-staging.yml');
  const workflow = fs.readFileSync(workflowPath, 'utf8');

  assert.match(
    workflow,
    /github\.ref == 'refs\/heads\/staging\/unified-platform-tls-migrations'\s*&&\s*inputs\.confirmation == 'DEPLOY-BOSS-STAGING'/,
  );
  assert.match(workflow, /EXPECTED_REF="refs\/heads\/staging\/unified-platform-tls-migrations"/);
  assert.match(workflow, /\[ "\$GITHUB_REF" != "\$EXPECTED_REF" \]/);
  assert.match(workflow, /"name": "boss-bot-master-staging"/);
  assert.match(workflow, /"id": "a10d6fde0bc345a286a25de4789382db"/);
  assert.match(workflow, /PLATFORM_BOT_WEBHOOK_MODE": "disabled"/);
  assert.match(workflow, /"workers_dev": true/);
  assert.doesNotMatch(workflow, /boss-bot-platform-ingress-staging/);
});
