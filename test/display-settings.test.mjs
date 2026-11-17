import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSettingsStore, DEFAULT_SETTINGS } from '../agy-capsule/sidecars/agy_capsule/settings.mjs';
import { createPresentation } from '../agy-capsule/sidecars/agy_capsule/ui.mjs';
import { toView } from '../agy-capsule/sidecars/agy_capsule/deck_injector.mjs';
import { UI_HTML } from '../agy-capsule/sidecars/agy_capsule/server.mjs';

test('sidebar is registered as an Extensions auxiliary-pane view', () => {
  const manifest = JSON.parse(readFileSync(new URL('../agy-capsule/sidecars/agy_capsule/sidecar.json', import.meta.url), 'utf8'));
  assert.equal(manifest.has_web_ui, true);
  assert.deepEqual(manifest.ui_config.views, [{ entrypoint: 'SIDECAR_UI_ENTRYPOINT_AUX_PANE', path: '/', title: 'agy-capsule' }]);
});

test('individual settings validate values, persist and propagate between sidecars', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-settings-'));
  try {
    const file = join(dir, 'settings.json');
    const first = createSettingsStore(file);
    const second = createSettingsStore(file);
    assert.deepEqual(first.read(), DEFAULT_SETTINGS);
    assert.equal(first.read().language, 'en');
    assert.equal(first.read().settingsLanguage, 'zh-CN');
    assert.equal(first.read().labelCase, 'lowercase');
    assert.equal(first.read().showSpeed, true);
    assert.equal(first.read().speedAnimation, false);
    assert.equal(first.read().showRequestMetrics, true);
    assert.equal(first.read().hideUnavailableQuota, false);
    assert.equal(first.read().showCacheWarnings, true);
    assert.equal(first.read().showContextWarnings, true);
    assert.equal(first.read().showRequestErrors, true);
    assert.equal('showSteps' in first.read(), false);
    first.update({ language: 'zh-TW', theme: 'dark', density: 'standard', quotaIndicator: 'bar', unexpected: true });
    const expected = { ...DEFAULT_SETTINGS, language: 'zh-TW', density: 'standard', quotaIndicator: 'bar' };
    assert.deepEqual(second.read(), expected);
    second.update({ language: 'invalid', theme: 'light', panelStyle: 'seven-categories' });
    assert.deepEqual(first.read(), expected, 'Removed theme overrides must be ignored');
    first.update({ settingsLanguage: 'en', highlightActiveModel: true });
    assert.equal(second.read().language, 'zh-TW');
    assert.equal(second.read().settingsLanguage, 'en');
    assert.equal(second.read().highlightActiveModel, true);
    first.update({ hideUnavailableQuota: true, labelCase: 'titlecase' });
    assert.equal(second.read().hideUnavailableQuota, true);
    assert.equal(second.read().labelCase, 'titlecase');
    first.update({ showCacheWarnings: false, showContextWarnings: false, showRequestErrors: true });
    assert.equal(second.read().showCacheWarnings, false);
    assert.equal(second.read().showContextWarnings, false);
    assert.equal(second.read().showRequestErrors, true);
    first.update({ hideUnavailableQuota: 'false' });
    assert.equal(second.read().hideUnavailableQuota, true);
    first.update({ showSpeed: false });
    first.update({ speedAnimation: true });
    assert.equal(second.read().speedAnimation, false, 'speedAnimation stays off while showSpeed is disabled');
    first.update({ showSpeed: true, speedAnimation: true });
    assert.equal(second.read().speedAnimation, true);
    first.update({ speedAnimation: 'false' });
    assert.equal(second.read().speedAnimation, true);
    first.update({ showSpeed: false });
    assert.equal(second.read().speedAnimation, false, 'turning off showSpeed resets speedAnimation');
    assert.equal(second.read().showSpeed, false);
    assert.equal(second.read().showRequestMetrics, true, 'panel request metrics are decoupled from capsule speed');
    first.update({ showSpeed: true, showRequestMetrics: false, showSteps: false });
    assert.equal(second.read().showSpeed, true);
    assert.equal(second.read().showRequestMetrics, false);
    assert.equal('showSteps' in second.read(), false);
    assert.deepEqual(createSettingsStore(file).read(), first.read());
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('removing presets keeps old appearance choices and persists only independent settings', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-style-migration-'));
  try {
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ panelStyle: 'modern', quotaIndicator: 'ring', language: 'zh-TW', speedAnimation: true, showSteps: true, theme: 'dark' }));
    const store = createSettingsStore(file);
    assert.equal(store.read().density, 'standard');
    assert.equal('categoryMarker' in store.read(), false);
    assert.equal(store.read().quotaIndicator, 'ring');
    assert.equal('showSteps' in store.read(), false, 'Rejected feature ignores an old enabled setting');
    assert.equal('theme' in store.read(), false);
    const original = store.read();
    store.update({ panelStyle: 'classic' });
    assert.deepEqual(store.read(), original, 'Removed presets cannot change current appearance');
    store.update({ panelLayout: 'matched', density: 'spacious' });
    assert.equal(store.read().quotaIndicator, 'ring');
    assert.equal(store.read().language, 'zh-TW');
    assert.equal(store.read().speedAnimation, true);
    assert.equal('panelStyle' in JSON.parse(readFileSync(file, 'utf8')), false);
    assert.deepEqual(createSettingsStore(file).read(), store.read());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('legacy request detail switches migrate cleanly to the single showRequestMetrics toggle', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-settings-migration-'));
  try {
    const file = join(dir, 'settings.json');
    writeFileSync(file, JSON.stringify({ showSpeed: true, showGenerationDetails: false }));
    const store = createSettingsStore(file);
    assert.deepEqual(store.read(), { ...DEFAULT_SETTINGS, showRequestMetrics: false });
    store.update({ showSteps: true });
    assert.equal('showGenerationDetails' in JSON.parse(readFileSync(file, 'utf8')), false);
    assert.equal(createSettingsStore(file).read().showRequestMetrics, false);
    assert.equal('showSteps' in createSettingsStore(file).read(), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('system language resolution and explicit language selection', () => {
  const ui = createPresentation();
  assert.equal(ui.locale({}, ['zh-Hant-TW']), 'zh-TW');
  assert.equal(ui.locale({}, ['zh-CN']), 'zh-CN');
  assert.equal(ui.locale({ language: 'en' }, ['zh-TW']), 'en');
  assert.equal(ui.dictionaries['zh-CN'].fiveHours, '5小时');
  assert.equal(ui.dictionaries['zh-TW'].fiveHours, '5小時');
  for (const dict of Object.values(ui.dictionaries)) {
    assert.deepEqual(Object.keys(dict), Object.keys(ui.dictionaries.en));
  }
});

test('Cache tooltip reports record age, separates reminder state, and handles unknown/new conversations', () => {
  const ui = createPresentation();
  const timestamp = 1700000000000;
  const data = { contextTokens: 128000, cachedIn: 100000, lastStepEpochMs: timestamp };
  for (const [seconds, age] of [[30, '<1m'], [120, '2m'], [210, '3m'], [3900, '1h 5m'], [7200, '2h']]) {
    const tip = ui.cacheTooltip(data, ui.dictionaries.en, timestamp + seconds * 1000);
    assert.ok(tip.includes(`Last recorded activity: ${age}`));
    assert.match(tip, /100K \/ 128K tokens/);
    assert.equal(tip.includes('Approaching'), seconds >= 180 && seconds < 240);
    assert.equal(tip.includes('may be cold'), seconds >= 240);
  }
  assert.match(ui.cacheTooltip(data, ui.dictionaries['zh-CN'], timestamp + 240000), /最近记录距今: 4m.*可能已冷却/);
  const mutedWarn = ui.cacheTooltip(data, ui.dictionaries.en, timestamp + 210000, { showCacheWarnings: false });
  assert.match(mutedWarn, /Last recorded activity: 3m$/);
  const mutedCold = ui.cacheTooltip(data, ui.dictionaries['zh-CN'], timestamp + 240000, { showCacheWarnings: false });
  assert.match(mutedCold, /最近记录距今: 4m$/);
  assert.equal(ui.cacheView(data, { showCacheWarnings: true }, timestamp + 210000).status, 'warning');
  assert.equal(ui.cacheView(data, { showCacheWarnings: true }, timestamp + 210000).countdown, '~1m');
  assert.equal(ui.cacheView(data, { showCacheWarnings: true }, timestamp + 240000).status, 'cold');
  assert.equal(ui.cacheView(data, { showCacheWarnings: true }, timestamp + 240000).valDeco, 'line-through');
  const suppressedWarn = ui.cacheView(data, { showCacheWarnings: false }, timestamp + 240000);
  assert.equal(suppressedWarn.status, 'fresh');
  assert.equal(suppressedWarn.ctxIconColor, '');
  assert.equal(suppressedWarn.valDeco, 'none');
  assert.equal(suppressedWarn.countdown, '');
  const coldCapsule = toView({ ...data, lastStepEpochMs: Date.now() - 250000, prefs: { showCacheWarnings: false } });
  assert.equal(coldCapsule.ctxIconColor, '');
  assert.equal(coldCapsule.cacheValDeco, 'none');
  assert.equal(coldCapsule.valCacheHitK, '');
  assert.match(ui.cacheTooltip({ ...data, lastStepEpochMs: 0 }), /Last recorded activity: —$/);
  assert.equal(ui.cacheTooltip({}), '0 / 0 cached · New conversation');
});

test('independent appearance controls preserve context counts and four-category shares', () => {
  const data = { contextTokens: 128000, maxContextTokens: 256000, cachedIn: 100000, totalOutputTokens: 24000, totalThinkingTokens: 12000, turn0Tokens: 20000, quotaGroups: [{ displayName: '<Gemini>', buckets: [{ window: '5h', remainingFraction: .85 }] }] };
  const classic = toView(data);
  const modern = toView({ ...data, prefs: { language: 'zh-CN', theme: 'dark', density: 'standard', quotaIndicator: 'bar' } });
  for (const key of ['pillCtx', 'usedFrac', 'segReadW', 'segOutW', 'segThinkW', 'segTurn0W', 'valCacheHit', 'valTurn0K', 'valReadK', 'valThinkK', 'valOutK']) {
    assert.equal(modern[key], classic[key], key);
  }
  assert.equal(modern.usedFrac, '128K / 256K');
  assert.match(classic.quotaHtml, /<svg/);
  assert.match(modern.quotaHtml, /dk-q-meter/);
  assert.ok(!modern.quotaHtml.includes('<Gemini>'));
});

test('context tooltips keep four-category arithmetic and distinguish input, cache and generated output', () => {
  const ui = createPresentation();
  const data = { contextTokens: 128000, maxContextTokens: 256000, cachedIn: 100000, turn0Tokens: 20000, totalOutputTokens: 24000, totalThinkingTokens: 12000 };
  const tips = ui.contextTooltips(data);
  assert.match(tips.overview, /Remaining 128K/);
  assert.match(tips.overview, /Cached input 100K · Uncached input 28\.0K/);
  assert.match(tips.overview, /excludes its new output/);
  assert.match(tips.read, /72\.0K tokens · 28% of context limit/);
  assert.match(tips.read, /Added context input/);
  assert.match(tips.write, /24\.0K tokens/);
  assert.match(tips.think, /12\.0K tokens/);
  assert.match(ui.contextTooltips({ ...data, maxContextTokens: 0 }).overview, /Limit — · Remaining —/);
  assert.match(ui.contextTooltips({ ...data, maxContextTokens: 64000 }).overview, /Remaining 0/);
});

test('quota tooltip reports only the reset timestamp, timezone or missing data line', () => {
  const ui = createPresentation();
  const data = { pool: 'Group "<test> &', window: 'weekly', remainingFraction: 0, resetTime: '2026-11-16T12:30:00Z' };
  const tip = ui.quotaTooltip(data);
  assert.doesNotMatch(tip, /\n/);
  assert.match(tip, /^Resets 2026-11-\d{2} \d{2}:\d{2} \(.+\)$/);
  assert.equal(ui.quotaTooltip({ ...data, resetTime: null }), 'Reset time not reported');
  assert.equal(ui.quotaTooltip({ ...data, resetTime: 'invalid', remainingFraction: null }), 'Reset time not reported');
  assert.match(ui.quotaTooltip(data, ui.dictionaries['zh-CN']), /^重置时间 2026-11-\d{2} \d{2}:\d{2} \(.+\)$/);
});

test('sidebar settings use flat dividers, same-row appearance blocks, refined capsule previews and compact metric rows', () => {
  const ui = createPresentation();
  assert.ok(!UI_HTML.includes('data-setting-card="panelStyle"'));
  assert.ok(!UI_HTML.includes('data-setting-card="theme"'));
  assert.doesNotMatch(UI_HTML, /presets-card|preset-|personal-presets|\/api\/presets/);
  assert.doesNotMatch(UI_HTML, /setting-show-steps|data-generation-row="steps"|data-settings-scope="compaction"/);
  assert.ok(!UI_HTML.includes('data-i18n="previewKeepZero"'));
  assert.ok(!UI_HTML.includes('pv-err-pop'));
  for (const key of Object.keys(DEFAULT_SETTINGS)) {
    assert.ok(UI_HTML.includes(`data-setting-card="${key}"`), `missing setting item for ${key}`);
  }
  const settingsHtml = UI_HTML.slice(UI_HTML.indexOf('<section class="settings'));
  assert.ok(
    settingsHtml.indexOf('data-setting-card="showCacheWarnings"') < settingsHtml.indexOf('data-setting-card="showContextWarnings"'),
    'showCacheWarnings should be placed above showContextWarnings'
  );
  assert.ok(
    settingsHtml.indexOf('data-settings-scope="features"') < settingsHtml.indexOf('data-setting-card="highlightActiveModel"') &&
    settingsHtml.indexOf('data-setting-card="highlightActiveModel"') < settingsHtml.indexOf('data-setting-card="hideUnavailableQuota"') &&
    settingsHtml.indexOf('data-setting-card="hideUnavailableQuota"') < settingsHtml.indexOf('data-setting-card="showCacheWarnings"') &&
    settingsHtml.indexOf('data-setting-card="showSpeed"') < settingsHtml.indexOf('data-setting-card="speedAnimation"') &&
    settingsHtml.indexOf('data-setting-card="showRequestMetrics"') < settingsHtml.indexOf('data-setting-card="showTurnMetrics"'),
    'settings should group feature toggles under one Features section cleanly'
  );
  assert.ok(!UI_HTML.includes('data-settings-scope="quota"') && !UI_HTML.includes('data-settings-scope="context"'));
  assert.ok(!UI_HTML.includes('data-settings-scope="request"') && !UI_HTML.includes('data-settings-scope="turn"'));
  assert.ok(UI_HTML.includes('id="help-speed-pair"') && UI_HTML.includes('id="help-request-metrics"') && UI_HTML.includes('id="help-turn-metrics"'));
  assert.equal((settingsHtml.match(/class="setting-help-dot"/g) || []).length, 3, 'only 3 concise ? help dots should remain');
  assert.ok(UI_HTML.includes('data-preview-group="turn"') && !UI_HTML.includes('data-preview-group="request"'));
  assert.equal(ui.dictionaries.en.requestTip, 'Last request');
  assert.equal(ui.dictionaries.en.turnMetrics, 'Last turn');
  assert.equal(ui.dictionaries['zh-CN'].featuresSection, '功能');
  assert.equal(ui.dictionaries['zh-CN'].speedAnimation, '动效');
  assert.equal(ui.dictionaries['zh-CN'].turnRequests, '请求数');
  assert.equal(ui.dictionaries['zh-CN'].turnWrite, '写入');
  assert.equal(ui.dictionaries['zh-CN'].turnElapsed, '耗时');
  assert.equal('turnRead' in ui.dictionaries.en, false);
  assert.match(ui.generationMarkup(), /class="generation-grid"/);
  assert.match(ui.turnMetricsMarkup(), /class="turn-bar-list"/);
  assert.ok(ui.turnMetricsMarkup().indexOf('turnThinking') < ui.turnMetricsMarkup().indexOf('turnWrite'));
  const block = { hidden: true };
  const timingVal = { hidden: true, textContent: '', title: '' };
  const speedVal = { hidden: true, textContent: '', title: '' };
  const pop = {
    querySelectorAll: (sel) => sel === '[data-generation="timing"]' ? [timingVal]
      : sel === '[data-generation="speed"]' ? [speedVal]
      : sel === '[data-generation-block]' ? [block] : [],
  };
  ui.renderGeneration(pop, { requestIndex: 1, tps: 40, ttft: 1, duration: 3 }, ui.dictionaries.en, { showSpeed: false, showRequestMetrics: true });
  assert.equal(block.hidden, false);
  assert.equal(timingVal.textContent, '1.0s–3.0s');
  assert.equal(speedVal.textContent, '40.0 tok/s');
  ui.renderGeneration(pop, { requestIndex: 1, tps: 40, ttft: 1, duration: 3 }, ui.dictionaries.en, { showSpeed: true, showRequestMetrics: false });
  assert.equal(block.hidden, true);
  assert.ok(!UI_HTML.includes('data-setting-card="categoryMarker"'));
  for (const key of ['settingsLanguage', 'language', 'panelLayout', 'density', 'quotaIndicator', 'labelCase']) {
    assert.ok(UI_HTML.includes(`data-pick-setting="${key}"`), `missing clickable swatch for ${key}`);
    assert.ok(!UI_HTML.includes(`name="${key}"`), `unexpected select dropdown for ${key}`);
  }
  assert.ok(
    settingsHtml.indexOf('data-i18n="appearanceSection"') < settingsHtml.indexOf('data-setting-card="labelCase"') &&
    settingsHtml.indexOf('data-setting-card="labelCase"') < settingsHtml.indexOf('data-settings-scope="features"'),
    'labelCase should be under Appearance settings'
  );
  for (const [, key] of UI_HTML.matchAll(/data-(?:stats-)?i18n="([^"]+)"/g)) {
    if (key.startsWith('${')) continue; // Skip embedded createPresentation().toString() source template.
    assert.ok(key in ui.dictionaries.en, `missing dictionary key ${key}`);
  }
  const statsNode = { dataset: { statsI18n: 'cache' }, textContent: '' };
  const settingsNode = { dataset: { i18n: 'language' }, textContent: '', closest: (sel) => (sel === '.settings' ? {} : null) };
  const root = {
    style: { getPropertyValue: () => '', setProperty: () => {}, removeProperty: () => {} },
    dataset: {},
    querySelector: () => null,
    querySelectorAll: (sel) => sel === '[data-i18n]' ? [settingsNode] : sel === '[data-stats-i18n]' ? [statsNode] : [],
  };
  ui.apply(root, { language: 'en', settingsLanguage: 'zh-CN' });
  assert.equal(root.dataset.labelCase, 'lowercase');
  assert.equal(statsNode.textContent, 'Cache');
  assert.equal(settingsNode.textContent, '显示语言');
  ui.apply(root, { language: 'en', labelCase: 'titlecase' });
  assert.equal(root.dataset.labelCase, 'titlecase');
});

test('sidebar stats uses container-responsive layout and fluid quota rows without panelLayout height stretching', () => {
  assert.match(UI_HTML, /class="stats-layout"/);
  assert.match(UI_HTML, /class="stats-context"/);
  assert.match(UI_HTML, /id="quota-root" class="stats-quota"/);
  assert.match(UI_HTML, /\.panel\s*\{[^}]*container-type:\s*inline-size;\s*container-name:\s*stats;/s);
  assert.match(UI_HTML, /@container stats \(min-width:\s*420px\)/);
  assert.match(UI_HTML, /@container stats \(min-width:\s*540px\)/);
  assert.match(UI_HTML, /\.quota-meter\s*\{[^}]*max-width:\s*none;/s);
  assert.match(UI_HTML, /body\[data-quota-indicator="bar"\] \.quota-line1\s*\{\s*grid-template-columns:\s*54px minmax\(0,\s*1fr\)/);
});

test('reset countdown format is a user setting and is shielded from page translators', () => {
  const ui = createPresentation();
  const now = Date.parse('2026-11-17T00:00:00Z');
  const at = (min) => new Date(now + min * 60000).toISOString();
  assert.equal(DEFAULT_SETTINGS.resetFormat, 'compact');
  assert.equal(ui.formatReset(at(4 * 60 + 55), { language: 'zh-CN' }, now), '4h 55m');
  assert.equal(ui.formatReset(at(5 * 1440 + 11 * 60), { language: 'en' }, now), '5d 11h');
  assert.equal(ui.formatReset(at(4 * 60), { language: 'en' }, now), '4h 00m');
  assert.equal(ui.formatReset(at(4 * 60 + 55), { language: 'zh-CN', resetFormat: 'localized' }, now), '4小时55分');
  assert.equal(ui.formatReset(at(5 * 1440 + 11 * 60), { language: 'zh-TW', resetFormat: 'localized' }, now), '5天11小時');
  assert.equal(ui.formatReset(at(3), { language: 'zh-CN', resetFormat: 'localized' }, now), '3分钟');
  assert.equal(ui.formatReset(at(4 * 60 + 55), { language: 'en', resetFormat: 'localized' }, now), '4 hr 55 min');
  assert.equal(ui.formatReset(at(-1), { language: 'zh-CN' }, now), '即将重置');
  assert.equal(ui.formatReset(''), '');

  const view = toView({ quotaGroups: [{ displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: 1, resetTime: at(300) }] }], prefs: { quotaIndicator: 'bar' } });
  assert.match(view.quotaHtml, /class="dk-q-pct notranslate" translate="no">100%</);
  assert.match(view.quotaHtml, /class="dk-q-mid notranslate" translate="no">/);
  assert.match(UI_HTML, /class="quota-mid notranslate" translate="no"/);
  assert.match(UI_HTML, /data-setting-card="resetFormat"/);
});

test('footer quota popover shares one column grid across groups so percentages and bars align', () => {
  const source = readFileSync(new URL('../agy-capsule/sidecars/agy_capsule/deck_injector.mjs', import.meta.url), 'utf8');
  assert.match(source, /\.dk-quota-pop > \.dk-panel-content \{\s*display: grid;/);
  assert.match(source, /\.dk-q-row \{\s*grid-column: 1 \/ -1;\s*display: grid;\s*grid-template-columns: subgrid;/);
  assert.match(source, /\.dk-q-right \{\s*grid-column: 2 \/ 4;\s*display: grid;\s*grid-template-columns: subgrid;/);
  assert.doesNotMatch(source, /\.dk-q-row \{[^}]*grid-template-columns: minmax/);
});
