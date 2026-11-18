import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { UI_SKINS, DEFAULT_UI_SKIN, DECK_SKIN_CSS, SIDEBAR_SKIN_CSS } from '../agy-capsule/sidecars/agy_capsule/ui_skins.mjs';
import { DEFAULT_SETTINGS, createSettingsStore, normalizeSettings } from '../agy-capsule/sidecars/agy_capsule/settings.mjs';
import { createPresentation } from '../agy-capsule/sidecars/agy_capsule/ui.mjs';
import { UI_HTML } from '../agy-capsule/sidecars/agy_capsule/server.mjs';
import { buildRuntimeBundle, detectHostTheme, toView } from '../agy-capsule/sidecars/agy_capsule/deck_injector.mjs';

test('ui_skins keeps native as Default-OFF skin with frosted opt-in across sidebar and deck CSS', () => {
  assert.deepEqual(UI_SKINS, ['native', 'frosted']);
  assert.equal(DEFAULT_UI_SKIN, 'native');
  assert.equal(DEFAULT_SETTINGS.uiSkin, 'native');
  assert.equal(DEFAULT_SETTINGS.requestPosition, 'bottom');

  // Preserve upstream 6dcc732 default-OFF experience
  assert.equal(DEFAULT_SETTINGS.language, 'en');
  assert.equal(DEFAULT_SETTINGS.settingsLanguage, 'zh-CN');
  assert.equal(DEFAULT_SETTINGS.quotaIndicator, 'ring');
  assert.equal(DEFAULT_SETTINGS.contextLayout, 'columns');
  assert.equal(DEFAULT_SETTINGS.contextMarker, 'square');
  assert.equal(DEFAULT_SETTINGS.columnPercent, false);
  assert.equal(DEFAULT_SETTINGS.highlightActiveModel, false);
  assert.equal(DEFAULT_SETTINGS.showTurnMetrics, false);

  assert.match(UI_HTML, /<body data-ui-skin="native">/);
  assert.match(DECK_SKIN_CSS, /#deck-metrics-strip\s*\{[^}]*color:\s*var\(--agc-muted\);/s);
  assert.match(DECK_SKIN_CSS, /#deck-metrics-strip\[data-ui-skin="native"\]\[data-theme="light"\][^}]*--agc-fg-strong:\s*var\(--foreground,\s*#18181b\);/s);
  assert.match(DECK_SKIN_CSS, /#deck-metrics-strip\[data-ui-skin="native"\]\s*\.dk-pop\s*\{[^}]*background:\s*var\(--agc-card-bg\);/s);
  assert.match(SIDEBAR_SKIN_CSS, /body\[data-ui-skin="native"\]\s*\.setting-seg-opt\[data-active="true"\]\s*\{\s*color:\s*var\(--agc-good\);\s*\}/);

  const deck = readFileSync(new URL('../agy-capsule/sidecars/agy_capsule/deck_injector.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(deck.slice(deck.indexOf('function pageMount'), deck.indexOf('root.innerHTML =')), /color:\s*var\(--muted-foreground/);
});

test('settings store validates and persists uiSkin and requestPosition', () => {
  assert.deepEqual(
    { uiSkin: normalizeSettings({ uiSkin: 'glass-invalid', requestPosition: 'left' }).uiSkin, requestPosition: normalizeSettings({ uiSkin: 'glass-invalid', requestPosition: 'left' }).requestPosition },
    { uiSkin: 'native', requestPosition: 'bottom' },
  );

  const dir = mkdtempSync(join(tmpdir(), 'agy-skin-pref-'));
  try {
    const store = createSettingsStore(join(dir, 'settings.json'));
    assert.equal(store.read().uiSkin, 'native');
    assert.equal(store.read().requestPosition, 'bottom');

    store.update({ uiSkin: 'frosted', requestPosition: 'top' });
    assert.deepEqual({ uiSkin: store.read().uiSkin, requestPosition: store.read().requestPosition }, { uiSkin: 'frosted', requestPosition: 'top' });

    // Invalid patches are ignored without clobbering saved valid preferences
    store.update({ uiSkin: 'glass-invalid', requestPosition: 'left' });
    assert.deepEqual({ uiSkin: store.read().uiSkin, requestPosition: store.read().requestPosition }, { uiSkin: 'frosted', requestPosition: 'top' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }

  const ui = createPresentation();
  assert.equal(ui.appearance({}).uiSkin, 'native');
  assert.equal(ui.appearance({ uiSkin: 'frosted' }).uiSkin, 'frosted');
  assert.equal(ui.appearance({}).requestPosition, 'bottom');
  assert.equal(ui.appearance({ requestPosition: 'top' }).requestPosition, 'top');
});

test('detectHostTheme handles classes, colorScheme, hex/rgb luminance, and transparent defaults', () => {
  const runDetect = (env) => {
    const prevDoc = globalThis.document;
    const prevGcs = globalThis.getComputedStyle;
    const prevMatch = globalThis.matchMedia;
    try {
      globalThis.document = env.document;
      globalThis.getComputedStyle = env.getComputedStyle;
      globalThis.matchMedia = env.matchMedia;
      return detectHostTheme();
    } finally {
      globalThis.document = prevDoc;
      globalThis.getComputedStyle = prevGcs;
      globalThis.matchMedia = prevMatch;
    }
  };
  const cls = (names) => ({ classList: { contains: (n) => names.includes(n) } });

  assert.equal(runDetect({ document: { body: cls(['vscode-light']), documentElement: cls([]) } }), 'light');
  assert.equal(runDetect({ document: { body: cls([]), documentElement: cls(['vscode-dark']) } }), 'dark');

  // Transparent backgroundColor must fall through rather than falsely detecting #000000 as dark
  const lightViaMatch = runDetect({
    document: { body: cls([]), documentElement: cls([]) },
    getComputedStyle: () => ({ colorScheme: 'light dark', getPropertyValue: () => '', backgroundColor: 'rgba(0, 0, 0, 0)' }),
    matchMedia: (q) => ({ matches: q === '(prefers-color-scheme: light)' }),
  });
  assert.equal(lightViaMatch, 'light');

  // Solid hex --background overrides transparent backgroundColor
  const lightViaHex = runDetect({
    document: { body: cls([]), documentElement: cls([]) },
    getComputedStyle: () => ({ colorScheme: '', getPropertyValue: (k) => (k === '--background' ? '#f8f9fb' : ''), backgroundColor: '#0000' }),
    matchMedia: () => ({ matches: false }),
  });
  assert.equal(lightViaHex, 'light');

  // Dark rgb backgroundColor
  const darkViaRgb = runDetect({
    document: { body: cls([]), documentElement: cls([]) },
    getComputedStyle: () => ({ colorScheme: '', getPropertyValue: () => '', backgroundColor: 'rgb(20, 20, 22)' }),
    matchMedia: () => ({ matches: true }),
  });
  assert.equal(darkViaRgb, 'dark');
});

test('buildRuntimeBundle executes cleanly in VM and UI_HTML inline script has valid syntax', () => {
  const { code, hash } = buildRuntimeBundle(777);
  assert.match(hash, /^[0-9a-f]{16}$/);
  const sandbox = {
    window: {},
    document: {
      querySelector: () => null,
      addEventListener() {},
      removeEventListener() {},
    },
    location: { pathname: '/' },
    setInterval: () => 1,
    clearInterval() {},
  };
  sandbox.globalThis = sandbox;
  const res = vm.runInNewContext(code, sandbox);
  assert.equal(res, true);
  assert.equal(typeof sandbox.__agyCapsuleDeck.readState, 'function');
  assert.equal(typeof sandbox.__agyCapsulePresentation.renderCacheRing, 'function');
  assert.equal(sandbox.__agyCapsulePresentation.version, 65);

  const scriptMatch = UI_HTML.match(/<script>\n([\s\S]*)\n  <\/script>\n<\/body>/);
  assert.ok(scriptMatch, 'UI_HTML should contain inline script');
  assert.doesNotThrow(() => new vm.Script(scriptMatch[1]));
});

test('3-column footer, stream/total speed toggle, cacheExpiredTag, and requestPosition layout contracts hold', () => {
  const ui = createPresentation();
  assert.equal(ui.dictionaries.en.thinking, 'Thinking');
  assert.equal(ui.dictionaries.en.think, 'Think');
  assert.equal(ui.dictionaries.en.cacheExpiredTag, 'expired');
  assert.equal(ui.dictionaries['zh-CN'].cacheExpiredTag, '已过期');
  assert.equal(ui.dictionaries['zh-TW'].cacheExpiredTag, '已過期');

  const g = { requestIndex: 2, tps: 50, output: 300, reply: 200, thinking: 100, ttft: 2.0, streaming: 4.0, duration: 6.0 };
  const genEn = ui.generationText(g, ui.dictionaries.en);
  assert.equal(genEn.speed, '50.0 tok/s');
  assert.equal(genEn.streamSpeed, '75.0 tok/s');
  assert.equal(genEn.outputSub, 'Think 100');
  assert.match(genEn.speedTitle, /^Speed 50\.0 tok\/s = Out 300 \/ \(TTFT 2\.00s \+ Stream 4\.00s\)$/);
  assert.match(genEn.streamSpeedTitle, /^Stream 75\.0 tok\/s = Out 300 \/ Stream 4\.00s$/);
  for (const lang of ['zh-CN', 'zh-TW']) {
    const gt = ui.generationText(g, ui.dictionaries[lang]);
    assert.ok(gt.speedTitle.includes(ui.dictionaries[lang].formulaSpeed));
    assert.ok(gt.streamSpeedTitle.includes(ui.dictionaries[lang].formulaStream));
  }

  // renderGeneration updates #sb-speed-toggle / #sb-speed-slot and stream mode calculation
  const makeNode = (init = {}) => ({ hidden: false, textContent: '', title: '', dataset: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, ...init });
  const btn = makeNode();
  const slot = makeNode();
  const speedNode = makeNode();
  const timingNode = makeNode();
  const outVal = makeNode();
  const outSub = makeNode();
  const pop = {
    dataset: { speedMode: 'stream' },
    querySelectorAll: (sel) => ({
      '[data-el="speedToggle"], #sb-speed-toggle': [btn],
      '[data-el="speedSlot"], #sb-speed-slot': [slot],
      '[data-generation="speed"]': [speedNode],
      '[data-generation="timing"]': [timingNode],
      '[data-el="footOutVal"]': [outVal],
      '[data-el="footOutSub"]': [outSub],
    }[sel] || []),
  };
  ui.renderGeneration(pop, g, ui.dictionaries.en, { showRequestMetrics: true });
  assert.equal(btn.attrs['aria-pressed'], 'true');
  assert.equal(slot.dataset.mode, 'stream');
  assert.equal(slot.dataset.tier, 'green');
  assert.equal(speedNode.textContent, '75.0 tok/s');
  assert.equal(timingNode.textContent, '4.0s');
  assert.equal(outVal.textContent, '300');
  assert.equal(outSub.textContent, 'Think 100');

  // Cache ring states
  const arc = { style: {}, attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, getAttribute(k) { return this.attrs[k]; } };
  const ring = { dataset: {} };
  ui.renderCacheRing(ring, arc, 'cold', 65);
  assert.equal(ring.dataset.iconState, 'expired');
  assert.equal(arc.style.opacity, '0.82');
  ui.renderCacheRing(ring, arc, 'fresh', 0);
  assert.equal(ring.dataset.iconState, 'idle');
  assert.equal(arc.style.display, 'none');

  // Quota indicator-first, tone attribute, active badge, empty reset collapse, and sidebar guard
  const qView = toView({
    quotaGroups: [{ displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 0.08 }, { window: 'weekly', remainingFraction: 0.20 }] }],
    prefs: { quotaIndicator: 'bar' },
  });
  assert.match(qView.quotaHtml, /data-tone="danger"/);
  assert.match(qView.quotaHtml, /data-tone="warn"/);
  assert.match(qView.quotaHtml, /class="dk-q-active"/);
  assert.match(qView.quotaHtml, /<span class="dk-q-right"><span class="dk-q-meter">[\s\S]*?<span class="dk-q-pct/);

  const deck = readFileSync(new URL('../agy-capsule/sidecars/agy_capsule/deck_injector.mjs', import.meta.url), 'utf8');
  assert.match(deck, /\.dk-quota-pop:not\(:has\(\.dk-q-mid:not\(:empty\)\)\) \.dk-q-mid \{ display: none; \}/);
  assert.match(deck, /\[data-request-position="top"\] \.dk-ctx-pop > \.dk-panel-content > \.dk-foot-grid \{ order: -2; \}/);
  assert.match(UI_HTML, /body\[data-request-position="top"\] \.stats-context > \.foot-grid \{ order: -2; \}/);
  assert.match(UI_HTML, /const hasActiveModel = Boolean\(activeModelText && String\(activeModelText\)\.trim\(\)\);/);
  assert.match(UI_HTML, /statsCtxEl\.dataset\.hoverCat = cat/);
  assert.match(deck, /ctxPopInit\.dataset\.hoverCat = cat/);
});
