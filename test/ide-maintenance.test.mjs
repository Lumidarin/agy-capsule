import test from 'node:test';
import { createHash } from 'node:crypto';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { checkIdeRelease, createMaintenance, repairIdeShortcuts } from '../ide/maintenance.cjs';
const listing = version => ({ namespace: 'lumidarin', name: 'agy-capsule-ide', version, preRelease: false, downloadable: true });
const fetchRelease = data => async () => ({ ok: true, json: async () => data });
test('Open VSX checks the correct stable extension and compares numeric versions', async () => {
  const result = await checkIdeRelease('0.2.9', fetchRelease(listing('0.2.10')));
  assert.deepEqual(result, { status: 'available', currentVersion: '0.2.9', version: '0.2.10' });
  for (const v of ['0.2.10','0.2.11']) assert.equal((await checkIdeRelease(v, fetchRelease(listing('0.2.10')))).status, 'current');
});
test('wrong publisher or extension, invalid versions and unreleased entries never offer an install', async () => {
  for (const change of [{ namespace: 'other' }, { name: 'other' }, { version: '9.0.0/../bad' }, { preRelease: true }, { downloadable: false }])
    assert.equal((await checkIdeRelease('0.2.0', fetchRelease({ ...listing('0.2.1'), ...change }))).status, 'error');
});
test('update failure is not reported as current or unpublished', async () => {
  assert.deepEqual(await checkIdeRelease('0.1.6', async () => { throw Error('offline'); }), { status: 'error', reason: 'network' });
});
function harness(everOk = false, notify = true) {
  const calls = [], state = new Map([['agyCapsule.cdpEverOk', everOk]]);
  const vscode = { env: { language: 'en', appRoot: 'C:/IDE/resources/app', openExternal: async u => calls.push(['open', u]) }, Uri: { parse: x => x },
    commands: { executeCommand: async (...args) => calls.push(['command', ...args]) }, window: { showInformationMessage: async (...args) => { calls.push(['notice', ...args]); return undefined; } } };
  const context = { globalState: { get: (k, d) => state.has(k) ? state.get(k) : d, update: async (k, v) => state.set(k, v) }, extension: { packageJSON: { version: '0.1.6' } } };
  return { calls, vscode, context, make: opts => createMaintenance({ vscode, context, getPrefs: () => ({ notifyCdpRestart: notify }), ...opts }) };
}
test('no first-install nag; only previously healthy debugging failures alert once', () => {
  const h = harness(); const m = h.make(); ['missing','missing','missing'].forEach(m.observeCdp); assert.equal(h.calls.length, 0);
  m.observeCdp('ok'); ['missing','missing','missing','missing'].forEach(m.observeCdp);
  assert.equal(h.calls.length, 1); assert.equal(h.calls[0][0], 'notice');
  assert.equal(h.calls[0].some(x => typeof x === 'object'), false, 'non-modal notice, no modal option');
});
test('disabled restart notices and disposed maintenance do not alert', () => {
  const h = harness(true, false), m = h.make(); ['unreachable','unreachable','unreachable'].forEach(m.observeCdp); assert.equal(h.calls.length, 0);
  m.dispose(); m.observeCdp('ok'); assert.equal(h.calls.length, 0);
});
test('a missing listing is not reported as current; native local installation remains independent', async () => {
  const h = harness(), m = h.make({ fetchImpl: async () => ({ ok: false, status: 404 }) });
  assert.equal((await m.checkUpdates({ manual: true })).reason, 'notListed'); assert.match(h.calls[0][1], /Could not confirm/);
  await m.installVsix(); assert.deepEqual(h.calls[1], ['command', 'workbench.extensions.action.installVSIX']);
});
test('Windows repair modifies only exact IDE target in isolated shortcut fixture', { skip: process.platform !== 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-maint-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const ide = join(root, 'Antigravity IDE.exe'), app = join(root, 'Antigravity.exe'), links = join(root, 'links'); mkdirSync(links);
  writeFileSync(ide, 'fixture'); writeFileSync(app, 'fixture');
  const ps = `$s=New-Object -ComObject WScript.Shell; $a=$s.CreateShortcut($env:LINK_IDE);$a.TargetPath=$env:EXE_IDE;$a.Arguments='--profile Work --user-data-dir="C:\\Profile With Spaces"';$a.Save();$b=$s.CreateShortcut($env:LINK_APP);$b.TargetPath=$env:EXE_APP;$b.Arguments='--keep-this';$b.Save()`;
  const env = { ...process.env, LINK_IDE: join(links, 'IDE.lnk'), EXE_IDE: ide, LINK_APP: join(links, 'App.lnk'), EXE_APP: app };
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(ps, 'utf16le').toString('base64')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const appBefore = readFileSync(env.LINK_APP), ideBefore = readFileSync(env.LINK_IDE);
  const scan = await repairIdeShortcuts({ executablePath: ide, roots: [links], scanOnly: true }); assert.equal(scan.total, 1); assert.equal(scan.status, 'missing'); assert.equal(scan.missing, 1); assert.deepEqual(readFileSync(env.LINK_IDE), ideBefore);
  const fixed = await repairIdeShortcuts({ executablePath: ide, roots: [links] }); assert.equal(fixed.updated, 1); assert.equal(fixed.failed, 0); assert.equal(fixed.missing, 0);
  assert.deepEqual(readFileSync(env.LINK_APP), appBefore);
  const read = `$s=New-Object -ComObject WScript.Shell;($s.CreateShortcut($env:LINK_IDE)).Arguments`;
  const args = execFileSync('powershell.exe', ['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(read, 'utf16le').toString('base64')], { env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], encoding: 'utf8' }).trim();
  assert.match(args, /^--profile Work --user-data-dir="C:\\Profile With Spaces"/); assert.match(args, /--remote-debugging-port=0/); assert.match(args, /--remote-debugging-address=127.0.0.1/);
  assert.equal((await repairIdeShortcuts({ executablePath: ide, roots: [links] })).updated, 0);
});

test('background notices stay cached, manual checks refresh Open VSX and only install on click', async () => {
  const h = harness(), requests = []; let v = '0.2.1', tick = 100;
  const fetchImpl = async (url, opts) => { requests.push(url); assert.equal(opts.cache, 'no-store'); return fetchRelease(listing(v))(); };
  const m = h.make({ fetchImpl, now: () => ++tick });
  await m.checkUpdates(); await m.checkUpdates(); assert.equal(requests.length, 1); assert.equal(h.calls.length, 1);
  assert.match(requests[0], /^https:\/\/open-vsx\.org\/api\/lumidarin\/agy-capsule-ide\/latest\?check=\d+$/);
  v = '0.2.2'; h.vscode.window.showInformationMessage = async (...args) => args.includes('Update now') ? 'Update now' : undefined;
  await m.checkUpdates({ manual: true }); assert.equal(requests.length, 2); assert.notEqual(requests[0], requests[1]);
  assert.deepEqual(h.calls[1], ['command', 'workbench.extensions.installExtension', 'lumidarin.agy-capsule-ide@0.2.2']);
  await h.make({ getPrefs: () => ({ notifyUpdates: false }), fetchImpl }).checkUpdates();
  h.context.extensionMode = 3; h.vscode.ExtensionMode = { Test: 3 }; await h.make({ fetchImpl }).checkUpdates();
  assert.equal(requests.length, 2);
});

test('only a missing gallery version falls back, and the Open VSX bytes must match the checksum', async () => {
  for (const mode of ['missing','bad digest','cancelled']) {
    const h = harness(), urls = [], installs = [], body = Buffer.from('store-package');
    h.vscode.Uri.file = path => ({ fsPath: path });
    h.vscode.window.showInformationMessage = async (_msg, action) => action === 'Update now' ? action : undefined;
    h.vscode.window.showWarningMessage = async () => {};
    h.vscode.commands.executeCommand = async (_cmd, arg) => {
      installs.push(arg);
      if (typeof arg === 'string') throw Object.assign(Error('gallery'), { name: mode === 'cancelled' ? 'Canceled' : 'NotFound' });
      assert.deepEqual(readFileSync(arg.fsPath), body);
    };
    const fetchImpl = async url => {
      if (url.includes('/latest?')) return fetchRelease(listing('0.2.1'))();
      urls.push(url); assert.ok(url.startsWith('https://open-vsx.org/api/lumidarin/agy-capsule-ide/0.2.1/file/lumidarin.agy-capsule-ide-0.2.1.'));
      return { ok: true, text: async () => mode === 'bad digest' ? '0'.repeat(64) : createHash('sha256').update(body).digest('hex'),
        arrayBuffer: async () => body };
    };
    const result = await h.make({ fetchImpl }).checkUpdates({ manual: true });
    assert.equal(result.status === 'error', mode !== 'missing'); assert.equal(installs.length, mode === 'missing' ? 2 : 1);
    assert.equal(urls.length, mode === 'cancelled' ? 0 : 2);
    if (installs[1]) assert.equal(existsSync(installs[1].fsPath), false);
  }
});
test('shortcut repair preserves non-loopback addresses and does not activate a debug port', { skip: process.platform !== 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'capsule-bind-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const ide = join(root, 'Antigravity IDE.exe'); writeFileSync(ide, 'fixture');
  const args = ['--profile Work --remote-debugging-address=0.0.0.0', '--remote-debugging-address 192.168.1.10 --profile Work', '--remote-debugging-address=127.0.0.1 --remote-debugging-address ::', '--remote-debugging-address'];
  for (let i = 0; i < args.length; i++) {
    const file = join(root, 'unsafe-' + i + '.lnk');
    const script = '$s=New-Object -ComObject WScript.Shell;$l=$s.CreateShortcut($env:LINK_FILE);$l.TargetPath=$env:IDE_EXE;$l.Arguments=$env:IDE_ARGS;$l.Save()';
    execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')], { env: { ...process.env, LINK_FILE: file, IDE_EXE: ide, IDE_ARGS: args[i] }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  }
  const before = args.map((_, i) => readFileSync(join(root, 'unsafe-' + i + '.lnk')));
  const result = await repairIdeShortcuts({ executablePath: ide, roots: [root] });
  assert.equal(result.status, 'partial'); assert.equal(result.manualAddress, args.length); assert.equal(result.updated, 0);
  before.forEach((bytes, i) => assert.deepEqual(readFileSync(join(root, 'unsafe-' + i + '.lnk')), bytes));
});
