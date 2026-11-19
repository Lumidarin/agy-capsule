// Reproduce the v1.2.0 baseline: node scripts/replay-wait-audit.mjs <v1.2.0 checkout>
// Temporary DBs only. No host plugin, server, CDP, credentials or provider calls.
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

assert.ok(process.argv[2], 'Pass the path to a v1.2.0 checkout');
const root = resolve(process.argv[2], 'agy-capsule/sidecars/agy_capsule');
const { readConversationSnapshot } = await import(pathToFileURL(join(root, 'server.mjs')));
const { createPresentation } = await import(pathToFileURL(join(root, 'ui.mjs')));
const ui = createPresentation();
const dir = mkdtempSync(join(tmpdir(), 'agy-wait-audit-'));

function varint(value) {
  let n = BigInt(value);
  const bytes = [];
  while (n >= 128n) {
    bytes.push(Number(n & 127n) | 128);
    n >>= 7n;
  }
  return Buffer.from([...bytes, Number(n)]);
}
const cat = (...buffers) => Buffer.concat(buffers);
const integer = (key, value) => cat(varint(key * 8), varint(value));
const field = (key, value) => cat(varint(key * 8 + 2), varint(value.length), value);
const stamp = (key, sec) => field(key, cat(integer(1, Math.floor(sec)), integer(2, Math.round((sec % 1) * 1e9))));
function step(idx, type, status, created, generating, completed) {
  const metadata = [stamp(1, created)];
  if (generating != null) metadata.push(field(26, field(1, cat(integer(1, 8), stamp(2, generating)))));
  if (completed != null) metadata.push(stamp(8, completed));
  return [idx, type, status, cat(...metadata)];
}
function request(last, steps, ttft, retries = []) {
  const fields = [];
  if (last != null) fields.push(field(20, cat(field(1, Buffer.from('last_step_index')), field(2, Buffer.from(String(last))))));
  if (ttft != null) fields.push(stamp(11, ttft));
  for (const message of retries) fields.push(field(17, field(3, Buffer.from(message))));
  return cat(field(1, cat(...fields)), ...steps.map(id => integer(2, id)));
}
let idx = 0;
function replay(name, {steps, rows = [], finish, now = 150, running = false}, label, waits) {
  const path = join(dir, ++idx + '.db');
  const db = new DatabaseSync(path);
  try {
    db.exec('CREATE TABLE steps(idx INTEGER PRIMARY KEY,step_type,status,metadata); CREATE TABLE gen_metadata(idx INTEGER PRIMARY KEY,data); CREATE TABLE executor_metadata(idx INTEGER PRIMARY KEY,data)');
    for (const s of steps) db.prepare('INSERT INTO steps VALUES(?,?,?,?)').run(...s);
    rows.forEach((r, i) => db.prepare('INSERT INTO gen_metadata VALUES(?,?)').run(i, r));
    if (finish != null) db.prepare('INSERT INTO executor_metadata VALUES(0,?)').run(cat(integer(1, 4), integer(3, finish)));
  } finally { db.close(); }
  const data = readConversationSnapshot(path);
  const view = ui.alertView(data, {}, ui.dictionaries['zh-CN'], now * 1000, running);
  assert.equal(view.label, label, name);
  assert.deepEqual(data.turnQueue?.waits ?? [], waits, name);
  console.log(JSON.stringify({name, boundary: data.turnQueue?.userStepIndex, waits, anchorSec: data.turnQueue?.waitingSinceMs / 1000 || null, liveSec: view.liveWaitSec, label: view.label, diagnostic: view.diagnostic, recordedAttempts: data.turnMetrics?.knownRequestCount}));
}
const user = step(10, 14, 3, 100);
const pending = step(11, 15, 2, 100);
const stream = step(11, 15, 8, 100, 140);
const done = step(11, 15, 3, 100, 140, 145);
const slow = request(10, [11], 40);
try {
  // Counterfactual explanations of ONE identical input, never saved to SQLite.
  for (const cause of ['queue hypothesis', 'prefill hypothesis', 'network hypothesis']) {
    replay(cause, {steps: [user, done], rows: [slow], finish: 11}, '排队', [40]);
  }
  replay('live 29.999 seconds', {steps: [user, pending], now: 129.999}, '', []);
  replay('live exactly 30 seconds', {steps: [user, pending], now: 130}, '排队 30s', []);
  replay('recorded 29.999 seconds', {steps: [user, done], rows: [request(10, [11], 29.999)], finish: 11}, '', [29.999]);
  replay('recorded exactly 30 seconds', {steps: [user, done], rows: [request(10, [11], 30)], finish: 11}, '排队', [30]);
  replay('active tool only', {steps: [user, step(11, 132, 2, 100)], running: true}, '', []);
  replay('tool active with slow history', {steps: [user, done, step(12, 132, 2, 146)], rows: [slow], running: true, now: 210}, '排队', [40]);
  replay('tool ended at 145; no RPC row; Working', {steps: [user, step(11, 132, 3, 100, null, 145)], running: true, now: 185}, '排队 40s', []);
  replay('tool done; end timestamp missing', {steps: [user, step(11, 132, 3, 100)], running: true, now: 185}, '排队 85s', []);
  replay('streaming fallback; no TTFT', {steps: [user, stream], now: 200, running: true}, '排队', [40]);
  replay('same planner after TTFT arrives', {steps: [user, stream], rows: [request(10, [11], 2)], now: 200, running: true}, '', [2]);
  replay('missing step linkage', {steps: [user, done], rows: [request(10, [], 40)], finish: 11}, '排队×2', [40, 40]);
  replay('pending status with matching TTFT', {steps: [user, pending], rows: [slow], now: 140}, '排队×2 40s', [40]);
  replay('three attempts in one gen row', {steps: [user, done], rows: [request(10, [11], 40, ['ECONNRESET', '429 Too Many Requests', ''])], finish: 11}, '排队', [40]);
  replay('two rows with their own TTFT', {steps: [user, done, step(12, 15, 3, 150, 195, 200)], rows: [slow, request(11, [12], 45)], finish: 12, now: 220}, '排队×2', [40, 45]);
  replay('two 20s waits do not accumulate', {steps: [user, done, step(12, 15, 3, 150, 170, 175)], rows: [request(10, [11], 20), request(11, [12], 20)], finish: 12, now: 180}, '', [20, 20]);
  replay('retry durations absent', {steps: [user], rows: [request(10, [], null, ['ECONNRESET', 'ECONNRESET', ''])], now: 200}, '', []);
  replay('failure priority', {steps: [user, done], rows: [request(10, [11], 40, ['429 Too Many Requests'])], finish: 11}, '429 限流', [40]);
  replay('queued next user input', {steps: [user, done, step(12, 14, 11, 143)], rows: [slow], finish: 11}, '排队', [40]);
  replay('next input consumed', {steps: [user, done, step(12, 14, 3, 143)], rows: [slow], now: 150, running: true}, '', []);
  replay('consumed input retains old creation time', {steps: [user, done, step(12, 14, 3, 143)], rows: [slow], now: 190, running: true}, '排队 47s', []);
  replay('prior turn error masks a new slow planner', {steps: [user, done, step(20, 14, 3, 150), step(21, 15, 2, 151)], rows: [request(10, [11], 40, ['429 Too Many Requests'])], now: 191}, '429 限流', []);
  replay('TTFT with missing turn and no planner timing', {steps: [user, step(11, 15, 3, 100, null, 145)], rows: [request(null, [11], 40)], finish: 11}, '', []);
  replay('older request produces a late planner', {steps: [user, step(20, 14, 3, 130), step(21, 15, 3, 131, 171, 173)], rows: [request(10, [21], 40)], finish: 21, now: 175}, '排队', [40]);
} finally { rmSync(dir, {recursive: true, force: true}); }
