import test from 'node:test';
import assert from 'node:assert/strict';
import { activeId, windowId, conversationPath, modelQuotas } from '../ide/host.mjs';

const vi = n => n < 128 ? [n] : [128 | (n & 127), ...vi(n >>> 7)];
const field = (key, val) => Buffer.concat([Buffer.from([...vi(key * 8 + 2), ...vi(val.length)]), Buffer.from(val)]);
const row = id => ({ value: field(3, id).toString('base64') });

test('IDE follows only this window; empty, stale and malformed selections cannot point elsewhere', () => {
  const rows = { 1: row('chat-one'), 4: row('chat-four') };
  assert.equal(activeId(rows, windowId('C:\\profile\\logs\\date\\window4\\exthost\\lumidarin.agy-capsule-ide')), 'chat-four');
  assert.equal(activeId(rows, windowId('/logs/date/window2/exthost/lumidarin.agy-capsule-ide')), '');
  assert.equal(activeId(rows, undefined), '');
  assert.equal(activeId({ 1: row('../other') }, '1'), '');
  assert.equal(conversationPath('IDE', '../Desktop/chat'), null);
});

test('IDE model quota preserves measured zero and ignores missing percentages', () => {
  const quota = Buffer.alloc(5); quota[0] = 13; quota.writeFloatLE(0.625, 1);
  const model = (name, info) => field(1, Buffer.concat([field(1, name), field(15, info)]));
  const data = field(33, Buffer.concat([model('A', quota), model('B', [13, 0, 0, 0, 0]), model('C', [])]));
  assert.deepEqual(modelQuotas(data.toString('base64')), [
    { label: 'A', percent: 63, reset: null }, { label: 'B', percent: 0, reset: null },
  ]);
  assert.deepEqual(modelQuotas(''), []);
});
import { ideComposerSession } from '../ide/composer.mjs';
import { copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

test('IDE targets only this workspace chat iframe and its own ready server announcement', t => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-ide-cdp-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const host = join(dir, 'logs', 'date', 'window3', 'exthost');
  const out = join(host, 'output_logging_20261122T180410');
  mkdirSync(out, { recursive: true });
  const uri = 'file:///e%3A/code/agy-capsule';
  const session = ideComposerSession(join(host, 'lumidarin.agy-capsule-ide'), [uri]);
  assert.equal(session.portFile, join(dir, 'DevToolsActivePort'));
  assert.equal(session.composerOrigin(), null);
  writeFileSync(join(out, '2-Antigravity.log'), '[LAUNCH] Server at http://127.0.0.1:9559 is READY after 2 attempt(s).\r\n');
  assert.equal(session.composerOrigin(), 'http://127.0.0.1:9559');
  const url = new URL(session.composerOrigin() + '/c/fixture');
  url.search = new URLSearchParams({ extensionView: 'true', extensionVariant: 'vs-code', hostVariant: 'antigravity-ide', workspaceUri: uri });
  assert.equal(session.isComposerTarget({ url: url.href, type: 'iframe' }), true);
  assert.equal(session.isComposerTarget({ url: url.href, type: 'page' }), false);
  url.searchParams.set('workspaceUri', 'file:///elsewhere');
  assert.equal(session.isComposerTarget({ url: url.href, type: 'iframe' }), false);
});

test('IDE packager includes every transitive module required by ide/extension.cjs', async t => {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  const python = process.platform === 'win32' ? 'python' : 'python3';
  const listed = execFileSync(python, [join(repoRoot, 'scripts', 'package-ide.py'), '--list'], { encoding: 'utf8' })
    .trim().split(/\r?\n/).filter(Boolean).map(line => line.split(' -> '));
  const staged = mkdtempSync(join(tmpdir(), 'agy-ide-stage-'));
  t.after(() => rmSync(staged, { recursive: true, force: true }));
  const dstSet = new Set();
  for (const [src, dst] of listed) {
    dstSet.add(dst);
    const target = join(staged, dst);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repoRoot, src), target);
  }
  assert.ok(dstSet.has('agy-capsule/sidecars/agy_capsule/loopback_fetch.mjs'));
  assert.ok(dstSet.has('agy-capsule/sidecars/agy_capsule/agent_entry.mjs'));
  assert.ok(!dstSet.has('agy-capsule/sidecars/agy_capsule/server.mjs'));
  for (const rel of [
    'ide/host.mjs', 'ide/sidebar.mjs', 'ide/composer.mjs', 'ide/data_roots.mjs', 'ide/cloud.mjs', 'ide/billing.mjs',
    'agy-capsule/sidecars/agy_capsule/deck_injector.mjs', 'agy-capsule/sidecars/agy_capsule/settings.mjs',
    'agy-capsule/sidecars/agy_capsule/conversation_db.mjs', 'agy-capsule/sidecars/agy_capsule/sqlite_cache.mjs',
    'agy-capsule/sidecars/agy_capsule/usage_history.mjs', 'agy-capsule/sidecars/agy_capsule/ui.mjs',
  ]) {
    await import(pathToFileURL(join(staged, rel)).href);
  }
});
