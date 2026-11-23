import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const { parseQuotaScreen, readUsage, createCliQuotaReader } = createRequire(import.meta.url)('../ide/cli_quota.cjs');

const screen = `Models & Quota
Gemini Models
Weekly Limit Remaining
[████░] 67.76%
Refreshes in 5d 12h
Five Hour Limit Remaining
[█████] 100.00%
Claude and GPT models
Weekly Limit Remaining
[░░░░░] 0.00%
Five Hour Limit Remaining
Disabled: You have hit your weekly limit, the 5-hour limit does not currently apply.
Gemini 4 Argon Weekly Limit
[████░] 82.54%
Within each group, models share a weekly limit and a 5-hour limit.
0.0% (1.0M)`;

test('CLI quota parser preserves real zero, missing and disabled windows without guessing percentages', () => {
  const data = parseQuotaScreen(screen, 1700000000000);
  assert.deepEqual(data.groups.map(g => [g.displayName, g.buckets.map(b => [b.window, b.remainingFraction])]), [
    ['Gemini Models', [['weekly', 67.76 / 100], ['5h', 1]]],
    ['Claude and GPT models', [['weekly', 0]]],
    ['Gemini 4 Argon', [['weekly', .8254]]],
  ]);
  assert.deepEqual(data.unavailable, [{ displayName: 'Claude and GPT models', window: '5h', reason: 'disabled-without-percentage' }]);
  assert.equal(data.groups[0].buckets[0].resetTime, new Date(1700000000000 + (5 * 24 + 12) * 3600000).toISOString());
  assert.deepEqual(parseQuotaScreen('Welcome\n0.0% (1.0M)').groups, []);
  assert.deepEqual(parseQuotaScreen('Gemini Models\nWeekly Limit Remaining\n[██] 101%').groups, []);
});

function fake(initial = '> Type your message', confirmed = true) {
  let terminal, onData, exit, killed = false;
  const writes = [];
  class Terminal {
    constructor({ rows }) { this.rows = rows; this.text = ''; terminal = this; this.buffer = { active: { viewportY: 0, getLine: i => ({ translateToString: () => this.text.split('\n')[i] || '' }) } }; }
    write(text) { this.text = text; }
    onData() { return { dispose() {} }; }
    dispose() {}
  }
  const pty = { spawn() { return {
    onData(fn) { onData = fn; queueMicrotask(() => fn(initial)); return { dispose() {} }; },
    onExit(fn) { exit = fn; },
    write(text) { writes.push(text); if (text === '/usage') onData(confirmed ? '> /usage\n/usage  View model quota usage' : '> /usage'); else if (text === '\r') onData(screen); },
    kill() { killed = true; exit?.(); },
  }; } };
  return { pty, Terminal, writes, killed: () => killed };
}

test('CLI reader executes only confirmed slash command and always tears down its private terminal', async () => {
  const f = fake();
  const result = await readUsage({ ...f, cliPath: 'agy', cwd: '.', pollMs: 1, timeoutMs: 100 });
  assert.equal(result.status, 'ok'); assert.equal(result.groups.length, 3);
  assert.equal(result.source, 'Antigravity CLI current account');
  assert.deepEqual(f.writes, ['/usage', '\r']); assert.equal(f.killed(), true);
});

test('CLI reader neither accepts trust/login prompts nor submits unrecognized text', async () => {
  for (const gate of ['Do you trust this folder?', 'Sign in to continue']) {
    const f = fake(gate);
    await assert.rejects(readUsage({ ...f, cliPath: 'agy', cwd: '.', pollMs: 1, timeoutMs: 30 }), { reason: 'interaction-required' });
    assert.deepEqual(f.writes, []); assert.equal(f.killed(), true);
  }
  const f = fake(undefined, false);
  await assert.rejects(readUsage({ ...f, cliPath: 'agy', cwd: '.', pollMs: 1, timeoutMs: 30 }), { reason: 'timeout' });
  assert.deepEqual(f.writes, ['/usage']); assert.equal(f.killed(), true);
});

test('manual reader caches one successful request briefly and does not start a polling process', async () => {
  const f = fake(); let now = 1700000000000;
  const reader = createCliQuotaReader({ appRoot: '.', cliPath: 'agy', cwd: '.', now: () => now, dependencies: f });
  const first = reader.refresh(), second = reader.refresh();
  assert.equal(first, second);
  assert.equal((await first).status, 'ok');
  assert.equal(await reader.refresh(), await first);
  assert.deepEqual(f.writes, ['/usage', '\r']);
  now += 30001; await reader.refresh();
  assert.deepEqual(f.writes, ['/usage', '\r', '/usage', '\r']);
});
