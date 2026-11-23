import test from 'node:test';
import assert from 'node:assert/strict';
import Module, { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('composer mode never shows the status item, even at reload, with a pin or missing CDP', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'capsule-location-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'settings.json'), '{}');
  let location = 'composer', shows = 0, hides = 0, change;
  const sub = () => ({ dispose() {} }), commands = new Map();
  const api = {
    env: { language: 'en' }, ExtensionMode: { Test: 3 }, StatusBarAlignment: { Right: 2 },
    workspace: { workspaceFolders: [], getConfiguration: () => ({
      get: (k,v) => k === 'location' ? location : v, inspect: () => ({ globalValue: dir }) }),
      onDidChangeWorkspaceFolders: sub, onDidChangeConfiguration(fn) { change = fn; return sub(); } },
    window: { state: { focused: true }, createStatusBarItem: () => ({ ...sub(), show() { shows++; }, hide() { hides++; } }),
      registerWebviewViewProvider: sub, onDidChangeWindowState: sub },
    commands: { registerCommand(name,fn) { commands.set(name,fn);return sub(); } },
  };
  const require = createRequire(import.meta.url), load = Module._load;
  let extension;
  try { Module._load = function(name,...args) { return name === 'vscode' ? api : load.call(this,name,...args); };
    extension = require('../ide/extension.cjs');
  } finally { Module._load = load; }
  const context = { extensionMode: 3, extension: { packageJSON: {version:'test'} }, subscriptions: [],
    globalState: {get:(k,v)=>v}, workspaceState: {get:()=> 'pinned-test'}, globalStorageUri: {fsPath: dir},
    logUri: {fsPath: join(dir,'logs','date','window1','exthost','lumidarin.agy-capsule-ide')} };
  try {
    await extension.activate(context);
    // Allow one full CDP discovery poll, including a failed launch.
    await new Promise(r=>setTimeout(r,1150));
    assert.equal(shows,0);
    assert.ok(commands.has('agyCapsule.details'));
    location='statusBar';change({affectsConfiguration:k=>k==='agyCapsule.location'||k==='agyCapsule'});
    assert.ok(shows>0,'explicit opt-in still works');
    const previous=shows;location='composer';change({affectsConfiguration:k=>k==='agyCapsule.location'||k==='agyCapsule'});
    assert.equal(shows,previous);
    assert.ok(hides>0);
  } finally { await extension.deactivate(); for (const entry of context.subscriptions) entry.dispose(); }
});
