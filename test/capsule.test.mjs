import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

import {
  calcImageTokens,
  core,
  findCompactionEpochStart,
  getImageDimensions,
  parseGenMetadataRow,
  parseStepTimestampMs,
} from '../plugins/agy-capsule/sidecars/agy_capsule/core.mjs';
import { createTelemetryService } from '../plugins/agy-capsule/sidecars/agy_capsule/telemetry.mjs';
import {
  buildRuntimeBundle,
  buildRuntimeBundleWithHash,
  CAPSULE_VERSION,
  isAntigravityUiTarget,
  needsBundleInjection,
  startDeckInjector,
} from '../plugins/agy-capsule/sidecars/agy_capsule/deck_injector.mjs';
import '../plugins/agy-capsule/sidecars/agy_capsule/server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..');

// Minimal protobuf encoder for building realistic test blobs
function pbVarint(num) {
  let n = BigInt(num);
  const out = [];
  while (n >= 0x80n) {
    out.push(Number(n & 0x7fn) | 0x80);
    n >>= 7n;
  }
  out.push(Number(n));
  return Buffer.from(out);
}

function pbFieldVarint(fieldNum, val) {
  return Buffer.concat([pbVarint((fieldNum << 3) | 0), pbVarint(val)]);
}

function pbFieldBytes(fieldNum, bufOrStr) {
  const buf = typeof bufOrStr === 'string' ? Buffer.from(bufOrStr, 'utf8') : bufOrStr;
  return Buffer.concat([pbVarint((fieldNum << 3) | 2), pbVarint(buf.length), buf]);
}

function encodeGenRow({ uncachedIn, cachedIn, thinkTokens, outTokens, maxContextTokens, lastStepIndex }) {
  const usage = Buffer.concat([
    pbFieldVarint(2, uncachedIn),
    pbFieldVarint(5, cachedIn),
    pbFieldVarint(9, thinkTokens),
    pbFieldVarint(10, outTokens),
  ]);
  const m10 = pbFieldVarint(4, maxContextTokens);
  const m9 = pbFieldBytes(10, m10);
  const kvLastStep = Buffer.concat([pbFieldBytes(1, 'last_step_index'), pbFieldBytes(2, String(lastStepIndex))]);
  const m1 = Buffer.concat([pbFieldBytes(4, usage), pbFieldBytes(9, m9), pbFieldBytes(20, kvLastStep)]);
  return pbFieldBytes(1, m1);
}

function encodeStepMeta(epochSec, nanos = 0) {
  const ts = Buffer.concat([pbFieldVarint(1, epochSec), pbFieldVarint(2, nanos)]);
  return pbFieldBytes(1, ts);
}

// Lightweight DOM + MutationObserver + ResizeObserver VM harness for renderer_client.js
function createRendererHarness({
  url = 'https://127.0.0.1:54321/c/11111111-1111-1111-1111-111111111111',
  modelText = 'Gemini 4 Hydrogen High',
  footerWidth = 680,
  modelWidth = 180,
  rightControlsWidth = 120,
} = {}) {
  const docListeners = new Map();
  const winListeners = new Map();
  const intervals = [];
  let modelWidthVal = modelWidth;
  let footerWidthVal = footerWidth;

  function makeClassList(node) {
    const set = new Set();
    return {
      _set: set,
      add(...cs) { cs.forEach((c) => set.add(c)); },
      remove(...cs) { cs.forEach((c) => set.delete(c)); },
      contains(c) { return set.has(c); },
      toggle(c, force) {
        if (force === undefined) {
          if (set.has(c)) { set.delete(c); return false; }
          set.add(c); return true;
        }
        if (force) set.add(c);
        else set.delete(c);
        return Boolean(force);
      },
      toString() { return [...set].join(' '); },
    };
  }

  function makeNode(tag = 'div', id = '') {
    const attrs = new Map();
    const listeners = new Map();
    const children = [];
    const style = {
      left: '',
      width: '',
      maxHeight: '',
      color: '',
      textDecoration: '',
      opacity: '',
      background: '',
      display: '',
    };
    let textVal = '';
    let innerHtmlVal = '';
    let rectFn = () => ({ left: 0, right: 0, top: 200, bottom: 230, width: 0, height: 0 });

    const node = {
      tagName: tag.toUpperCase(),
      id,
      lang: '',
      hidden: false,
      disabled: false,
      title: '',
      style,
      dataset: {},
      children,
      parentElement: null,
      shadowRoot: null,
      scrollWidth: 0,
      clientWidth: 0,
      classList: null,
      get className() { return this.classList.toString(); },
      set className(v) {
        this.classList._set.clear();
        String(v || '').split(/\s+/).filter(Boolean).forEach((c) => this.classList.add(c));
      },
      get textContent() {
        if (children.length > 0 && !textVal) {
          return children.map((c) => c.textContent).join('');
        }
        return textVal;
      },
      set textContent(v) {
        textVal = String(v ?? '');
        children.length = 0;
      },
      get innerHTML() { return innerHtmlVal; },
      set innerHTML(v) {
        innerHtmlVal = String(v ?? '');
        if (this.tagName === 'SHADOW' || id === 'agy-capsule-host' || innerHtmlVal.includes('data-el=')) {
          // Parse simple data-el/data-seg/data-row/data-val/data-k markers so Shadow DOM queries work
          children.length = 0;
          const markerRe = /data-(el|seg|row|val|k)="([^"]+)"/g;
          let m;
          const seen = new Set();
          while ((m = markerRe.exec(innerHtmlVal)) !== null) {
            const key = `${m[1]}=${m[2]}`;
            if (seen.has(key)) continue;
            seen.add(key);
            const child = makeNode('div');
            child.setAttribute(`data-${m[1]}`, m[2]);
            child.parentElement = node;
            children.push(child);
          }
        }
      },
      get isConnected() {
        let p = this;
        while (p) {
          if (p === doc.documentElement || p === doc.body) return true;
          p = p.parentElement;
        }
        return false;
      },
      get lastElementChild() {
        return children.length > 0 ? children[children.length - 1] : null;
      },
      setAttribute(k, v) {
        attrs.set(k, String(v));
        if (k === 'id') this.id = String(v);
        if (k === 'lang') this.lang = String(v);
        if (k === 'hidden') this.hidden = true;
      },
      getAttribute(k) { return attrs.has(k) ? attrs.get(k) : null; },
      removeAttribute(k) {
        attrs.delete(k);
        if (k === 'hidden') this.hidden = false;
      },
      contains(target) {
        let cur = target;
        while (cur) {
          if (cur === node) return true;
          cur = cur.parentElement;
        }
        return false;
      },
      appendChild(child) {
        if (child.parentElement && child.parentElement !== node) {
          const i = child.parentElement.children.indexOf(child);
          if (i >= 0) child.parentElement.children.splice(i, 1);
        }
        child.parentElement = node;
        if (!children.includes(child)) children.push(child);
        return child;
      },
      replaceChildren(...nodes) {
        children.length = 0;
        textVal = '';
        for (const n of nodes) this.appendChild(n);
      },
      remove() {
        if (this.parentElement) {
          const i = this.parentElement.children.indexOf(this);
          if (i >= 0) this.parentElement.children.splice(i, 1);
          this.parentElement = null;
        }
      },
      addEventListener(evt, fn) {
        if (!listeners.has(evt)) listeners.set(evt, []);
        listeners.get(evt).push(fn);
      },
      dispatchEvent(evt) {
        evt.target = evt.target || node;
        if (typeof evt.stopPropagation !== 'function') evt.stopPropagation = () => {};
        if (typeof evt.composedPath !== 'function') evt.composedPath = () => [node, doc.body, doc.documentElement];
        for (const fn of listeners.get(evt.type) || []) fn(evt);
      },
      attachShadow() {
        const sr = makeNode('shadow', 'shadow-root');
        node.shadowRoot = sr;
        sr.host = node;
        return sr;
      },
      querySelector(sel) {
        const parts = sel.split(',').map((s) => s.trim()).filter(Boolean);
        const match = (n) =>
          parts.some((p) => {
            const m = p.match(/^\[([^=]+)="([^"]+)"\]$/);
            if (m) return n.getAttribute(m[1]) === m[2];
            if (p.startsWith('#')) return n.id === p.slice(1);
            if (p.startsWith('.')) return n.classList.contains(p.slice(1));
            return n.tagName === p.toUpperCase();
          });
        for (const c of children) {
          if (match(c)) return c;
          const deep = c.querySelector(sel);
          if (deep) return deep;
        }
        return null;
      },
      querySelectorAll(sel) {
        const out = [];
        const tags = sel.split(',').map((s) => s.trim().toUpperCase());
        for (const c of children) {
          if (sel === '*' || tags.includes(c.tagName) || (sel.startsWith('.') && c.classList.contains(sel.slice(1)))) {
            out.push(c);
          }
          out.push(...c.querySelectorAll(sel));
        }
        return out;
      },
      getBoundingClientRect() { return rectFn(); },
      _setRectFn(fn) { rectFn = fn; },
    };
    node.classList = makeClassList(node);
    return node;
  }

  const head = makeNode('head');
  const body = makeNode('body');
  const html = makeNode('html');
  html.appendChild(head);
  html.appendChild(body);

  const footer = makeNode('div');
  footer.classList.add('agy-composer-footer');
  const footerLeft = makeNode('div');
  const modelBtn = makeNode('button');
  modelBtn.textContent = modelText;
  footerLeft.appendChild(modelBtn);
  const rightCtrl = makeNode('div');
  rightCtrl.appendChild(makeNode('button'));
  footer.appendChild(footerLeft);
  footer.appendChild(rightCtrl);
  body.appendChild(footer);

  // Set dynamic layout rects so narrow degradation tests work realistically
  footer._setRectFn(() => ({ left: 0, right: footerWidthVal, top: 500, bottom: 540, width: footerWidthVal, height: 40 }));
  footerLeft._setRectFn(() => ({ left: 0, right: Math.max(0, footerWidthVal - rightControlsWidth), top: 500, bottom: 540, width: Math.max(0, footerWidthVal - rightControlsWidth), height: 40 }));
  rightCtrl._setRectFn(() => ({ left: Math.max(0, footerWidthVal - rightControlsWidth), right: footerWidthVal, top: 500, bottom: 540, width: rightControlsWidth, height: 40 }));
  modelBtn._setRectFn(() => ({ left: 8, right: 8 + (modelBtn.classList.contains('agc-model-squeezed') ? 70 : modelWidthVal), top: 505, bottom: 535, width: modelBtn.classList.contains('agc-model-squeezed') ? 70 : modelWidthVal, height: 30 }));

  const doc = {
    documentElement: html,
    head,
    body,
    createElement(tag) { return makeNode(tag); },
    getElementById(id) {
      const search = (n) => {
        if (n.id === id) return n;
        for (const c of n.children) {
          const hit = search(c);
          if (hit) return hit;
        }
        return null;
      };
      return search(html);
    },
    querySelector(sel) {
      if (sel === '.agy-composer-footer > div:first-child') return this.querySelectorAll(sel)[0] || null;
      if (sel.startsWith('#')) return this.getElementById(sel.slice(1));
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.agy-composer-footer > div:first-child') {
        const out = [];
        for (const f of doc.body.children) {
          if (f.classList.contains('agy-composer-footer') && f.children[0]) {
            out.push(f.children[0]);
          }
        }
        return out;
      }
      return [];
    },
    addEventListener(evt, fn) {
      if (!docListeners.has(evt)) docListeners.set(evt, []);
      docListeners.get(evt).push(fn);
    },
    removeEventListener(evt, fn) {
      const arr = docListeners.get(evt);
      if (arr) docListeners.set(evt, arr.filter((f) => f !== fn));
    },
  };

  class FakeObserver {
    observe() {}
    disconnect() {}
  }

  const parsedUrl = new URL(url);
  const context = {
    location: { protocol: parsedUrl.protocol, hostname: parsedUrl.hostname, pathname: parsedUrl.pathname },
    document: doc,
    navigator: { language: 'en-US', languages: ['en-US'] },
    window: null,
    MutationObserver: FakeObserver,
    ResizeObserver: FakeObserver,
    getComputedStyle(n) {
      return {
        display: n.classList?.contains('agc-hide-all') ? 'none' : (n.style.display || 'flex'),
        visibility: n.style.visibility || 'visible',
        opacity: n.style.opacity || '1',
        position: n.style.position || 'static',
        overflowX: 'visible',
        paddingRight: '0px',
        getPropertyValue: () => '',
        backgroundColor: '#141416',
        ...(n._cs || {}),
      };
    },
    setInterval(_fn, ms) {
      intervals.push(ms);
      return intervals.length;
    },
    clearInterval() {},
    setTimeout,
    clearTimeout,
    Intl,
    URL,
    Math,
    Date,
    Number,
    String,
    Array,
    Object,
    Set,
    Map,
    RegExp,
    JSON,
    console,
  };
  context.window = context;
  context.globalThis = context;
  context.innerWidth = footerWidthVal;
  context.addEventListener = (evt, fn) => {
    if (!winListeners.has(evt)) winListeners.set(evt, []);
    winListeners.get(evt).push(fn);
  };
  context.removeEventListener = (evt, fn) => {
    const arr = winListeners.get(evt);
    if (arr) winListeners.set(evt, arr.filter((f) => f !== fn));
  };

  vm.runInNewContext(buildRuntimeBundle(2000), context);

  // Wire strip rect based on active degradation classes so narrow stages step cleanly
  const host = doc.getElementById('agy-capsule-host');
  const strip = host.shadowRoot.querySelector('[data-el="strip"]');
  strip._setRectFn(() => {
    if (strip.classList.contains('agc-hide-all')) return { left: 0, right: 0, width: 0, height: 0, top: 505, bottom: 535 };
    const mRight = modelBtn.getBoundingClientRect().right;
    let w = 220; // full: ctx + speed + 5h + wk
    if (strip.classList.contains('agc-hide-speed')) w -= 70;
    if (strip.classList.contains('agc-hide-wk') || strip.classList.contains('agc-hide-5h')) w -= 45;
    if (strip.classList.contains('agc-hide-qval')) w -= 30;
    if (strip.classList.contains('agc-hide-cval')) w -= 25;
    if (strip.classList.contains('agc-hide-quota')) w = 26;
    const left = mRight + 6;
    return { left, right: left + w, width: w, height: 24, top: 505, bottom: 530 };
  });

  return {
    context,
    doc,
    intervals,
    makeNode,
    footer,
    footerLeft,
    host,
    strip,
    modelBtn,
    setWidths(fw, mw = modelWidthVal) {
      footerWidthVal = fw;
      modelWidthVal = mw;
      context.innerWidth = fw;
    },
    setModelText(txt) {
      modelBtn.textContent = txt;
      host.shadowRoot.querySelector('[data-el="btnQuota"]'); // ensure exists
    },
  };
}

test('1. Protobuf & stat-gated SQLite telemetry with compaction reset and zero redundant reads', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cap-db-'));
  const convDir = join(dir, 'conversations');
  const stateDir = join(dir, 'state');
  const convId = '11111111-1111-1111-1111-111111111111';

  try {
    const dbPath = join(convDir, `${convId}.db`);
    const { mkdirSync } = await import('node:fs');
    mkdirSync(convDir, { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)');

    // Pre-compaction turn + compaction checkpoint at step 4 + post-compaction turn at step 6
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
      0,
      encodeGenRow({ uncachedIn: 180000, cachedIn: 20000, thinkTokens: 3000, outTokens: 1500, maxContextTokens: 256000, lastStepIndex: 2 })
    );
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
      1,
      encodeGenRow({ uncachedIn: 6000, cachedIn: 154000, thinkTokens: 800, outTokens: 400, maxContextTokens: 256000, lastStepIndex: 6 })
    );

    const stepEpochSec = 1_760_000_000;
    db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(1, 1, encodeStepMeta(stepEpochSec - 500));
    db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(4, 23, encodeStepMeta(stepEpochSec - 100));
    db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(6, 2, encodeStepMeta(stepEpochSec));
    db.close();

    // Direct decoder checks
    const decodedStepTs = parseStepTimestampMs(encodeStepMeta(stepEpochSec, 250_000_000));
    assert.equal(decodedStepTs, stepEpochSec * 1000 + 250);
    const parsedRow = parseGenMetadataRow(1, encodeGenRow({ uncachedIn: 6000, cachedIn: 154000, thinkTokens: 800, outTokens: 400, maxContextTokens: 256000, lastStepIndex: 6 }));
    assert.equal(parsedRow.inputTokens, 160000);
    assert.equal(parsedRow.actualTokens, 160400);
    assert.equal(findCompactionEpochStart([
      { inputTokens: 200000, lastStepIndex: 2 },
      { inputTokens: 160000, lastStepIndex: 6 },
    ], [4]), 1);

    const svc = createTelemetryService({
      convDir,
      stateDir,
      lsAddress: '127.0.0.1:9999',
      csrfToken: 'test-csrf',
      fetchImpl: async (url) => {
        if (url.includes('RetrieveUserQuotaSummary')) {
          return {
            ok: true,
            json: async () => ({
              groups: [
                {
                  displayName: 'Gemini Models',
                  buckets: [
                    { window: '5h', remainingFraction: 0.9, resetTime: new Date(Date.now() + 3600_000).toISOString() },
                    { window: 'weekly', remainingFraction: 0.96, resetTime: new Date(Date.now() + 86400_000).toISOString() },
                  ],
                },
              ],
            }),
          };
        }
        return { ok: true, json: async () => ({}) };
      },
    });

    const snap1 = await svc.getSnapshot({ convId, lang: 'en' });
    assert.equal(snap1.latest.freshInput, 6000);
    assert.equal(snap1.latest.cached, 154000);
    assert.equal(snap1.latest.input, 160000);
    assert.equal(snap1.latest.output, 400);
    assert.equal(snap1.latest.actual, 160400);
    assert.equal(snap1.latest.budget, 256000);
    assert.equal(snap1.latest.lastStepEpochMs, stepEpochSec * 1000);
    assert.equal(svc.getMetrics().sqliteReads, 1);
    assert.equal(svc.getMetrics().statCacheHits, 0);

    // Repeat snapshot with unchanged DB stats -> must hit stat cache (0 SQLite reads)
    const snap2 = await svc.getSnapshot({ convId, lang: 'en' });
    assert.equal(snap2.rev, snap1.rev);
    assert.equal(svc.getMetrics().sqliteReads, 1);
    assert.equal(svc.getMetrics().statCacheHits, 1);

    // Append a new turn to DB -> must re-read SQLite and update values
    const db2 = new DatabaseSync(dbPath);
    db2.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
      2,
      encodeGenRow({ uncachedIn: 2500, cachedIn: 160000, thinkTokens: 300, outTokens: 600, maxContextTokens: 256000, lastStepIndex: 8 })
    );
    db2.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(8, 2, encodeStepMeta(stepEpochSec + 45));
    db2.close();

    const snap3 = await svc.getSnapshot({ convId, lang: 'en' });
    assert.notEqual(snap3.rev, snap2.rev);
    assert.equal(snap3.latest.input, 162500);
    assert.equal(snap3.latest.output, 600);
    assert.equal(snap3.latest.actual, 163100);
    assert.equal(svc.getMetrics().sqliteReads, 2);

    svc.dispose();

    // Live in-flight lifecycle detection: historical idle -> live USER_INPUT + 40s TTFT -> completed turn settles cleanly
    let fakeNow = 1_760_001_000_000;
    const svcLive = createTelemetryService({
      convDir,
      stateDir,
      nowFn: () => fakeNow,
      lsAddress: '127.0.0.1:9999',
      csrfToken: 'test-csrf',
      fetchImpl: async (url) => {
        if (url.includes('RetrieveUserQuotaSummary')) return { ok: true, json: async () => ({ groups: [] }) };
        if (url.includes('GetUserStatus')) return { ok: true, json: async () => ({ userStatus: {} }) };
        if (url.includes('GetCascadeTrajectoryGeneratorMetadata')) return { ok: true, json: async () => ({ generatorMetadata: [] }) };
        return { ok: true, json: async () => ({}) };
      },
    });
    const idleSnap = await svcLive.getSnapshot({ convId, lang: 'en' });
    assert.equal(idleSnap.isTurnInFlight, false);

    // Insert live USER_INPUT (step_type=1) at fakeNow
    const dbLive1 = new DatabaseSync(dbPath);
    dbLive1.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(9, 1, encodeStepMeta(Math.floor(fakeNow / 1000)));
    dbLive1.close();
    const waitTtft1 = await svcLive.getSnapshot({ convId, lang: 'en' });
    assert.equal(waitTtft1.isTurnInFlight, true);

    // Simulate 40s TTFT wait with no new writes yet -> still in-flight
    fakeNow += 40_000;
    const waitTtft2 = await svcLive.getSnapshot({ convId, lang: 'en' });
    assert.equal(waitTtft2.isTurnInFlight, true);

    // Simulate turn completion: gen_metadata row + PLANNER_RESPONSE (step_type=2, step idx 10 > lastStepIndex 9)
    const dbLive2 = new DatabaseSync(dbPath);
    dbLive2.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
      3,
      encodeGenRow({ uncachedIn: 1200, cachedIn: 161000, thinkTokens: 200, outTokens: 300, maxContextTokens: 256000, lastStepIndex: 9 })
    );
    dbLive2.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(10, 2, encodeStepMeta(Math.floor(fakeNow / 1000)));
    dbLive2.close();
    const settling = await svcLive.getSnapshot({ convId, lang: 'en' });
    assert.equal(settling.isTurnInFlight, true);

    fakeNow += 3_000;
    const settled = await svcLive.getSnapshot({ convId, lang: 'en' });
    assert.equal(settled.isTurnInFlight, false);
    svcLive.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('2. Speed, TTFT, error classification, image sizing, and 7-category 100% convergence', () => {
  const summary = core.summarizeGeneratorMeta(
    {
      chatModel: {
        modelDisplayName: 'Gemini 4 Hydrogen (High)',
        timeToFirstToken: '0.80s',
        streamingDuration: '3.20s',
        usage: {
          inputTokens: 4000,
          cacheReadTokens: 96000,
          outputTokens: 200,
          thinkingOutputTokens: 40,
        },
        chatStartMetadata: {
          contextWindowMetadata: { maxContextTokens: 256000, estimatedTokensUsed: 98000 },
        },
      },
    },
    { lang: 'zh-TW' }
  );
  assert.equal(summary.actual, 100200);
  assert.equal(summary.modelLabel, 'Gemini 4 Hydrogen');
  assert.equal(summary.speed.ttft, 0.8);
  assert.equal(summary.speed.duration, 4.0);
  assert.equal(summary.speed.tps, 50.0);
  assert.equal(summary.speed.streamingTps, 62.5);
  assert.equal(summary.speed.label, '流暢');

  const errOverflow = core.classifyRequestError('prompt exceeds maximum context length: 256,000', { lang: 'zh-CN' });
  assert.equal(errOverflow.kind, 'context_overflow');
  assert.equal(errOverflow.serviceLimit, 256000);
  assert.ok(errOverflow.detail.includes('256k'));
  assert.ok(errOverflow.detail.includes('/compact'));

  const errRate = core.classifyRequestError('HTTP 429 rate limit exceeded, retry in 12s', { lang: 'en' });
  assert.equal(errRate.kind, 'rate_limited');
  assert.equal(errRate.retryAfterSec, 12);

  // PNG binary header (1200x900)
  const png = Buffer.alloc(24);
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(png, 0);
  png.writeUInt32BE(1200, 16);
  png.writeUInt32BE(900, 20);
  const dims = getImageDimensions(png);
  assert.deepEqual(dims, { width: 1200, height: 900 });
  const [lowTok] = calcImageTokens(dims.width, dims.height);
  assert.equal(lowTok, 2 * 2 * 258);

  // Post-compaction slicing + 7-category 100.0% convergence
  const analyzed = core.analyzeSteps([
    { userInput: { userResponse: 'old prompt ignored' } },
    { checkpoint: { sessionSummary: 'Compacted summary text here' } },
    { userInput: { userResponse: 'Current question about module' } },
    { plannerResponse: { response: 'Detailed answer body', thinking: 'Internal reasoning chain' } },
  ]);
  assert.equal(analyzed.compacted, true);
  assert.equal(analyzed.activeSteps, 3);
  assert.equal(analyzed.userMessages, 1);

  const { shares } = core.computeContextShares([
    { id: 'system', weight: 1000 },
    { id: 'tools', weight: 333 },
    { id: 'assistant', weight: 500 },
    { id: 'thinking', weight: 250 },
    { id: 'user', weight: 125 },
    { id: 'summaries', weight: 77 },
    { id: 'attachment-total', weight: 1 },
  ]);
  assert.equal(shares['attachment-total'].text, '<0.1%');
  const majorSum = ['system', 'tools', 'assistant', 'thinking', 'user', 'summaries']
    .reduce((acc, k) => acc + shares[k].percent, 0);
  assert.ok(Math.abs(majorSum - 100) <= 0.15, `expected ~100%, got ${majorSum}`);

  assert.equal(core.fmtK(1990), '2.0k');
  assert.equal(core.fmtK(1620), '1.6k');
  assert.equal(core.fmtK(286100), '286k');
  assert.equal(core.fmtColK(267700), '267.7k');

  const equalShares = core.computeContextShares([
    { id: 'a', weight: 1 },
    { id: 'b', weight: 1 },
    { id: 'c', weight: 1 },
  ]);
  const eqSum = Math.round((equalShares.shares.a.percent + equalShares.shares.b.percent + equalShares.shares.c.percent) * 10);
  assert.equal(eqSum, 1000);
});

test('3. Active model to multi-group quota matching (including Orchestrator Carbon & Weekly-only Argon)', () => {
  const groups = core.normalizeQuotaGroups([
    {
      displayName: 'Gemini Models',
      description: 'Models within this group: Gemini 4 Hydrogen, Gemini 3.8 Flash',
      buckets: [
        { window: '5h', remainingFraction: 0.9, resetTime: '2026-11-16T16:00:00Z' },
        { window: 'weekly', remainingFraction: 0.96, resetTime: '2026-11-22T00:00:00Z' },
      ],
    },
    {
      displayName: 'Claude and GPT models',
      buckets: [
        { window: '5h', remainingFraction: 0.95, resetTime: '2026-11-16T16:00:00Z' },
        { window: 'weekly', remainingFraction: 0.82, resetTime: '2026-11-22T00:00:00Z' },
      ],
    },
    {
      displayName: 'Gemini 4 Argon',
      buckets: [
        { window: 'weekly', remainingFraction: 0.94, resetTime: '2026-11-22T00:00:00Z' },
      ],
    },
    {
      displayName: 'Gemini 4 Carbon',
      buckets: [
        { window: '5h', remainingFraction: 0.72, resetTime: '2026-11-16T15:00:00Z' },
        { window: 'weekly', remainingFraction: 0.88, resetTime: '2026-11-22T00:00:00Z' },
      ],
    },
  ]);

  assert.equal(core.matchModelQuotaGroup('Gemini 4 Hydrogen High', groups).title, 'Gemini');
  assert.equal(core.matchModelQuotaGroup('Orchestrator (Carbon)', groups).q5hPct, 72);
  assert.equal(core.matchModelQuotaGroup('Gemini 4 Argon', groups).q5hPct, null);
  assert.equal(core.matchModelQuotaGroup('Gemini 4 Argon', groups).qWkPct, 94);
  assert.equal(core.matchModelQuotaGroup('Claude Sonnet 4.5 (Thinking)', groups).title, 'Claude');
  assert.equal(core.matchModelQuotaGroup('Gemini 3.8 Flash', groups).title, 'Gemini');
});

test('4. Renderer Shadow DOM mount, popovers, 3m/4m cache cooling, i18n, narrow fallback & supersede', () => {
  const h = createRendererHarness({ modelText: 'Orchestrator (Carbon)', footerWidth: 700, modelWidth: 160, rightControlsWidth: 120 });
  const api = h.context.__agyCapsule;
  assert.ok(api, 'window.__agyCapsule should be registered');
  assert.deepEqual(h.intervals, [30000]);

  const cState = api.pullClientState(2000);
  assert.equal(cState.convId, '11111111-1111-1111-1111-111111111111');
  assert.equal(api.pullClientState(1500), 'superseded');

  const now = Date.now();
  const quotaGroups = core.normalizeQuotaGroups([
    {
      displayName: 'Gemini Models',
      buckets: [
        { window: '5h', remainingFraction: 0.9, resetTime: new Date(now + 3600_000).toISOString() },
        { window: 'weekly', remainingFraction: 0.96, resetTime: new Date(now + 86400_000).toISOString() },
      ],
    },
    {
      displayName: 'Gemini 4 Carbon',
      buckets: [
        { window: '5h', remainingFraction: 0.72, resetTime: new Date(now + 3600_000).toISOString() },
        { window: 'weekly', remainingFraction: 0.88, resetTime: new Date(now + 86400_000).toISOString() },
      ],
    },
  ]);

  api.applyServerState({
    rev: 'r1',
    convId: '11111111-1111-1111-1111-111111111111',
    prefs: { langMode: 'auto', themeMode: 'dark' },
    quotaGroups,
    isTurnInFlight: false,
    scanBusy: false,
    latest: {
      actual: 163800,
      budget: 256000,
      percent: 64,
      input: 160000,
      cached: 153600,
      freshInput: 6400,
      output: 3800,
      lastStepEpochMs: now - 30_000,
      speed: { tps: 48.2, streamingTps: 61.0, ttft: 0.84, duration: 4.2, outputTokens: 202, thinkingTokens: 50 },
      errorClassification: { kind: 'none' },
    },
    scan: {
      steps: 24,
      activeSteps: 18,
      compacted: false,
      userMessages: 4,
      assistantMessages: 4,
      unknownFiles: 0,
      totalWeight: 1000,
      shares: {
        system: { ratio: 0.2, text: '20.0%' },
        tools: { ratio: 0.3, text: '30.0%' },
        assistant: { ratio: 0.2, text: '20.0%' },
        thinking: { ratio: 0.1, text: '10.0%' },
        user: { ratio: 0.1, text: '10.0%' },
        summaries: { ratio: 0, text: '0%' },
        'attachment-total': { ratio: 0.1, text: '10.0%' },
      },
      scannedAt: now,
    },
  });

  let snap = api.snapshotForTest();
  assert.equal(snap.docked, true);
  assert.equal(snap.pillCtx, '64%');
  assert.equal(snap.pillSpeedHidden, false);
  assert.equal(snap.pillSpeed, '48.2 tok/s');
  assert.equal(snap.pillSpeedState, 'idle');
  assert.equal(snap.pill5h, '72%');
  assert.equal(snap.pillWk, '88%');
  assert.equal(snap.cachePct, '96%');
  assert.equal(snap.cacheBadge, '');
  assert.equal(snap.heroPct, '64% used');
  assert.equal(snap.heroFrac, '163.8k / 256k');
  assert.equal(snap.valSpeed, '48.2 tok/s');
  assert.equal(snap.speedTier, 'Smooth');
  assert.equal(snap.valTiming, 'TTFT 0.84s · 4.20s');
  assert.equal(snap.valOut, 'Out 202');
  assert.equal(snap.valSteps, '18 steps');

  const sr = h.host.shadowRoot;
  assert.equal(sr.querySelector('[data-val="tools"]').textContent, '30.0%');
  assert.equal(sr.querySelector('[data-k="tools"]').textContent, '49.1k');
  assert.equal(sr.querySelector('[data-row="tools"]').getAttribute('data-tier'), 'dom');
  assert.equal(sr.querySelector('[data-row="summaries"]').getAttribute('data-tier'), 'dim');
  assert.ok(sr.querySelector('[data-el="cacheIcon"]').innerHTML.includes('var(--agc-good)'));
  assert.equal(sr.querySelector('[data-el="heroFrac"]').children.length, 2);
  assert.equal(sr.querySelector('[data-el="valSpeed"]').getAttribute('data-tier'), 'smooth');
  assert.equal(sr.querySelector('[data-el="speedTier"]').getAttribute('data-tier'), 'smooth');
  assert.equal(
    sr.querySelector('[data-el="valSpeed"]').title,
    'Streaming 61 tok/s · TTFT 0.84s (20%)\nOverall = Output ÷ Total time (incl. TTFT)'
  );
  assert.equal(sr.querySelector('[data-el="valOut"]').title, 'Output 202 tokens · Reply 152 + Thinking 50');
  assert.ok(sr.querySelector('[data-el="heroPct"]').title.includes('Cached 153.6k · Fresh in 6.4k · Out 3.8k'));
  assert.equal(sr.querySelector('[data-el="cacheRow"]').title, 'Cache hit 153,600 / 160,000 tokens · Last turn <1m ago');
  assert.ok(sr.querySelector('[data-val="tools"]').title.includes('~49,140 tokens (30.0%)'));
  assert.equal(sr.querySelector('[data-el="valTiming"]').title, 'TTFT 0.84s · Total 4.20s');

  // Active in-flight generation shows live speed on inline capsule
  api.applyServerState({
    rev: 'r2',
    convId: '11111111-1111-1111-1111-111111111111',
    prefs: { langMode: 'auto', themeMode: 'dark' },
    quotaGroups,
    isTurnInFlight: true,
    scanBusy: false,
    latest: {
      actual: 163800,
      budget: 256000,
      percent: 64,
      input: 160000,
      cached: 153600,
      freshInput: 6400,
      output: 1990,
      lastStepEpochMs: now - 30_000,
      speed: { tps: 48.2, streamingTps: 61.0, ttft: 0.84, duration: 4.2, outputTokens: 1990, thinkingTokens: 50 },
      errorClassification: { kind: 'none' },
    },
    scan: null,
  });
  snap = api.snapshotForTest();
  assert.equal(snap.pillSpeedHidden, false);
  assert.equal(snap.pillSpeedState, 'active');
  assert.equal(snap.pillSpeed, '48.2 tok/s');
  assert.equal(snap.valOut, 'Out 2.0k');
  assert.equal(sr.querySelector('[data-el="pillSpeed"]').getAttribute('data-tier'), 'smooth');

  // Cache 3m warning & 4m expired transitions (minute-granular tooltip copy)
  api.tickClockForTest(now - 30_000 + 190_000); // 190s idle (>3m)
  snap = api.snapshotForTest();
  assert.equal(snap.cacheBadge, '~1m');
  assert.equal(sr.querySelector('[data-el="cacheRow"]').title, 'Cache hit 153,600 / 160,000 tokens · Idle 3m (expires in ~1m)');

  api.tickClockForTest(now - 30_000 + 250_000); // 250s idle (>=4m)
  snap = api.snapshotForTest();
  assert.equal(snap.cacheBadge, 'Expired');
  assert.equal(snap.cacheDeco, 'line-through');
  assert.equal(sr.querySelector('[data-el="cacheRow"]').title, 'Cached 153,600 / 160,000 tokens · Idle 4m (>4m likely cold)');

  // Interactive click-to-pin + language cycle + force refresh
  sr.querySelector('[data-el="btnCtx"]').dispatchEvent({ type: 'click' });
  assert.equal(api.snapshotForTest().pinnedPop, 'ctx');
  assert.equal(api.pullClientState(2000).wantScan, true);

  sr.querySelector('[data-el="btnLang"]').dispatchEvent({ type: 'click' }); // en -> zh-CN
  assert.equal(api.snapshotForTest().lang, 'zh-CN');
  sr.querySelector('[data-el="btnLang"]').dispatchEvent({ type: 'click' }); // zh-CN -> zh-TW
  assert.equal(api.snapshotForTest().lang, 'zh-TW');
  assert.equal(api.pullClientState(2000).prefsPatch.langMode, 'zh-TW');

  sr.querySelector('[data-el="btnRefresh"]').dispatchEvent({ type: 'click' });
  assert.equal(api.pullClientState(2000).forceScan, true);

  // High occupancy alert must render concise zh-TW copy with inline flow (no flex column split)
  api.applyServerState({
    rev: 'r3',
    convId: '11111111-1111-1111-1111-111111111111',
    prefs: { langMode: 'zh-TW', themeMode: 'dark' },
    quotaGroups,
    isTurnInFlight: false,
    scanBusy: false,
    latest: {
      actual: 500200,
      budget: 512000,
      percent: 98,
      input: 499000,
      cached: 0,
      freshInput: 499000,
      output: 1200,
      lastStepEpochMs: now - 10_000,
      speed: { tps: 10.9, ttft: 35.4, duration: 40.0, outputTokens: 438 },
      errorClassification: { kind: 'none' },
    },
    scan: null,
  });
  const alertBanner = sr.querySelector('[data-el="alertBanner"]');
  assert.equal(alertBanner.hidden, false);
  assert.equal(alertBanner.getAttribute('data-tone'), 'danger');
  assert.deepEqual(alertBanner.children.map((c) => c.tagName), ['SPAN', 'CODE', 'SPAN']);
  assert.equal(alertBanner.textContent, '建議 /compact 壓縮或開啟新對話');
  assert.equal(sr.querySelector('[data-el="valSpeed"]').getAttribute('data-tier'), 'fair');
  assert.equal(sr.querySelector('[data-el="speedTier"]').getAttribute('data-tier'), 'fair');
  assert.equal(api.snapshotForTest().pillSpeedState, 'recent');
  api.tickClockForTest(Date.now() + 16_000);
  assert.equal(api.snapshotForTest().pillSpeedState, 'idle');

  // Slow in-flight speed tier must sync color tier across pillSpeed, valSpeed, and speedTier
  api.applyServerState({
    rev: 'r4',
    convId: '11111111-1111-1111-1111-111111111111',
    prefs: { langMode: 'zh-TW', themeMode: 'dark' },
    quotaGroups,
    isTurnInFlight: true,
    scanBusy: false,
    latest: {
      actual: 51200,
      budget: 256000,
      percent: 20,
      input: 51000,
      cached: 40000,
      freshInput: 11000,
      output: 200,
      lastStepEpochMs: now - 5_000,
      speed: { tps: 2.1, ttft: 39.3, duration: 39.5, outputTokens: 82 },
      errorClassification: { kind: 'none' },
    },
    scan: null,
  });
  assert.equal(sr.querySelector('[data-el="pillSpeed"]').getAttribute('data-tier'), 'slow');
  assert.equal(sr.querySelector('[data-el="valSpeed"]').getAttribute('data-tier'), 'slow');
  assert.equal(sr.querySelector('[data-el="speedTier"]').getAttribute('data-tier'), 'slow');
  assert.ok(sr.querySelector('[data-el="valSpeed"]').title.includes('TTFT 39.3s (佔 99%)'));
  assert.ok(sr.querySelector('[data-el="valSpeed"]').title.includes('整體速率 = 產出 ÷ 總耗時 (含 TTFT)'));
  assert.ok(!sr.querySelector('[data-el="btnTheme"]').title.includes('（'), 'tooltip must avoid wide fullwidth parens');
  assert.equal(sr.querySelector('[data-el="speedTier"]').title, sr.querySelector('[data-el="valSpeed"]').title);
  assert.equal(sr.querySelector('[data-el="pillSpeed"]').title, sr.querySelector('[data-el="valSpeed"]').title);

  // Quota popover unification: linear 4px bars, hairline hierarchy, low-quota tones & Weekly-only collapse
  const quotaHtml = sr.querySelector('[data-el="quotaRoot"]').innerHTML;
  assert.ok(quotaHtml.includes('agc-q-bar') && quotaHtml.includes('agc-q-fill'), 'quota popover must use linear bars matching context card');
  assert.ok(quotaHtml.includes('agc-q-active') && quotaHtml.includes('目前'), 'active quota pool must show balanced right badge');
  assert.ok(!quotaHtml.includes('<circle'), 'legacy donut rings must be removed');

  const lowAndArgonGroups = core.normalizeQuotaGroups([
    {
      displayName: 'Gemini 4 Carbon',
      buckets: [
        { window: '5h', remainingFraction: 0.08, resetTime: new Date(now + 1800_000).toISOString() },
        { window: 'weekly', remainingFraction: 0.22, resetTime: new Date(now + 86400_000).toISOString() },
      ],
    },
    {
      displayName: 'Gemini 4 Argon',
      buckets: [{ window: 'weekly', remainingFraction: 0.94, resetTime: new Date(now + 86400_000).toISOString() }],
    },
  ]);
  api.applyServerState({
    rev: 'r5',
    convId: '11111111-1111-1111-1111-111111111111',
    prefs: { langMode: 'zh-TW', themeMode: 'dark' },
    quotaGroups: lowAndArgonGroups,
    isTurnInFlight: false,
    scanBusy: false,
    latest: null,
    scan: null,
  });
  const pair5h = sr.querySelector('[data-el="pair5h"]');
  const pairWk = sr.querySelector('[data-el="pairWk"]');
  assert.equal(pair5h.getAttribute('data-tone'), 'danger');
  assert.equal(pairWk.getAttribute('data-tone'), 'warn');
  assert.equal(pair5h.hidden, false);
  assert.equal(api.snapshotForTest().pillSpeedHidden, true);
  const lowQuotaHtml = sr.querySelector('[data-el="quotaRoot"]').innerHTML;
  assert.ok(lowQuotaHtml.includes('data-tone="danger"') && lowQuotaHtml.includes('data-tone="warn"'));

  h.setModelText('Gemini 4 Argon');
  api.applyServerState({
    rev: 'r6',
    convId: '11111111-1111-1111-1111-111111111111',
    prefs: { langMode: 'zh-TW', themeMode: 'dark' },
    quotaGroups: lowAndArgonGroups,
    isTurnInFlight: false,
    scanBusy: false,
    latest: null,
    scan: null,
  });
  assert.equal(pair5h.hidden, true);
  assert.equal(pairWk.hidden, false);
  assert.equal(api.snapshotForTest().pillWk, '94%');

  // Restore dual-window Carbon model & check trace (<0.1k / dim) tier before narrow degradation checks
  h.setModelText('Orchestrator (Carbon)');
  api.applyServerState({
    rev: 'r7',
    convId: '11111111-1111-1111-1111-111111111111',
    prefs: { langMode: 'zh-TW', themeMode: 'dark' },
    quotaGroups,
    isTurnInFlight: false,
    scanBusy: false,
    latest: {
      actual: 210100,
      budget: 512000,
      percent: 41,
      input: 208800,
      cached: 202500,
      freshInput: 6300,
      output: 1300,
      lastStepEpochMs: now - 15_000,
      speed: { tps: 147.1, ttft: 3.28, duration: 8.57, outputTokens: 1300 },
      errorClassification: { kind: 'none' },
    },
    scan: {
      steps: 202,
      activeSteps: 202,
      compacted: false,
      userMessages: 3,
      assistantMessages: 3,
      unknownFiles: 0,
      totalWeight: 10000,
      shares: {
        system: { weight: 90, ratio: 0.009, text: '0.9%' },
        tools: { weight: 9790, ratio: 0.979, text: '97.9%' },
        assistant: { weight: 20, ratio: 0.002, text: '0.2%' },
        thinking: { weight: 80, ratio: 0.008, text: '0.8%' },
        user: { weight: 2, ratio: 0.0002, text: '<0.1%' },
        summaries: { weight: 20, ratio: 0.002, text: '0.2%' },
        'attachment-total': { weight: 5, ratio: 0.0005, text: '<0.1%' },
      },
      scannedAt: now,
    },
  });
  assert.equal(pair5h.hidden, false);
  assert.equal(pairWk.hidden, false);
  assert.equal(sr.querySelector('[data-row="tools"]').getAttribute('data-tier'), 'dom');
  assert.equal(sr.querySelector('[data-row="system"]').getAttribute('data-tier'), 'act');
  assert.equal(sr.querySelector('[data-row="user"]').getAttribute('data-tier'), 'dim');
  assert.equal(sr.querySelector('[data-k="user"]').textContent, '<0.1k');

  // Verify hover bridge lives on .agc-pop-wrap (NOT .agc-pop) so scrollbars don't appear
  const rendererSrc = readFileSync(join(REPO_ROOT, 'plugins/agy-capsule/sidecars/agy_capsule/renderer_client.js'), 'utf8');
  assert.ok(rendererSrc.includes('.agc-pop-wrap::after'), 'hover bridge must live on .agc-pop-wrap');
  assert.ok(!rendererSrc.includes('.agc-pop::after'), 'hover bridge must not be placed on scrollable .agc-pop');
  const dotCssMatch = rendererSrc.match(/\.agc-dot\s*\{([^}]*)\}/);
  assert.ok(dotCssMatch && dotCssMatch[1].includes('width: 6.5px;') && dotCssMatch[1].includes('border-radius: 50%;'));
  const alertCssMatch = rendererSrc.match(/\.agc-alert\s*\{([^}]*)\}/);
  assert.ok(alertCssMatch && alertCssMatch[1].includes('display: block;'), '.agc-alert must use display: block for inline text flow');
  assert.ok(!alertCssMatch[1].includes('display: flex'), '.agc-alert must not split inline children into flex columns');
  assert.ok(rendererSrc.includes('.agc-speed[data-tier="slow"] { color: var(--agc-danger); }'));
  assert.ok(rendererSrc.includes('.agc-tele-main[data-tier="slow"]'));
  const liveDotMatch = rendererSrc.match(/\.agc-live-dot\s*\{([^}]*)\}/);
  assert.ok(liveDotMatch && liveDotMatch[1].includes('background: currentColor;'), '.agc-live-dot must inherit speed tier color');

  // Narrow degradation progression
  h.setWidths(450, 160);
  const clsMid = api.adjustLayoutForTest();
  assert.ok(clsMid.includes('agc-hide-speed'), `expected speed hidden on 450px footer, got "${clsMid}"`);

  h.setWidths(240, 160);
  const clsTight = api.adjustLayoutForTest();
  assert.ok(clsTight.includes('agc-hide-cval') || clsTight.includes('agc-hide-all'), `expected tight collapse on 240px footer, got "${clsTight}"`);

  h.setWidths(140, 160);
  const clsTiny = api.adjustLayoutForTest();
  assert.ok(clsTiny.includes('agc-hide-all'), `expected full hide on 140px footer, got "${clsTiny}"`);

  // 1. Recovery from agc-hide-all: must NOT oscillate or stay stuck hidden
  h.setWidths(700, 160);
  assert.equal(api.adjustLayoutForTest(), '');
  assert.equal(api.adjustLayoutForTest(), '');

  // 2. Out-of-flow tooltip inside modelBtn & absolute menu overlay inside footer must NOT trigger hide/degrade
  const hiddenTip = h.makeNode('div');
  hiddenTip.style.position = 'absolute';
  hiddenTip.style.opacity = '0';
  hiddenTip._setRectFn(() => ({ left: 10, right: 650, top: 460, bottom: 495, width: 640, height: 35 }));
  h.modelBtn.appendChild(hiddenTip);

  const absMenu = h.makeNode('div');
  absMenu.style.position = 'absolute';
  absMenu._setRectFn(() => ({ left: 0, right: 600, top: 300, bottom: 500, width: 600, height: 200 }));
  h.footer.appendChild(absMenu);

  assert.equal(api.adjustLayoutForTest(), '');

  // 3. Multiple .agy-composer-footer instances: prepend hidden 0x0 composer -> host must stay on visible composer
  const hiddenFooter = h.makeNode('div');
  hiddenFooter.classList.add('agy-composer-footer');
  const hiddenLeft = h.makeNode('div');
  hiddenLeft._setRectFn(() => ({ left: 0, right: 0, top: 0, bottom: 0, width: 0, height: 0 }));
  hiddenFooter.appendChild(hiddenLeft);
  hiddenFooter.parentElement = h.doc.body;
  h.doc.body.children.unshift(hiddenFooter);

  api.pullClientState(3000);
  assert.equal(h.host.parentElement, h.footerLeft);

  // 4. v4 regression: host inline spacing + empty flex-1 spacer + 0px sibling gap must keep full dual capsules
  assert.ok(h.host.style.cssText.includes('margin-left: 6px'), 'host must keep inline margin-left');
  assert.ok(h.host.style.cssText.includes('margin-right: 6px'), 'host must keep inline margin-right');

  const emptySpacer = h.makeNode('div');
  emptySpacer.classList.add('flex-1');
  const origStripRect = h.strip.getBoundingClientRect.bind(h.strip);
  h.strip._setRectFn(() => {
    const r = origStripRect();
    if (r.width <= 0) return r;
    const mRight = h.modelBtn.getBoundingClientRect().right;
    return { ...r, left: mRight, right: mRight + r.width };
  });
  h.footerLeft._setRectFn(() => {
    const sr = h.strip.getBoundingClientRect();
    return { left: 0, right: sr.right, top: 500, bottom: 540, width: sr.right, height: 40 };
  });
  emptySpacer._setRectFn(() => {
    const flR = h.footerLeft.getBoundingClientRect().right;
    return { left: flR, right: 620, top: 500, bottom: 540, width: Math.max(0, 620 - flR), height: 40 };
  });
  h.footer.children.splice(1, 0, emptySpacer);
  emptySpacer.parentElement = h.footer;
  assert.equal(api.adjustLayoutForTest(), '');

  api.dispose();
  assert.equal(h.doc.getElementById('agy-capsule-host'), null);
});

test('5. Manifests, logo, CDP target filter, and server.mjs standalone import validation', () => {
  const pluginJson = JSON.parse(readFileSync(join(REPO_ROOT, 'plugins/agy-capsule/plugin.json'), 'utf8'));
  const sidecarJson = JSON.parse(readFileSync(join(REPO_ROOT, 'plugins/agy-capsule/sidecars/agy_capsule/sidecar.json'), 'utf8'));

  assert.equal(pluginJson.name, 'agy-capsule');
  assert.equal(pluginJson.version, '1.0.0');
  assert.equal(pluginJson.logo, 'assets/logo.svg');
  assert.ok(existsSync(join(REPO_ROOT, 'plugins/agy-capsule', pluginJson.logo)));
  assert.equal(sidecarJson.has_web_ui, false);
  assert.equal(sidecarJson.restart_policy, 'always');

  assert.equal(isAntigravityUiTarget({ type: 'page', url: 'https://127.0.0.1:5387/', webSocketDebuggerUrl: 'ws://127.0.0.1/page/1' }), true);
  assert.equal(isAntigravityUiTarget({ type: 'page', url: 'http://127.0.0.1:3000/', webSocketDebuggerUrl: 'ws://127.0.0.1/page/2' }), false);
  assert.equal(isAntigravityUiTarget({ type: 'other', url: 'https://127.0.0.1:5387/', webSocketDebuggerUrl: 'ws://127.0.0.1/page/3' }), false);

  const { hash } = buildRuntimeBundleWithHash(1234);
  assert.equal(CAPSULE_VERSION, 13);
  assert.equal(needsBundleInjection(null, hash), true);
  assert.equal(needsBundleInjection({ v: 12 }, hash), true);
  assert.equal(needsBundleInjection({ v: 13, hash: 'stale000' }, hash), true);
  assert.equal(needsBundleInjection({ v: 13, hash }, hash), false);
});

test('6. Tier-3 trajectory + attachment scan fusion and ui-prefs persistence', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cap-t3-'));
  const convDir = join(dir, 'conversations');
  const stateDir = join(dir, 'state');
  const convId = '22222222-2222-2222-2222-222222222222';
  mkdirSync(convDir, { recursive: true });

  try {
    const sampleTxt = join(dir, 'notes.md');
    writeFileSync(sampleTxt, 'Hello context viewer capsule integration test text.\n'.repeat(20), 'utf8');

    const dbPath = join(convDir, `${convId}.db`);
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
    db.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)');
    db.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
      0,
      encodeGenRow({ uncachedIn: 2000, cachedIn: 48000, thinkTokens: 100, outTokens: 250, maxContextTokens: 256000, lastStepIndex: 2 })
    );
    db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(0, 1, encodeStepMeta(1_760_000_000));
    db.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(2, 2, encodeStepMeta(1_760_000_010));
    db.close();

    const fetchMock = async (url) => {
      if (url.includes('RetrieveUserQuotaSummary')) {
        return { ok: true, json: async () => ({ groups: [] }) };
      }
      if (url.includes('GetUserStatus')) {
        return { ok: true, json: async () => ({ userStatus: { cascadeModelConfigData: { clientModelConfigs: [] } } }) };
      }
      if (url.includes('GetCascadeTrajectoryGeneratorMetadata')) {
        return {
          ok: true,
          json: async () => ({
            generatorMetadata: [
              {
                chatModel: {
                  modelDisplayName: 'Gemini 4 Hydrogen (High)',
                  timeToFirstToken: '0.60s',
                  streamingDuration: '2.40s',
                  systemPrompt: 'You are a helpful coding assistant.',
                  tools: [{ name: 'read_file' }, { name: 'edit_file' }],
                  usage: { inputTokens: 2000, cacheReadTokens: 48000, outputTokens: 250, thinkingOutputTokens: 100 },
                  chatStartMetadata: { contextWindowMetadata: { maxContextTokens: 256000 } },
                },
              },
            ],
          }),
        };
      }
      if (url.includes('GetCascadeTrajectory')) {
        return {
          ok: true,
          json: async () => ({
            numTotalSteps: 2,
            numTotalGeneratorMetadata: 1,
            trajectory: {
              steps: [
                { userInput: { userResponse: 'Analyze notes.md', media: [{ uri: sampleTxt, mimeType: 'text/markdown' }] } },
                { plannerResponse: { response: 'Done reviewing notes.md.', thinking: 'Checking contents carefully.' } },
              ],
            },
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    };

    const svc = createTelemetryService({ convDir, stateDir, lsAddress: '127.0.0.1:9999', csrfToken: 't', fetchImpl: fetchMock });
    const pre = await svc.getSnapshot({ convId, prefsPatch: { langMode: 'zh-TW', themeMode: 'light' } });
    assert.equal(pre.latest.speed.tps, 83.3);
    assert.equal(pre.latest.speed.label, '極速');
    assert.equal(pre.prefs.langMode, 'zh-TW');
    assert.equal(pre.prefs.themeMode, 'light');

    const scan = await svc.executeTier3Scan(convId, 'zh-TW', true);
    assert.ok(scan, 'Tier 3 scan result should exist');
    assert.equal(scan.steps, 2);
    assert.equal(scan.unknownFiles, 0);
    assert.equal(scan.attachments.length, 1);
    assert.ok(scan.shares['attachment-total'].ratio > 0);
    assert.ok(scan.shares.system.ratio > 0);

    const post = await svc.getSnapshot({ convId });
    assert.ok(post.scan);
    assert.notEqual(post.rev, pre.rev);
    svc.dispose();

    // Verify ui-prefs persisted cleanly to disk
    const svcReloaded = createTelemetryService({ convDir, stateDir, lsAddress: '127.0.0.1:9999', csrfToken: 't', fetchImpl: fetchMock });
    assert.deepEqual(svcReloaded.readPrefs(), { langMode: 'zh-TW', themeMode: 'light' });
    svcReloaded.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('7. v11/v12 UI: openPopover refresh, idempotent DOM writes, Xh Ym idle format, unknown files alert & optimistic prefs', () => {
  const h = createRendererHarness({ modelText: 'Gemini 4 Hydrogen High' });
  const api = h.context.__agyCapsule;
  const sr = h.host.shadowRoot;

  // Instrument DOM write counters on cacheIcon.innerHTML, cacheRow.title, and quotaRoot.innerHTML
  const writes = { cacheIcon: 0, cacheRowTitle: 0, quotaRoot: 0 };
  const spyProp = (obj, prop, counterKey) => {
    let val = obj[prop];
    Object.defineProperty(obj, prop, {
      configurable: true,
      get() {
        return val;
      },
      set(next) {
        writes[counterKey]++;
        val = next;
      },
    });
  };
  const cacheIcon = sr.querySelector('[data-el="cacheIcon"]');
  const cacheRow = sr.querySelector('[data-el="cacheRow"]');
  const quotaRoot = sr.querySelector('[data-el="quotaRoot"]');
  spyProp(cacheIcon, 'innerHTML', 'cacheIcon');
  spyProp(cacheRow, 'title', 'cacheRowTitle');
  spyProp(quotaRoot, 'innerHTML', 'quotaRoot');

  const now = Date.now();
  const quotaGroups = core.normalizeQuotaGroups([
    {
      displayName: 'Gemini Models',
      buckets: [
        { window: '5h', remainingFraction: 0.85, resetTime: new Date(now + 3630_000).toISOString() },
        { window: 'weekly', remainingFraction: 0.92, resetTime: new Date(now + 86430_000).toISOString() },
      ],
    },
  ]);

  api.applyServerState({
    rev: 'r1',
    convId: '11111111-1111-1111-1111-111111111111',
    prefs: { langMode: 'en', themeMode: 'dark' },
    quotaGroups,
    isTurnInFlight: false,
    scanBusy: false,
    latest: {
      actual: 120000,
      budget: 256000,
      percent: 47,
      input: 118000,
      cached: 100000,
      freshInput: 18000,
      output: 2000,
      lastStepEpochMs: now - 10_000,
      errorClassification: { kind: 'none' },
    },
    scan: {
      steps: 10,
      activeSteps: 10,
      compacted: false,
      userMessages: 2,
      assistantMessages: 2,
      unknownFiles: 2,
      totalWeight: 1000,
      shares: {
        system: { weight: 500, ratio: 0.5, text: '50.0%' },
        tools: { weight: 300, ratio: 0.3, text: '30.0%' },
        assistant: { weight: 100, ratio: 0.1, text: '10.0%' },
        thinking: { weight: 0, ratio: 0, text: '0%' },
        user: { weight: 100, ratio: 0.1, text: '10.0%' },
        summaries: { weight: 0, ratio: 0, text: '0%' },
        'attachment-total': { weight: 0, ratio: 0, text: '0%' },
      },
      scannedAt: now,
    },
  });

  // Unknown files alert & Unknown share label
  const alertBanner = sr.querySelector('[data-el="alertBanner"]');
  assert.equal(alertBanner.hidden, false);
  assert.equal(alertBanner.getAttribute('data-tone'), 'warn');
  assert.equal(alertBanner.textContent, '2 files unparsed locally');
  assert.equal(sr.querySelector('[data-val="attachment-total"]').textContent, 'Unknown');

  // Repeated ticks within the same minute/state must NOT rewrite unchanged DOM nodes
  const baseWrites = { ...writes };
  api.tickClockForTest(now + 10_000);
  api.tickClockForTest(now + 20_000);
  assert.deepEqual(writes, baseWrites, 'idempotent clock ticks must not rewrite unchanged cacheIcon, cacheRow.title, or quotaRoot');

  // >= 60m idle formatting: Xh Ym and exact Xh
  api.tickClockForTest(now - 10_000 + 65 * 60_000);
  assert.equal(cacheRow.title, 'Cached 100,000 / 118,000 tokens · Idle 1h 5m (>4m likely cold)');
  api.tickClockForTest(now - 10_000 + 120 * 60_000);
  assert.equal(cacheRow.title, 'Cached 100,000 / 118,000 tokens · Idle 2h (>4m likely cold)');

  // openPopover triggers immediate refresh using current clock
  // Set lastStepEpochMs back to 3m10s ago relative to Date.now() without calling renderAll yet
  const realNow = Date.now();
  api.applyServerState({
    rev: 'r2',
    convId: '11111111-1111-1111-1111-111111111111',
    prefs: { langMode: 'en', themeMode: 'dark' },
    quotaGroups,
    isTurnInFlight: false,
    scanBusy: false,
    latest: {
      actual: 120000,
      budget: 256000,
      percent: 47,
      input: 118000,
      cached: 100000,
      freshInput: 18000,
      output: 2000,
      lastStepEpochMs: realNow - 190_000,
      errorClassification: { kind: 'none' },
    },
    scan: null,
  });
  // Force stale title artificially, then open popover via mouseenter -> must immediately refresh
  cacheRow.title = 'stale';
  const beforeOpenWrites = writes.cacheRowTitle;
  sr.querySelector('[data-el="grpCtx"]').dispatchEvent({ type: 'mouseenter' });
  assert.equal(api.snapshotForTest().openPop, 'ctx');
  assert.ok(writes.cacheRowTitle > beforeOpenWrites, 'openPopover must trigger immediate refresh');
  assert.ok(cacheRow.title.includes('Idle 3m (expires in ~1m)'));

  // Optimistic pendingPrefsPatch & pendingForceScan must survive overlapping applyServerState before pullClientState
  sr.querySelector('[data-el="btnLang"]').dispatchEvent({ type: 'click' }); // en -> zh-CN
  sr.querySelector('[data-el="btnRefresh"]').dispatchEvent({ type: 'click' });
  api.applyServerState({
    rev: 'r3-in-flight',
    convId: '11111111-1111-1111-1111-111111111111',
    prefs: { langMode: 'en', themeMode: 'dark' },
    quotaGroups,
    isTurnInFlight: false,
    scanBusy: false,
    latest: null,
    scan: null,
  });
  assert.equal(api.snapshotForTest().lang, 'zh-CN');
  assert.equal(sr.querySelector('[data-el="btnRefresh"]').getAttribute('data-busy'), 'true');
  const drained = api.pullClientState(2000);
  assert.equal(drained.prefsPatch.langMode, 'zh-CN');
  assert.equal(drained.forceScan, true);

  api.dispose();
});

test('8. Cross-locale i18n parity, error matrix, JPEG fill-bytes & unready SQLite resilience', async () => {
  // Verify exact i18n key parity across en / zh-CN / zh-TW and no fullwidth parens in tooltip templates
  const topKeys = Object.keys(core.I18N.en).sort();
  const speedKeys = Object.keys(core.I18N.en.speed).sort();
  const errKeys = Object.keys(core.I18N.en.errors).sort();
  for (const loc of ['zh-CN', 'zh-TW']) {
    assert.deepEqual(Object.keys(core.I18N[loc]).sort(), topKeys, `${loc} top-level I18N keys must match en`);
    assert.deepEqual(Object.keys(core.I18N[loc].speed).sort(), speedKeys, `${loc} speed keys must match en`);
    assert.deepEqual(Object.keys(core.I18N[loc].errors).sort(), errKeys, `${loc} errors keys must match en`);
  }
  const tooltipKeys = [
    'langTitleAuto', 'langTitlePinned', 'themeAuto', 'themeTitle', 'refreshTitle',
    'cacheWarmTip', 'cacheWarnTip', 'cacheExpiredTip', 'cacheIdleTip',
    'speedLabelTitle', 'ttftLabelTitle', 'speedTtftDetail', 'timingTip',
    'ttftTitle', 'durTitle', 'outTitle', 'rowTipActual', 'quotaRowTip',
  ];
  for (const loc of ['en', 'zh-CN', 'zh-TW']) {
    const d = core.I18N[loc];
    for (const k of tooltipKeys) {
      const sample = typeof d[k] === 'function' ? d[k]('A', 'B', 'C', 'D') : d[k];
      assert.ok(!/[（）]/.test(sample), `${loc}.${k} tooltip must not contain fullwidth parentheses: ${sample}`);
    }
  }

  // Error classification matrix
  const configs = [
    {
      modelId: 'gemini-4-hydrogen',
      label: 'Gemini 4 Hydrogen',
      quotaInfo: { remainingFraction: 0, resetTime: '2026-11-16T18:00:00Z' },
    },
  ];
  assert.equal(core.classifyRequestError('').kind, 'none');
  assert.equal(core.classifyRequestError('UNAUTHENTICATED: invalid api key', { lang: 'en' }).kind, 'auth_error');
  assert.equal(core.classifyRequestError('HTTP 503 Service Unavailable', { lang: 'zh-TW' }).kind, 'service_unavailable');
  assert.equal(core.classifyRequestError('request was aborted by client', { lang: 'zh-CN' }).kind, 'canceled');
  assert.equal(core.classifyRequestError('ECONNRESET socket hang up', { lang: 'en' }).kind, 'network_error');
  assert.equal(core.classifyRequestError('context deadline exceeded', { lang: 'en' }).kind, 'network_error');
  assert.equal(core.classifyRequestError('ENOTFOUND api.internal', { lang: 'en' }).kind, 'network_error');
  assert.equal(core.classifyRequestError('unexpected error', { lang: 'en', currentModel: 'gemini-4-hydrogen', cascadeModelConfigs: configs }).kind, 'quota_exhausted');
  assert.equal(core.classifyRequestError('weird unknown fault https://secret.local/v1', { lang: 'en' }).diagnostic, 'weird unknown fault <API>');
  assert.equal(core.classifyRequestError('429 retry in .', { lang: 'en' }).retryAfterSec, null);

  // JPEG with 0xff 0xff fill bytes and standalone 0xff 0x00 before SOF0 (640x480)
  const jpg = Buffer.from([
    0xff, 0xd8,             // SOI
    0xff, 0xff,             // fill bytes
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, // APP0 len=4
    0xff, 0x00,             // stuffed 0x00
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x01, 0xe0, 0x02, 0x80, // SOF0: height=480 (0x01e0), width=640 (0x0280)
    0x03, 0x01, 0x11, 0x00, 0x02, 0x11, 0x00, 0x03, 0x11, 0x00,
  ]);
  assert.deepEqual(getImageDimensions(jpg), { width: 640, height: 480 });

  // Telemetry resilience against 0-byte / schema-less SQLite DB & idle lang re-classification
  const dir = mkdtempSync(join(tmpdir(), 'agy-cap-resil-'));
  const convDir = join(dir, 'conversations');
  const stateDir = join(dir, 'state');
  const convId = '33333333-3333-3333-3333-333333333333';
  mkdirSync(convDir, { recursive: true });
  try {
    const dbPath = join(convDir, `${convId}.db`);
    writeFileSync(dbPath, ''); // 0-byte DB before schema creation

    const svc = createTelemetryService({
      convDir,
      stateDir,
      lsAddress: '127.0.0.1:9999',
      csrfToken: 't',
      fetchImpl: async (url) => {
        if (url.includes('GetCascadeTrajectoryGeneratorMetadata')) {
          return {
            ok: true,
            json: async () => ({
              generatorMetadata: [{ chatModel: { modelDisplayName: 'Gemini 4 Hydrogen', error: 'HTTP 503 Service Unavailable' } }],
            }),
          };
        }
        return { ok: true, json: async () => ({ groups: [] }) };
      },
    });

    // Must not throw on 0-byte DB
    const snapEmpty = await svc.getSnapshot({ convId, lang: 'en' });
    assert.equal(snapEmpty.convId, convId);
    assert.equal(snapEmpty.latest.actual, null);

    // Schema-less non-empty DB must also not throw
    const db = new DatabaseSync(dbPath);
    db.exec('CREATE TABLE other (x INTEGER)');
    db.close();
    const snapNoTables = await svc.getSnapshot({ convId, lang: 'en' });
    assert.equal(snapNoTables.convId, convId);

    // Add real tables + row -> recovers and re-localizes error when language toggles on idle DB
    const dbReal = new DatabaseSync(dbPath);
    dbReal.exec('CREATE TABLE gen_metadata (idx INTEGER PRIMARY KEY, data BLOB)');
    dbReal.exec('CREATE TABLE steps (idx INTEGER PRIMARY KEY, step_type INTEGER, metadata BLOB)');
    dbReal.prepare('INSERT INTO gen_metadata (idx, data) VALUES (?, ?)').run(
      0,
      encodeGenRow({ uncachedIn: 1000, cachedIn: 2000, thinkTokens: 0, outTokens: 100, maxContextTokens: 256000, lastStepIndex: 1 })
    );
    dbReal.prepare('INSERT INTO steps (idx, step_type, metadata) VALUES (?, ?, ?)').run(1, 2, encodeStepMeta(1_760_000_000));
    dbReal.close();

    const snapEn = await svc.getSnapshot({ convId, lang: 'en' });
    assert.equal(snapEn.latest.errorClassification.kind, 'service_unavailable');
    assert.equal(snapEn.latest.errorClassification.badgeText, 'Busy');

    // Auto language change from client (without prefsPatch) must also bump rev and re-localize
    const snapZhCnAuto = await svc.getSnapshot({ convId, lang: 'zh-CN' });
    assert.notEqual(snapZhCnAuto.rev, snapEn.rev);
    assert.equal(snapZhCnAuto.latest.errorClassification.lang, 'zh-CN');
    assert.equal(snapZhCnAuto.latest.errorClassification.badgeText, '繁忙');

    const snapTw = await svc.getSnapshot({ convId, prefsPatch: { langMode: 'zh-TW' } });
    assert.equal(snapTw.latest.errorClassification.lang, 'zh-TW');
    assert.equal(snapTw.latest.errorClassification.badgeText, '繁忙');

    svc.dispose();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('9. startDeckInjector CDP lifecycle: transient undefined tolerance, rev-diff push & superseded stop', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-cap-cdp-'));
  const portFile = join(dir, 'DevToolsActivePort');
  writeFileSync(portFile, '9222\n/devtools/browser/test\n', 'utf8');

  const origFetch = globalThis.fetch;
  const origWebSocket = globalThis.WebSocket;
  const evalLog = [];
  let pullSequence = [
    undefined, // Tick 1: transient CDP timeout -> must NOT re-inject
    null, // Tick 2a: not yet injected -> triggers runtimeBundle injection
    { v: CAPSULE_VERSION, hash: buildRuntimeBundleWithHash(5000).hash, convId: '11111111-1111-1111-1111-111111111111', lang: 'en' }, // Tick 2b: post-inject pull
    { v: CAPSULE_VERSION, hash: buildRuntimeBundleWithHash(5000).hash, convId: '11111111-1111-1111-1111-111111111111', lang: 'en' }, // Tick 3: same rev -> no applyServerState
    'superseded', // Tick 4: newer instance took over -> onSuperseded
  ];
  let pullIdx = 0;
  let supersededCalled = 0;

  globalThis.fetch = async (url) => {
    if (String(url).includes('/json/list')) {
      return {
        ok: true,
        json: async () => [
          { id: 'page-1', type: 'page', url: 'https://127.0.0.1:54321/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/page/1' },
          { id: 'ignored', type: 'page', url: 'http://localhost:3000/', webSocketDebuggerUrl: 'ws://127.0.0.1:9222/page/2' },
        ],
      };
    }
    throw new Error(`Unexpected fetch: ${url}`);
  };

  globalThis.WebSocket = class MockWebSocket {
    constructor() {
      this.readyState = 1;
      queueMicrotask(() => this.onopen?.());
    }
    send(raw) {
      const msg = JSON.parse(raw);
      const expr = msg.params?.expression || '';
      let value;
      if (expr.includes('__AGY_CAPSULE_CORE__')) {
        evalLog.push('inject');
        value = true;
      } else if (expr.includes('pullClientState')) {
        evalLog.push('pull');
        value = pullSequence[Math.min(pullIdx++, pullSequence.length - 1)];
      } else if (expr.includes('applyServerState')) {
        evalLog.push('apply');
        value = true;
      }
      queueMicrotask(() => this.onmessage?.({ data: JSON.stringify({ id: msg.id, result: { result: { value } } }) }));
    }
    close() {
      this.readyState = 3;
      this.onclose?.();
    }
  };

  let injector = null;
  try {
    const telemetryStub = {
      async getSnapshot() {
        return { rev: 'same-rev-1', convId: '11111111-1111-1111-1111-111111111111' };
      },
    };
    injector = startDeckInjector(telemetryStub, {
      portFile,
      instanceTs: 5000,
      onSuperseded: () => {
        supersededCalled++;
      },
    });

    const deadline = Date.now() + 6500;
    while (supersededCalled === 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 100));
    }

    assert.equal(supersededCalled, 1);
    assert.deepEqual(evalLog, ['pull', 'pull', 'inject', 'pull', 'apply', 'pull', 'pull']);
  } finally {
    injector?.stop();
    globalThis.fetch = origFetch;
    globalThis.WebSocket = origWebSocket;
    rmSync(dir, { recursive: true, force: true });
  }
});
