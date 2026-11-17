// Optional real-browser checks; runtime and node:test tests stay dependency-free.
// node test/browser-regressions.mjs [path to playwright module] [browser channel]
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { UI_HTML } from '../agy-capsule/sidecars/agy_capsule/server.mjs';
import { DEFAULT_SETTINGS } from '../agy-capsule/sidecars/agy_capsule/settings.mjs';
import { buildRuntimeBundle } from '../agy-capsule/sidecars/agy_capsule/deck_injector.mjs';

const { chromium } = createRequire(import.meta.url)(process.argv[2] || 'playwright');
const launch = { headless: true, ...(process.argv[3] ? { channel: process.argv[3] } : {}) };
const snapshot = () => ({
  uiVersion: Number(UI_HTML.match(/d\.uiVersion !== (\d+)/)[1]),
  contextTokens: 128000, maxContextTokens: 256000, cachedIn: 100000,
  turn0Tokens: 20000, totalOutputTokens: 24000, totalThinkingTokens: 12000,
  lastStepEpochMs: Date.now(),
  generation: { requestIndex: 4, tps: 100, output: 400, ttft: 1, streaming: 3, duration: 4 },
  turnSpeed: { userStepIndex: 20, generation: { requestIndex: 4, tps: 100 }, hasActiveStep: false, completedAtMs: Date.now() },
  prefs: { ...DEFAULT_SETTINGS, showSpeed: false },
  quotaGroups: [{ displayName: 'Gemini Models', buckets: [{ window: '5h', remainingFraction: .58 }, { window: 'weekly', remainingFraction: .55 }] }],
});

await test('Sidebar clears empty or missing quotas and renders a later fresh snapshot', async t => {
  const browser = await chromium.launch(launch);
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 360, height: 900 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const data = snapshot();
  await page.route('http://agy.test/**', route => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/api/context') return route.fulfill({ json: data });
    if (path === '/preload.js') return route.fulfill({ body: '' });
    return route.fulfill({ contentType: 'text/html', body: UI_HTML });
  });
  await page.goto('http://agy.test/');
  await page.waitForFunction(() => document.querySelectorAll('#quota-root .quota-group').length === 1);
  const quotas = data.quotaGroups;
  for (const empty of [[], null]) {
    data.quotaGroups = empty;
    await page.waitForFunction(() => document.getElementById('quota-root').childElementCount === 0, null, { timeout: 3000 });
    assert.equal(await page.locator('#quota-root').textContent(), '');
    data.quotaGroups = quotas;
    await page.waitForFunction(() => document.querySelectorAll('#quota-root .quota-group').length === 1);
  }
  assert.deepEqual(errors, []);
});

await test('Footer reveals and wider speed values never overlap the native controls', async t => {
  const browser = await chromium.launch(launch);
  t.after(() => browser.close());
  const page = await browser.newPage({ viewport: { width: 1100, height: 800 } });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.setContent(`<style>
    *{box-sizing:border-box}:root{--foreground:#eee;--muted-foreground:#aaa;--background:#141414;--card:#222;--border:#444}
    body{margin:16px;font:13px Arial}.agy-composer-footer{display:flex;align-items:center;gap:4px;padding:2px;position:absolute;bottom:40px}
    .footer-left{display:flex;align-items:center;flex:1;min-width:0}.model{display:flex;white-space:nowrap}
    .right{display:flex;align-items:center;gap:2px;flex-shrink:0}button{font:inherit;white-space:nowrap}
    [data-testid=permissions-selector-trigger]{display:flex;align-items:center;gap:4px;padding:6px;border:0;height:28px}
    [data-testid=permissions-selector-trigger] svg{width:14px;height:14px;flex-shrink:0}
    </style><div class="agy-composer-footer"><div class="footer-left"><button>+</button><div class="model"><button>Gemini 4 Argon Medium</button></div></div><div class="right"><button data-testid="permissions-selector-trigger"><svg></svg><span>Turbo</span><svg></svg></button><button>Send</button></div></div>`);
  await page.evaluate(buildRuntimeBundle(1234).code);
  const apply = data => page.evaluate(value => globalThis.__agyCapsuleDeck.apply(value, location.pathname), data);
  const samples = () => page.evaluate(async () => {
    const gaps = [];
    for (let i = 0; i < 18; i++) {
      await new Promise(requestAnimationFrame);
      const strip = document.getElementById('agy-capsule-host').shadowRoot.getElementById('deck-metrics-strip');
      const bounds = strip.getBoundingClientRect(), controls = document.querySelector('.right').getBoundingClientRect();
      if (bounds.width > 0) gaps.push(bounds.right - controls.left);
    }
    return gaps;
  });
  for (const width of [260, 300, 340, 380, 420, 460, 500, 540, 580]) {
    await page.locator('.agy-composer-footer').evaluate((element, value) => element.style.width = value + 'px', width);
    const data = snapshot();
    await apply(data);
    await page.waitForTimeout(250);
    data.prefs.showSpeed = true;
    await apply(data);
    assert.ok((await samples()).every(overlap => overlap <= 1), `Speed reveal overlaps at ${width}px`);
    data.turnSpeed.generation.tps = 10000;
    await apply(data);
    assert.ok((await samples()).every(overlap => overlap <= 1), `Wider text overlaps at ${width}px`);
  }
  assert.deepEqual(errors, []);
});
