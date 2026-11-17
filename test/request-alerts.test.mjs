import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyRequestError } from '../agy-capsule/sidecars/agy_capsule/errors.mjs';
import { createPresentation } from '../agy-capsule/sidecars/agy_capsule/ui.mjs';
import { parseGenRow } from '../agy-capsule/sidecars/agy_capsule/server.mjs';

test('request failure classification follows reported errors rather than quota percentages', () => {
  for (const [message, kind] of [
    ['quota exceeded', 'quota_exhausted'], ['429 Too Many Requests retry in 30s', 'rate_limited'],
    ['ECONNRESET', 'network_error'], ['401 Unauthorized', 'auth_error'], ['503 Service Unavailable', 'service_unavailable'],
    ['unexpected provider failure', 'unknown'], ['context canceled by user', 'canceled'],
    ['request failed: Post "https://<API>/v1internal:streamGenerateContent?alt=sse": context canceled', 'canceled'], ['User cancelled agent execution.', 'canceled'],
    ['input token count exceeds the maximum context length', 'context_overflow'], ['context deadline exceeded', 'network_error'],
    ['The input token count (737355) exceeds the maximum number of tokens allowed (524288)', 'context_overflow'],
    ['prompt is too long: 200001 tokens > 200000 maximum', 'context_overflow'],
    ['401 permission denied; quota access rejected', 'auth_error'], ['', 'none'],
  ]) assert.equal(classifyRequestError(message).kind, kind, message);
  assert.equal(classifyRequestError('429 retry in 30s').retryAfterSec, 30);
  assert.equal(classifyRequestError('429 Too Many Requests').retryAfterSec, null);
  assert.equal(classifyRequestError('failed at https://example.invalid/private?key=secret').diagnostic, 'failed at <API>');
});

test('colors and request failure capsule are independent, with no cancellation/overflow failure capsule', () => {
  const ui = createPresentation();
  const data = { contextTokens: 75, maxContextTokens: 100, requestError: classifyRequestError('429 Too Many Requests') };
  assert.equal(ui.alertView(data).contextTone, 'warning');
  assert.equal(ui.alertView(data).visible, true);
  assert.equal(ui.alertView(data, { showContextWarnings: false }).visible, true);
  assert.equal(ui.alertView(data, { showContextWarnings: false }).contextTone, '');
  assert.equal(ui.alertView(data, { showRequestErrors: false }).contextTone, 'warning');
  assert.equal(ui.alertView(data, { showRequestErrors: false }).visible, false);
  for (const percent of [90, 100, 125]) assert.equal(ui.alertView({ ...data, contextTokens: percent }).contextTone, 'error');
  for (const error of ['context canceled by user', 'maximum context length exceeded', '']) {
    assert.equal(ui.alertView({ ...data, requestError: classifyRequestError(error) }).visible, false);
  }
  const unknown = ui.alertView({ ...data, requestError: classifyRequestError('unknown failure') }, {}, ui.dictionaries['zh-CN']);
  assert.equal(unknown.label, '未知原因');
});

function vi(value) {
  let n = BigInt(value); const bytes = [];
  while (n >= 128n) { bytes.push(Number(n & 127n) | 128); n >>= 7n; }
  return Buffer.from([...bytes, Number(n)]);
}
const field = (n, data) => Buffer.concat([vi(n * 8 + 2), vi(data.length), data]);
const retry = text => field(17, field(3, Buffer.from(text)));

test('SQLite decodes the final RetryInfo.error and clears an earlier failed retry after success', () => {
  const error = parseGenRow(3, field(1, retry('429 Too Many Requests')));
  assert.equal(error.requestError.kind, 'rate_limited');
  const recovered = parseGenRow(3, field(1, Buffer.concat([retry('ECONNRESET'), retry('')])));
  assert.equal(recovered.requestError.kind, 'none');
  const cancelled = parseGenRow(4, field(1, retry('context canceled by user')));
  assert.equal(cancelled.requestError.kind, 'canceled');
});
