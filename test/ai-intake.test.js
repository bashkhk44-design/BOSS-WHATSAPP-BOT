'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  extractJson,
  normalizeIntakeResult
} = require('../ai-intake');

test('AI intake parses plain JSON and fenced JSON', () => {
  assert.deepEqual(extractJson('{"ready_for_review":true}'), { ready_for_review: true });
  assert.deepEqual(extractJson('```json\n{"ready_for_review":false}\n```'), { ready_for_review: false });
});

test('AI intake rejects malformed or missing JSON', () => {
  assert.throws(() => extractJson('لا يوجد JSON'));
  assert.throws(() => extractJson('{"broken":'));
});

test('AI intake merges only allowed non-empty string fields', () => {
  const result = normalizeIntakeResult({
    assistant_message: 'ما طريقة استقبال الطلبات؟',
    fields: {
      description: 'متجر إلكتروني',
      features: 'عرض المنتجات',
      unexpected: 'must not be saved',
      payments: 123,
      extra: ''
    },
    missing_items: ['تحديد التوصيل'],
    ready_for_review: false
  }, {
    projectName: 'متجري',
    buttons: 'تصفح'
  });

  assert.equal(result.data.projectName, 'متجري');
  assert.equal(result.data.buttons, 'تصفح');
  assert.equal(result.data.description, 'متجر إلكتروني');
  assert.equal(result.data.features, 'عرض المنتجات');
  assert.equal(result.data.unexpected, undefined);
  assert.equal(result.data.payments, undefined);
  assert.deepEqual(result.missingItems, ['تحديد التوصيل']);
  assert.equal(result.readyForReview, false);
});

test('AI intake cannot finish while missing items remain', () => {
  const result = normalizeIntakeResult({
    assistant_message: 'ما زالت هناك نقطة تحتاج توضيحاً.',
    fields: {},
    missing_items: ['تحديد صلاحيات الموظفين'],
    ready_for_review: true
  });
  assert.equal(result.readyForReview, false);
  assert.deepEqual(result.missingItems, ['تحديد صلاحيات الموظفين']);
});

test('AI intake requires a customer-facing next message', () => {
  assert.throws(
    () => normalizeIntakeResult({ fields: {}, ready_for_review: true }),
    /missing its next message/
  );
});
