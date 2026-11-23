import test from 'node:test';
import assert from 'node:assert/strict';
import { readAgentState, AGENT_ENTRY_CSS } from '../agy-capsule/sidecars/agy_capsule/agent_entry.mjs';

function composer(selectorProps) {
  const calls = [];
  const props = {
    agentScriptsEnabled: true,
    selectedAgentScriptItem: undefined,
    isLoadingAgentScripts: false,
    agentScriptsError: null,
    refreshAgentScripts() { calls.push(['refresh']); },
    setSelectedAgentScriptItem(...args) { calls.push(['select', ...args]); },
    agentCustomizations: [
      { path: 'file:///a/reviewer.md', agent: { name: 'reviewer', description: 'Reviews diffs', disabled: false } },
      { path: 'file:///a/off.md', agent: { name: 'off', description: '', disabled: true } },
      { path: 'file:///a/writer.md', agent: { name: 'writer', disabled: false } },
    ],
    ...selectorProps,
  };
  const box = { memoizedProps: { agentSelector: { props } } };
  const leaf = { memoizedProps: { placement: 'top' }, return: { memoizedProps: {}, return: box } };
  return { trigger: { __reactFiber$x: leaf }, props, calls };
}

test('readAgentState lists enabled custom agents from the host selector', () => {
  const { trigger } = composer();
  const state = readAgentState(trigger);
  assert.deepEqual(state.items, [
    { name: 'reviewer', description: 'Reviews diffs', path: 'file:///a/reviewer.md' },
    { name: 'writer', description: '', path: 'file:///a/writer.md' },
  ]);
  assert.equal(state.selected, null);
});

test('readAgentState chooses through the host and maps null to Main Agent', () => {
  const { trigger, props, calls } = composer();
  const state = readAgentState(trigger);
  state.choose('writer');
  state.choose(null);
  state.choose('off');
  assert.equal(calls.length, 2);
  assert.equal(calls[0][1], props.agentCustomizations[2].agent);
  assert.equal(calls[0][2], 'file:///a/writer.md');
  assert.deepEqual(calls[1], ['select', undefined]);
});

test('readAgentState reports the current custom agent and ignores stale selections', () => {
  assert.equal(readAgentState(composer({ selectedAgentScriptItem: { name: 'reviewer' } }).trigger).selected, 'reviewer');
  assert.equal(readAgentState(composer({ selectedAgentScriptItem: { name: 'gone' } }).trigger).selected, null);
});

test('readAgentState hides the entry when there is nothing to pick', () => {
  // Existing conversations get no agentSelector at all.
  assert.equal(readAgentState({ __reactFiber$x: { memoizedProps: { agentSelector: undefined } } }), null);
  assert.equal(readAgentState(composer({ agentCustomizations: [] }).trigger), null);
  assert.equal(readAgentState(composer({ agentScriptsEnabled: false }).trigger), null);
  assert.equal(readAgentState(composer({
    agentCustomizations: [{ path: 'x', agent: { name: 'off', disabled: true } }],
  }).trigger), null);
  assert.equal(readAgentState(null), null);
});

test('agent entry styles put the footer tag in the capsule strip and reuse model rows', () => {
  assert.match(AGENT_ENTRY_CSS, /#deck-metrics-strip \.dk-ae-tag\s*\{/);
  assert.match(AGENT_ENTRY_CSS, /\.dk-ae-trigger\s*\{[^}]*border-radius:\s*9999px/);
  assert.match(AGENT_ENTRY_CSS, /\.dk-ae-list \.dk-model-row/);
});

test('the native agent chip is hidden only while the capsule shows its own tag', async () => {
  const { readFileSync } = await import('node:fs');
  const injector = readFileSync(new URL('../agy-capsule/sidecars/agy_capsule/deck_injector.mjs', import.meta.url), 'utf8');
  assert.match(injector, /\[data-deck-agent-tag="on"\] \[data-testid="selected-agent-chip"\] \{ display: none !important; \}/);
  const entry = readFileSync(new URL('../agy-capsule/sidecars/agy_capsule/agent_entry.mjs', import.meta.url), 'utf8');
  assert.match(entry, /composer\.dataset\.deckAgentTag = 'on'/);
  assert.match(entry, /delete composer\.dataset\.deckAgentTag/);
});

test('readAgentState reads the committed fiber when the DOM still points at the old one', () => {
  const stale = composer({ selectedAgentScriptItem: { name: 'reviewer' } });
  const fresh = composer({ selectedAgentScriptItem: { name: 'writer' } });
  // React double-buffers: the host root's stateNode.current names the committed tree.
  const staleRoot = { memoizedProps: {}, stateNode: {} };
  const freshRoot = { memoizedProps: {}, stateNode: {} };
  staleRoot.stateNode.current = freshRoot;
  freshRoot.stateNode.current = freshRoot;
  const staleLeaf = stale.trigger.__reactFiber$x;
  const freshLeaf = fresh.trigger.__reactFiber$x;
  staleLeaf.return.return.return = staleRoot;
  freshLeaf.return.return.return = freshRoot;
  staleLeaf.alternate = freshLeaf;
  assert.equal(readAgentState({ __reactFiber$x: staleLeaf }).selected, 'writer');
});
