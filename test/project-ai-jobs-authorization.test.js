'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { configureManagerIdentity } = require('../project-authorization');
const jobs = require('../project-ai-jobs');

test('AI job service rejects unauthorized or missing manager identity before database access', async () => {
  configureManagerIdentity('7001');
  const calls = [
    () => jobs.getLatestCompletedProjectAiJob({ projectId: 1, adminTelegramId: '7002' }),
    () => jobs.getProjectAiJobAttempts(1, { adminTelegramId: '7002' }),
    () => jobs.startProjectAiJobAttempt(1, { adminTelegramId: '7002' }),
    () => jobs.completeProjectAiJobAttempt(1, 1, {}, { adminTelegramId: '7002' }),
    () => jobs.failProjectAiJobAttempt(1, 1, 'failure', { adminTelegramId: '7002' }),
    () => jobs.markProjectAiJobRunning(1, { adminTelegramId: '7002' }),
    () => jobs.completeProjectAiJob(1, {}, { adminTelegramId: '7002' }),
    () => jobs.failProjectAiJob(1, 'failure', { adminTelegramId: '7002' }),
    () => jobs.recoverInterruptedProjectAiJobs({ adminTelegramId: '7002' }),
    () => jobs.getLatestCompletedProjectAiJob({ projectId: 1 }),
    () => jobs.startProjectAiJobAttempt(1)
  ];

  for (const call of calls) {
    await assert.rejects(call, /غير مصرح|غير صالح/);
  }
});
