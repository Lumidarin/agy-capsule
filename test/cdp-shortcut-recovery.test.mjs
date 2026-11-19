import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import { closeSync, mkdirSync, mkdtempSync, openSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createCdpNoticeManager } from '../agy-capsule/sidecars/agy_capsule/cdp_notice.mjs';

function tempRoot(t) {
  const root = mkdtempSync(join(tmpdir(), "agy cdp's "));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}

test('a successful CDP connection does not overwrite a missing shortcut scan', async t => {
  let scanResult = 'missing';
  const manager = createCdpNoticeManager({
    platform: 'win32', statePath: join(tempRoot(t), 'state.json'),
    execFileImpl: (_file, _args, _opts, cb) => cb(null, scanResult),
  });
  await manager.checkShortcuts();
  manager.observe('ok');
  manager.observe('unreachable');
  assert.deepEqual(manager.info(), {
    state: 'unreachable', hadBefore: true, shortcutState: 'missing', canFixShortcut: true,
  });
  scanResult = 'ok';
  assert.equal(await manager.checkShortcuts(), 'ok');
  assert.deepEqual(manager.info(), {
    state: 'unreachable', hadBefore: true, shortcutState: 'ok', canFixShortcut: false,
  });
});

const windowsOnly = { skip: process.platform !== 'win32' };

function fixturePowerShell(body, env = {}) {
  const command = "$ErrorActionPreference = 'Stop'\n" + body;
  return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand',
    Buffer.from(command, 'utf16le').toString('base64')], { encoding: 'utf8', env: { ...process.env, ...env } }).replace(/\r?\n$/, '');
}

function windowsFixture(t) {
  const root = tempRoot(t);
  const desktop = join(root, 'Desktop');
  const menu = join(root, 'Start Menu');
  const programs = join(menu, 'Programs');
  mkdirSync(desktop);
  mkdirSync(programs, { recursive: true });
  const exe = join(root, 'Antigravity.exe');
  writeFileSync(exe, '');
  const scriptErrors = [];
  t.after(() => assert.deepEqual(scriptErrors, []));
  const manager = createCdpNoticeManager({
    statePath: join(root, 'state.json'), shortcutDirectories: [desktop, menu],
    getPrefs: () => ({ notifyCdpRestart: false }),
    execFileImpl(file, args, opts, cb) {
      // Fail before spawning if either script ever falls back to real shell folders.
      assert.equal(file, 'powershell.exe');
      assert.doesNotMatch(args.at(-1), /GetFolderPath|\$env:APPDATA/i);
      assert.deepEqual(JSON.parse(opts.env.AGY_CDP_TEST_ROOTS), [desktop, menu]);
      return execFile(file, args, opts, (err, stdout, stderr) => {
        if (err || stderr.trim()) scriptErrors.push(stderr || err.message);
        cb(err, stdout, stderr);
      });
    },
  });
  function link(dir, name, args, target = exe) {
    const file = join(dir, name + '.lnk');
    fixturePowerShell(`$l = (New-Object -ComObject WScript.Shell).CreateShortcut($env:LINK_FILE)
$l.TargetPath = $env:LINK_TARGET
$l.Arguments = [string]$env:LINK_ARGS
$l.Save()`, { LINK_FILE: file, LINK_TARGET: target, LINK_ARGS: args });
    return file;
  }
  return { root, desktop, programs, manager, link };
}

function readArgs(file) {
  return fixturePowerShell('(New-Object -ComObject WScript.Shell).CreateShortcut($env:LINK_FILE).Arguments', { LINK_FILE: file });
}

test('sidebar scans and repairs only matching links, preserves arguments, and handles an empty match set', windowsOnly, async t => {
  const { root, desktop, programs, manager, link } = windowsFixture(t);
  const flag = '--remote-debugging-port=0';
  const original = '--profile "Work Space"  --disable-gpu';
  const plain = link(desktop, 'Plain', '');
  const quoted = link(programs, 'Quoted args', original);
  const configured = link(programs, 'Configured', flag + ' --disable-gpu');
  const otherExe = join(root, 'Uninstall Antigravity.exe');
  writeFileSync(otherExe, '');
  const unrelated = link(desktop, 'Antigravity', '--keep', otherExe);

  assert.equal(await manager.checkShortcuts(), 'missing');
  assert.deepEqual(await manager.fixShortcuts(), { ok: true, updated: 2, failed: 0, total: 3, shortcutState: 'ok' });
  assert.equal(readArgs(plain), flag);
  assert.equal(readArgs(quoted), original + ' ' + flag);
  assert.equal(readArgs(configured), flag + ' --disable-gpu');
  assert.equal(readArgs(unrelated), '--keep');
  assert.equal(await manager.checkShortcuts(), 'ok');
  manager.observe('unreachable');
  assert.deepEqual(manager.info(), { state: 'unreachable', hadBefore: true, shortcutState: 'ok', canFixShortcut: false });
  assert.deepEqual(await manager.fixShortcuts(), { ok: true, updated: 0, failed: 0, total: 3, shortcutState: 'ok' });
  assert.equal(readArgs(quoted), original + ' ' + flag);

  for (const file of [plain, quoted, configured]) rmSync(file);
  assert.equal(await manager.checkShortcuts(), 'unknown');
  assert.deepEqual(await manager.fixShortcuts(), { ok: false, updated: 0, failed: 0, total: 0, shortcutState: 'unknown' });
  assert.equal(manager.info().canFixShortcut, false);
  assert.equal(readArgs(unrelated), '--keep');
});

test('sidebar reports partial repair on access denied and can retry after write access returns', windowsOnly, async t => {
  const { desktop, programs, manager, link } = windowsFixture(t);
  const blocked = link(programs, 'Protected', '--keep');
  const writable = link(desktop, 'Writable', '');
  const sid = '*' + fixturePowerShell('[Security.Principal.WindowsIdentity]::GetCurrent().User.Value');
  // Deny writes and replacement of links only inside the disposable Programs directory.
  execFileSync('icacls.exe', [programs, '/deny', sid + ':(OI)(CI)(WD,AD,WEA,WA,DE,DC)']);
  try {
    assert.throws(() => closeSync(openSync(blocked, 'r+')), { code: /^(EACCES|EPERM)$/ });
    assert.deepEqual(await manager.fixShortcuts(), { ok: false, updated: 1, failed: 1, total: 2, shortcutState: 'missing' });
    assert.equal(await manager.checkShortcuts(), 'missing');
    assert.equal(manager.info().canFixShortcut, true);
    assert.equal(readArgs(blocked), '--keep');
    assert.equal(readArgs(writable), '--remote-debugging-port=0');
  } finally {
    execFileSync('icacls.exe', [programs, '/remove:d', sid]);
  }
  assert.deepEqual(await manager.fixShortcuts(), { ok: true, updated: 1, failed: 0, total: 2, shortcutState: 'ok' });
  assert.equal(readArgs(blocked), '--keep --remote-debugging-port=0');
  assert.equal(await manager.checkShortcuts(), 'ok');
});
