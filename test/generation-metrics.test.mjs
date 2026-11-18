import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGenRow } from '../agy-capsule/sidecars/agy_capsule/server.mjs';
import { summarizeGeneration, summarizeTurnSpeed } from '../agy-capsule/sidecars/agy_capsule/metrics.mjs';
import { createPresentation } from '../agy-capsule/sidecars/agy_capsule/ui.mjs';

function vi(value) {
  let n = BigInt(value);
  const bytes = [];
  while (n >= 128n) { bytes.push(Number(n & 127n) | 128); n >>= 7n; }
  return Buffer.from([...bytes, Number(n)]);
}
const integer = (field, n) => Buffer.concat([vi(field * 8), vi(n)]);
const message = (field, data) => Buffer.concat([vi(field * 8 + 2), vi(data.length), data]);
const duration = (field, seconds, nanos) => message(field, Buffer.concat([integer(1, seconds), integer(2, nanos)]));

test('SQLite fields preserve response-only context accounting and decode total output plus exact nanosecond timing', () => {
  const usage = Buffer.concat([integer(2, 1000), integer(3, 1000), integer(9, 700), integer(10, 300)]);
  const row = parseGenRow(4, message(1, Buffer.concat([message(4, usage), duration(11, 5, 250000000), duration(12, 1, 750000000)])));
  assert.equal(row.contextTokens, 1000);
  assert.equal(row.outTokens, 300);
  assert.equal(row.thinkTokens, 700);
  const g = summarizeGeneration(row.generation);
  assert.equal(g.ttft, 5.25);
  assert.equal(g.streaming, 1.75);
  assert.equal(g.duration, 7);
  assert.equal(g.output, 1000);
  assert.equal(g.reply + g.thinking, g.output);
  assert.equal(g.tps, 1000 / 7);
  assert.notEqual(g.tps, 1000 / 1.75);
  assert.equal('activeSteps' in g, false);
  assert.equal('totalSteps' in g, false);
});

test('preflight and partial timings do not invent zero output, duration or speed', () => {
  const row = parseGenRow(5, message(1, message(4, integer(2, 2000))));
  const pending = summarizeGeneration(row.generation);
  assert.equal(pending.output, null);
  assert.equal(pending.tps, null);
  assert.equal(pending.duration, null);
  assert.equal(summarizeGeneration({ output: 200, ttft: 2 }).duration, null);
  assert.equal(summarizeGeneration({ output: 200, ttft: 2 }).tps, null);
  assert.equal(summarizeGeneration({ output: 200, ttft: 0, streaming: 0 }).tps, null);
  assert.equal(summarizeGeneration({ output: 200, reply: 200, thinking: 40 }).reply, null);
});

test('zero-second protobuf duration is real zero; missing duration remains unknown', () => {
  const row = parseGenRow(6, message(1, Buffer.concat([message(4, Buffer.concat([integer(3, 20), integer(10, 20)])), message(11, Buffer.alloc(0)), duration(12, 1, 0)])));
  const g = summarizeGeneration(row.generation);
  assert.equal(g.ttft, 0);
  assert.equal(g.duration, 1);
  assert.equal(g.tps, 20);
  assert.equal(g.thinking, 0);
});

test('shared display uses one-decimal uppercase K/M, safe carry, and truthful output split', () => {
  const ui = createPresentation();
  for (const [value, expected] of [[0, '0'], [200, '200'], [1000, '1.0K'], [99900, '99.9K'], [99960, '100K'], [128000, '128K'], [255500, '256K'], [512000, '512K'], [999960, '1.0M'], [1200000, '1.2M'], [null, '—']]) assert.equal(ui.formatTokens(value), expected);
  const view = ui.generationText(summarizeGeneration({ output: 1000, reply: 300, thinking: 700, ttft: 5.25, streaming: 1.75 }));
  assert.equal(view.speed, '142.9 tok/s');
  assert.equal(view.output, '1.0K');
  assert.match(view.outputTitle, /300 \+ Thinking 700/);
  assert.match(view.totalTimeTitle, /Request duration 7.0s/);
  assert.equal(view.ttft, '5.3s');
  assert.equal(view.totalTime, '7.0s');
  assert.equal(view.timing, '5.3s–7.0s');
  assert.match(view.ttftTitle, /First-token wait to total duration/);
  assert.equal('steps' in view, false);
  assert.doesNotMatch(ui.generationMarkup(), /steps|compaction|output|totalTime|generation-heading/);
});

test('speed tooltips round seconds for display without rounding the rate or the fallback threshold', () => {
  const ui = createPresentation();
  const view = (output, ttft, streaming) => ui.generationText(summarizeGeneration({ output, ttft, streaming }));
  assert.equal(view(800, 2.318472915, 9.734820117).speedTitle, 'Speed 66.4 tok/s = Out 800 / (TTFT 2.32s + Stream 9.73s)');
  const short = view(40, 1, 0.004);
  assert.match(short.streamSpeedTitle, /too short \(0\.01s\)/);
  assert.equal(short.streamSpeed, '*39.8 tok/s');
  assert.equal(view(10, 1, 0.0504).streamSpeed, '198.4 tok/s');
});

test('stream fallback marks the total rate and explains the actual denominator', () => {
  const ui = createPresentation();
  const view = (output, streaming, ttft = 1) => ui.generationText(summarizeGeneration({ output, ttft, streaming }));
  for (const [output, streaming, speed] of [[40, 0.5, '80.0'], [50, 0.1, '500.0']]) {
    const v = view(output, streaming);
    assert.equal(v.streamSpeed, speed + ' tok/s');
    assert.match(v.streamSpeedTitle, /^Stream .* = Out .* \/ Stream /);
    assert.ok(!v.speed.startsWith('*'));
  }
  for (const [output, streaming, speed, denominator, reason] of [
    [10, 0.05, '9.5', '1.05', 'too short (0.05s)'],
    [40, 0.04, '38.5', '1.04', 'too short (0.04s)'],
    [40, 0, '40.0', '1.00', 'too short (0.00s)'],
    [51, 0.1, '46.4', '1.10', 'exceeds 500 tok/s'],
  ]) {
    const v = view(output, streaming);
    assert.equal(v.streamSpeed, '*' + speed + ' tok/s');
    assert.equal(v.speed, speed + ' tok/s');
    assert.ok(v.streamSpeedTitle.includes(reason));
    assert.ok(v.streamSpeedTitle.endsWith(output + ' / ' + denominator + 's = ' + v.streamSpeed));
    assert.ok(v.speedTitle.startsWith('Speed ' + v.speed + ' = Out '));
    assert.doesNotMatch(v.speedTitle, /\*|too short|exceeds/);
  }
  const noDuration = view(40, 0, 0);
  assert.equal(noDuration.streamSpeed, '—');
  assert.doesNotMatch(noDuration.streamSpeedTitle, /\//);
});

test('request associations decode both packed and unpacked generated step indices', () => {
  const chat = message(1, message(4, integer(3, 100)));
  assert.deepEqual(parseGenRow(0, Buffer.concat([chat, message(2, Buffer.concat([vi(21), vi(22)]))])).stepIndices, [21, 22]);
  assert.deepEqual(parseGenRow(0, Buffer.concat([chat, integer(2, 21), integer(2, 22)])).stepIndices, [21, 22]);
});

const request = (index, lastStepIndex, responseIndex, output = 200) => ({
  lastStepIndex, stepIndices: [responseIndex], requestError: { kind: 'none' },
  generation: { requestIndex: index, ttft: 1, streaming: 1, output, reply: output, thinking: 0 },
});

test('turn speed clears on new user input, retains completed results through pending requests and tools, then updates', () => {
  const old = request(3, 17, 21, 800); // An older prompt can finish after a new user message.
  const first = request(4, 20, 22);
  const second = request(5, 23, 24, 300);
  const steps = [{ idx: 21, step_type: 15, status: 3 }, { idx: 22, step_type: 15, status: 8 }];
  assert.equal(summarizeTurnSpeed([old, first], steps, 20).generation, null);
  steps[1].status = 3; steps[1].completedAtMs = 1000;
  steps.push({ idx: 23, step_type: 132, status: 2 }, { idx: 24, step_type: 15, status: 8 });
  let view = summarizeTurnSpeed([old, first, second], steps, 20);
  assert.equal(view.generation.tps, 100);
  assert.equal(view.generation.requestIndex, 4);
  assert.equal(view.hasActiveStep, true);
  steps[2].status = 3; steps[3].status = 3; steps[3].completedAtMs = 2000;
  view = summarizeTurnSpeed([old, first, second], steps, 20);
  assert.equal(view.generation.tps, 150);
  assert.equal(view.completedAtMs, 2000);
  assert.equal(view.hasActiveStep, false);
  assert.equal(summarizeTurnSpeed([old, first, second], steps, 25).generation, null);
});

test('turn speed requires a completed associated response, prompt boundary and valid reported speed', () => {
  const completed = { idx: 22, step_type: 15, status: 3 };
  for (const bad of [
    { ...request(4, 20, 22), lastStepIndex: -1 },
    { ...request(4, 20, 22), stepIndices: [] },
    { ...request(4, 20, 22), requestError: { kind: 'network_error' } },
    { ...request(4, 20, 22), generation: { requestIndex: 4, output: 200, ttft: 1 } },
  ]) assert.equal(summarizeTurnSpeed([bad], [completed], 20).generation, null);
  assert.equal(summarizeTurnSpeed([request(4, 20, 22)], [{ ...completed, status: 7 }], 20).generation, null);
  assert.equal(summarizeTurnSpeed([], [], null), null);
  assert.equal(summarizeTurnSpeed([], [{ idx: 21, step_type: 14, status: 11 }], 20).hasActiveStep, false);
  assert.equal(summarizeTurnSpeed([], [{ idx: 21, step_type: 132, status: 11 }], 20).hasActiveStep, true);
});
