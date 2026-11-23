import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveDataRoots, diagnoseConversation } from '../ide/data_roots.mjs';
import { ideComposerSession } from '../ide/composer.mjs';

const temporary = t => {
  const root = mkdtempSync(join(tmpdir(), 'agy-ide-roots-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
};

test('IDE data override is an explicit absolute product root, not a fallback search', t => {
  const home = temporary(t), custom = join(home, 'custom profile');
  assert.equal(resolveDataRoots({ home }).directory, join(home, '.gemini', 'antigravity', 'conversations'));
  assert.equal(resolveDataRoots({ home, native: true }).directory, join(home, '.gemini', 'antigravity-ide', 'conversations'));
  const selected = resolveDataRoots({ home, native: true, dataDirectory: custom });
  assert.equal(selected.directory, join(custom, 'conversations'));
  for (const value of ['relative/profile', '~/.gemini/antigravity', false, {}]) {
    assert.equal(resolveDataRoots({ home, dataDirectory: value }).error, 'absolute-path-required');
  }
  if (process.platform === 'win32') for (const value of ['C:profile', '\\profile', '/profile']) {
    assert.equal(resolveDataRoots({ dataDirectory: value }).error, 'absolute-path-required');
  }
  mkdirSync(join(home, '.gemini', 'antigravity', 'conversations'), { recursive: true });
  writeFileSync(join(home, '.gemini', 'antigravity', 'conversations', 'same.db'), 'elsewhere');
  assert.equal(diagnoseConversation(selected, 'same').state, 'root-missing');
  assert.equal(diagnoseConversation(selected, 'same').path, null);
});

test('IDE distinguishes first-use folder, new chat and selected chat awaiting its own DB', t => {
  const home = temporary(t), roots = resolveDataRoots({ home });
  assert.deepEqual(diagnoseConversation(roots), { state: 'uninitialized', path: null });
  mkdirSync(roots.root, { recursive: true });
  assert.equal(diagnoseConversation(roots, 'pending').state, 'uninitialized');
  mkdirSync(roots.directory);
  writeFileSync(join(roots.directory, 'unrelated.db'), 'other chat');
  assert.deepEqual(diagnoseConversation(roots), { state: 'new-conversation', path: null });
  assert.equal(diagnoseConversation(roots, 'pending').state, 'waiting-for-data');
  const path = join(roots.directory, 'pending.db');
  writeFileSync(path, '');
  assert.equal(diagnoseConversation(roots, 'pending').state, 'waiting-for-data');
  writeFileSync(path, 'SQLite fixture');
  assert.deepEqual(diagnoseConversation(roots, 'pending'), { state: 'ready', path });
  assert.equal(diagnoseConversation(roots, '../unrelated').state, 'invalid-conversation');
});

test('IDE reports bad path shapes separately from chats with no recorded usage', t => {
  const home = temporary(t), file = join(home, 'file');
  writeFileSync(file, 'not a directory');
  assert.equal(diagnoseConversation(resolveDataRoots({ dataDirectory: file })).state, 'not-directory');
  assert.equal(diagnoseConversation(resolveDataRoots({ dataDirectory: 'relative' })).state, 'invalid-path');
  const root = join(home, 'root');
  mkdirSync(root); writeFileSync(join(root, 'conversations'), 'not a directory');
  assert.equal(diagnoseConversation(resolveDataRoots({ dataDirectory: root }), 'chat').state, 'not-directory');
});

test('IDE target selection reads the current multi-root workspace on every lookup', () => {
  const one = 'file:///e%3A/project-one', two = 'file:///e%3A/project-two';
  let folders = [one];
  const session = ideComposerSession('/logs/window1/exthost/capsule', () => folders);
  const target = uri => ({ type: 'iframe', url: 'http://127.0.0.1:9559/c/chat?' + new URLSearchParams({
    extensionView: 'true', hostVariant: 'antigravity-ide', extensionVariant: 'vs-code', workspaceUri: uri,
  }) });
  assert.equal(session.isComposerTarget(target(one)), true);
  assert.equal(session.isComposerTarget(target(two)), false);
  folders = [one, two];
  assert.equal(session.isComposerTarget(target(two)), true);
  folders = [two];
  assert.equal(session.isComposerTarget(target(one)), false);
  assert.equal(session.isComposerTarget(target(two)), true);
  folders = [];
  assert.equal(session.isComposerTarget(target(two)), false);
  assert.equal(session.isComposerTarget(target('')), true);
});

test('same-workspace composer frames are isolated by their trusted workbench window ID', async t => {
  const original = globalThis.WebSocket;
  t.after(() => { globalThis.WebSocket = original; });
  const endpoint = 'ws://127.0.0.1:49200', calls = [];
  const ids = new Map();
  class ProbeSocket {
    constructor(url) { this.url = url; queueMicrotask(() => this.onopen?.()); }
    send(raw) {
      const message = JSON.parse(raw); calls.push({ url: this.url, ...message });
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: message.id, result: { result: { value: ids.get(this.url) ?? null } } }) }));
    }
    close() {}
  }
  globalThis.WebSocket = ProbeSocket;
  const top = (id, window) => {
    const target = { id, type: 'page', url: 'vscode-file://vscode-app/c:/IDE/resources/app/out/vs/code/electron-browser/workbench/workbench.html',
      webSocketDebuggerUrl: endpoint + '/devtools/page/' + id };
    ids.set(target.webSocketDebuggerUrl, window);
    return target;
  };
  const one = top('top-one', 1), two = top('top-two', 2);
  const wrapper = (id, parentId) => ({ id, parentId, type: 'iframe', url: 'vscode-webview://' + id + '/index.html' });
  const wrapOne = wrapper('webview-one', one.id), wrapTwo = wrapper('webview-two', two.id);
  const sameChat = 'http://127.0.0.1:9559/c/chat?' + new URLSearchParams({ extensionView: 'true', hostVariant: 'antigravity-ide', extensionVariant: 'vs-code', workspaceUri: 'file:///same-project' });
  const a = { id: 'composer-a', parentId: wrapOne.id, type: 'iframe', url: sameChat };
  const b = { id: 'composer-b', parentId: wrapTwo.id, type: 'iframe', url: sameChat };
  const all = [a, b, one, two, wrapOne, wrapTwo];
  const session = ideComposerSession('/logs/window2/exthost/capsule', ['file:///same-project']);
  assert.equal(session.isComposerTarget(a), true);
  assert.equal(session.isComposerTarget(b), true);
  assert.deepEqual(await session.filterWindowTargets([a, b], all, endpoint), [b]);
  assert.equal(calls.length, 2);
  assert.ok(calls.every(c => c.method === 'Runtime.evaluate' && c.params.returnByValue === true && c.params.expression.includes('window.vscodeWindowId')));
  assert.deepEqual(await session.filterWindowTargets([a, b], all, endpoint), [b]);
  assert.equal(calls.length, 2, 'cache is scoped to the top-level target ID and debugger port');

  const invalidTop = [
    { ...two, url: 'https://preview.invalid/workbench.html' },
    { ...two, url: 'vscode-file://other-host/c:/IDE/out/vs/code/electron-browser/workbench/workbench.html' },
    { ...two, webSocketDebuggerUrl: 'ws://127.0.0.1:49999/devtools/page/top-two' },
    { ...two, webSocketDebuggerUrl: endpoint + '/devtools/page/not-top-two' },
  ];
  for (const invalid of invalidTop) {
    assert.deepEqual(await session.filterWindowTargets([b], [b, wrapTwo, invalid], endpoint), []);
  }
  assert.equal(calls.length, 2, 'untrusted top-level pages and mismatched debugger endpoints are never read');
  assert.deepEqual(await session.filterWindowTargets([b], [b, wrapTwo], endpoint), []);
  assert.deepEqual(await session.filterWindowTargets([b], all, 'ws://remote.invalid:49200'), []);
  ids.set(two.webSocketDebuggerUrl, null);
  assert.deepEqual(await session.filterWindowTargets([b], all, endpoint), [], 'unreadable window ID never mounts');
});
