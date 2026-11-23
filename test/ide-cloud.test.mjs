import test from 'node:test';
import assert from 'node:assert/strict';
import { createIdeCloudFallback } from '../ide/cloud.mjs';

const raw = (conversationId, inputTokens = 42) => ({
  conversationId,
  totalStepsLength: 2,
  steps: [
    { idx: 0, stepType: 14, status: 3, createdAtMs: 1000 },
    { idx: 1, stepType: 15, status: 3, createdAtMs: 1100, completedAtMs: 2000,
      hasUsage: true, inputTokens, cacheReadTokens: 0, outputTokens: 10,
      thinkingTokens: 4, replyTokens: 6, maxContextTokens: 100000, retryErrors: [] },
  ],
  executors: [],
});

test('IDE cloud main-chat fallback follows exact IDs and never substitutes a parent for a child', () => {
  const cloud = createIdeCloudFallback({ hasLocal: () => false });
  cloud.onCloudTelemetry('main', raw('main'));
  assert.equal(cloud.needsCloudTelemetry('main'), true);
  const snapshot = cloud.read('main');
  assert.equal(snapshot.contextTokens, 42);
  assert.equal(snapshot.turnMetrics.requestCount, 1);
  assert.equal(snapshot.requestTimingAvailable, false);
  assert.equal(snapshot.generation.tps, null, 'step timestamps are not measured request speed');
  assert.equal(cloud.read('main', false).turnMetrics, null);
  assert.equal(cloud.read('other'), null);
  assert.equal(cloud.read('main', true, true), null);
  assert.equal(cloud.read('main', true, 'side'), null);
  assert.equal(cloud.read(''), null);
  assert.equal(cloud.needsCloudTelemetry('../main'), false);
});

test('a local database always wins, and a deleted local DB cannot revive an old cloud snapshot', () => {
  const local = new Set();
  const cloud = createIdeCloudFallback({ hasLocal: id => local.has(id) });
  cloud.onCloudTelemetry('chat', raw('chat'));
  assert.equal(cloud.read('chat').contextTokens, 42);
  local.add('chat');
  assert.equal(cloud.needsCloudTelemetry('chat'), false);
  assert.equal(cloud.read('chat'), null);
  cloud.onCloudTelemetry('chat', raw('chat', 99));
  local.delete('chat');
  assert.equal(cloud.read('chat'), null);
  assert.equal(cloud.needsCloudTelemetry('chat'), true);
  cloud.onCloudTelemetry('chat', raw('chat', 100));
  assert.equal(cloud.read('chat').contextTokens, 100);
});

test('cloud snapshots clear on absent/mismatched samples and expire after ten seconds', () => {
  let clock = 0;
  const cloud = createIdeCloudFallback({ hasLocal: () => false, now: () => clock });
  cloud.onCloudTelemetry('a', raw('a'));
  cloud.onCloudTelemetry('b', raw('b', 99));
  cloud.onCloudTelemetry('a', raw('b', 100));
  assert.equal(cloud.read('a'), null);
  assert.equal(cloud.read('b').contextTokens, 99);
  cloud.onCloudTelemetry('b', null);
  assert.equal(cloud.read('b'), null);
  cloud.onCloudTelemetry('a', raw('a'));
  clock = 9999;
  assert.equal(cloud.read('a').contextTokens, 42);
  clock = 10000;
  assert.equal(cloud.read('a'), null);
  cloud.onCloudTelemetry('a', { conversationId: 'a', steps: [] });
  assert.equal(cloud.read('a'), null);
});

test('a partial page tail exposes only its proved request, not whole-conversation totals or history', () => {
  const cloud = createIdeCloudFallback({ hasLocal: () => false });
  const partial = raw('tail');
  partial.totalStepsLength = 20;
  cloud.onCloudTelemetry('tail', partial);
  const snapshot = cloud.read('tail');
  assert.equal(snapshot.contextTokens, undefined);
  assert.equal(snapshot.turnMetrics, null);
  assert.equal(snapshot.generation.tps, null);
  assert.equal(snapshot.days, undefined, 'page slices must not become disk usage history');
  assert.equal(Object.hasOwn(cloud, 'readHistory'), false);
});
