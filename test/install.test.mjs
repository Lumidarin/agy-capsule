import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('Windows install/update/uninstall syncs plugin files and keeps preferences', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'agy installer '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const plugins = join(root, '.gemini', 'config', 'plugins');
  const settingsDirectory = join(root, '.gemini', 'config', 'agy-capsule');
  mkdirSync(settingsDirectory, { recursive: true });
  const settingsFile = join(settingsDirectory, 'settings.json');
  writeFileSync(settingsFile, '{"language":"zh-CN"}');
  const destination = join(plugins, 'agy-capsule');
  const script = fileURLToPath(new URL('../scripts/manage-plugin.ps1', import.meta.url));
  const run = action => {
    const result = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script, '-Action', action, '-PluginsDirectory', plugins], { encoding: 'utf8' });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  run('install');
  assert.ok(existsSync(join(destination, 'plugin.json')));
  assert.ok(existsSync(join(destination, 'sidecars', 'agy_capsule', 'reload.mjs')));
  assert.equal(existsSync(join(destination, '.update-in-progress')), false);
  const serverFile = join(destination, 'sidecars', 'agy_capsule', 'server.mjs');
  writeFileSync(serverFile, '// outdated installed code');
  writeFileSync(join(destination, 'stale-file.txt'), 'left over from an old version');
  run('install');
  assert.equal(readFileSync(serverFile, 'utf8'), readFileSync(new URL('../agy-capsule/sidecars/agy_capsule/server.mjs', import.meta.url), 'utf8'));
  assert.equal(existsSync(join(destination, 'stale-file.txt')), false);
  assert.equal(existsSync(join(destination, '.update-in-progress')), false);
  run('uninstall');
  assert.equal(existsSync(destination), false);
  assert.equal(readFileSync(settingsFile, 'utf8'), '{"language":"zh-CN"}');
  run('uninstall');
});
