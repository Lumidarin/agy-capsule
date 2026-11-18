import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync, existsSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, basename, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startDeckInjector } from './deck_injector.mjs';
import { createSettingsStore, DEFAULT_SETTINGS } from './settings.mjs';
import { createPresentation, getPresentationScript } from './ui.mjs';
import { DEFAULT_UI_SKIN, SIDEBAR_SKIN_CSS } from './ui_skins.mjs';
import { summarizeGeneration, summarizeTurnSpeed } from './metrics.mjs';
import { classifyRequestError } from './errors.mjs';
import { createSqliteSnapshotCache } from './sqlite_cache.mjs';
import { startSelfReloadWatcher } from './reload.mjs';
import { summarizeTurnMetrics } from './turn_metrics.mjs';
import { installAsyncHostRoutes, installEpipeGuard } from './host_bridge.mjs';

const settingsStore = createSettingsStore();
const presentation = createPresentation();

const CONV_DIR = join(homedir(), '.gemini', 'antigravity', 'conversations');

const NO_QUOTA = { quotaGroups: [], cloudPaygo: false };
let cachedQuota = null;
let lastQuotaFetchMs = 0;
let lsConnFailures = 0;
const QUOTA_TTL_MS = 10000;
let quotaPromise = null;

async function fetchQuota() {
  const now = Date.now();
  if (cachedQuota && now - lastQuotaFetchMs < QUOTA_TTL_MS) {
    return cachedQuota;
  }
  if (quotaPromise) return quotaPromise;
  quotaPromise = loadQuota();
  try { return await quotaPromise; }
  finally { quotaPromise = null; }
}

async function loadQuota() {
  const lsAddr = process.env.ANTIGRAVITY_LS_ADDRESS;
  const csrf = process.env.ANTIGRAVITY_CSRF_TOKEN;
  if (!lsAddr || !csrf) return cachedQuota || NO_QUOTA;
  const request = method => fetch(`http://${lsAddr}/exa.language_server_pb.LanguageServerService/${method}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-codeium-csrf-token': csrf },
    body: '{}',
    signal: AbortSignal.timeout(3000),
  });
  try {
    const res = await request('RetrieveUserQuotaSummary');
    lsConnFailures = 0;
    if (!res.ok) return cachedQuota || NO_QUOTA;
    const data = await res.json();
    const groups = data?.response?.groups ?? data?.groups;
    const quotaGroups = Array.isArray(groups) ? groups : [];
    let cloudPaygo = false;
    if (quotaGroups.length === 0) {
      // A missing summary alone is not a billing-mode signal. The local user
      // status identifies Cloud pay-as-you-go separately from subscriptions.
      cloudPaygo = cachedQuota?.cloudPaygo ?? false;
      try {
        const status = await request('GetUserStatus');
        if (status.ok) cloudPaygo = (await status.json())?.userStatus?.userTier?.id === 'agy-business-paygo-tier';
      } catch {} // Optional detection must not restart the sidecar.
    }
    cachedQuota = { quotaGroups, cloudPaygo };
    lastQuotaFetchMs = Date.now();
    return cachedQuota;
  } catch {
    lsConnFailures++;
    if (lsConnFailures >= 2) {
      process.exit(0);
    }
    return cachedQuota || NO_QUOTA;
  }
}

function readVarint(buf, offset) {
  let val = 0n;
  let shift = 0n;
  let i = offset;
  while (i < buf.length) {
    const b = buf[i++];
    val |= BigInt(b & 0x7f) << shift;
    if ((b & 0x80) === 0) {
      return [Number(val), i];
    }
    shift += 7n;
  }
  return [Number(val), i];
}

function parsePbMap(buf) {
  const fields = new Map();
  let i = 0;
  while (i < buf.length) {
    try {
      const [tag, nextI] = readVarint(buf, i);
      i = nextI;
      const fn = tag >>> 3;
      const wt = tag & 7;
      if (fn === 0) break;
      if (!fields.has(fn)) fields.set(fn, []);
      if (wt === 0) {
        const [val, nI] = readVarint(buf, i);
        i = nI;
        fields.get(fn).push(val);
      } else if (wt === 2) {
        const [len, nI] = readVarint(buf, i);
        i = nI;
        if (len < 0 || i + len > buf.length) break;
        fields.get(fn).push(buf.subarray(i, i + len));
        i += len;
      } else if (wt === 5) {
        fields.get(fn).push(buf.subarray(i, i + 4));
        i += 4;
      } else if (wt === 1) {
        fields.get(fn).push(buf.subarray(i, i + 8));
        i += 8;
      } else {
        break;
      }
    } catch {
      break;
    }
  }
  return fields;
}

function recordedTokenUsage(fields, confirmedZero = false) {
  const reported = confirmedZero || [2, 3, 5, 9, 10].some(key => fields.has(key));
  const value = key => fields.get(key)?.[0] || 0;
  const splitMatches = value(3) === value(9) + value(10);
  return {
    read: reported ? value(2) + value(5) : null,
    cachedRead: reported ? value(5) : null,
    uncachedRead: reported ? value(2) : null,
    write: reported && splitMatches ? value(10) : null,
    thinking: reported && splitMatches ? value(9) : null,
  };
}

function parseGenRow(idx, data, includeTurnMetrics = true) {
  if (!data || !Buffer.isBuffer(data)) data = Buffer.from(data || []);
  const top = parsePbMap(data);
  if (!top.has(1)) return null;
  const stepIndices = [];
  for (const value of top.get(2) || []) {
    if (typeof value === 'number') stepIndices.push(value);
    else for (let offset = 0; offset < value.length;) {
      const [idx, next] = readVarint(value, offset);
      stepIndices.push(idx);
      offset = next;
    }
  }
  const m1 = parsePbMap(top.get(1)[0]);
  const usageBuf = m1.has(4) ? m1.get(4)[0] : Buffer.alloc(0);
  const usage = parsePbMap(usageBuf);

  const uncachedIn = usage.has(2) ? usage.get(2)[0] : 0;
  const cachedIn = usage.has(5) ? usage.get(5)[0] : 0;
  const thinkTokens = usage.has(9) ? usage.get(9)[0] : 0;
  const outTokens = usage.has(10) ? usage.get(10)[0] : 0;
  const contextTokens = uncachedIn + cachedIn;
  const duration = field => {
    if (!m1.has(field)) return null;
    const fields = parsePbMap(m1.get(field)[0]);
    return (fields.get(1)?.[0] || 0) + (fields.get(2)?.[0] || 0) / 1e9;
  };
  const ttft = duration(11);
  const streaming = duration(12);
  // Verified against the installed ChatModelMetadata/RetryInfo descriptors and
  // 11 real RPC retry errors: ChatModelMetadata.retry_infos=17, RetryInfo.error=3.
  // Read the FINAL retry only; an earlier failed attempt must not survive success.
  const lastRetry = m1.get(17)?.at(-1);
  const retryError = lastRetry ? parsePbMap(lastRetry).get(3)?.[0] : null;
  const requestError = classifyRequestError(Buffer.isBuffer(retryError) ? retryError.toString('utf8') : '');
  // Proto usage.3 is TOTAL output; usage.9 and .10 are thinking and reply.
  // Missing usage/preflight rows must not become a fake zero-token result.
  const hasOutput = m1.has(4) && (usage.has(3) || (ttft !== null && streaming !== null));
  let attempts = [];
  let pendingAttempt = false;
  if (includeTurnMetrics) {
    const retries = m1.get(17) || [];
    const hasAttempt = retries.length > 0 || hasOutput || ttft !== null || streaming !== null || top.has(5) || (m1.get(14)?.[0] || 0) > 0;
    attempts = retries.map((value, index) => {
      const info = parsePbMap(value);
      const counters = parsePbMap(info.get(2)?.[0] || Buffer.alloc(0));
      const finalSuccess = index === retries.length - 1 && !info.get(3)?.[0]?.length && hasOutput;
      const reported = [2, 3, 5, 9, 10].some(key => counters.has(key));
      return { usage: recordedTokenUsage(finalSuccess && !reported ? usage : counters, finalSuccess) };
    });
    if (hasAttempt && attempts.length === 0) attempts.push({ usage: recordedTokenUsage(usage, hasOutput) });
    const expectedAttempts = hasAttempt ? Math.max(attempts.length, (m1.get(14)?.[0] || 0) + 1) : 0;
    while (attempts.length < expectedAttempts) attempts.unshift({ usage: recordedTokenUsage(new Map()) });
    pendingAttempt = !hasAttempt && stepIndices.length > 0;
  }

  let maxContextTokens = 0;
  if (m1.has(9)) {
    const m9 = parsePbMap(m1.get(9)[0]);
    if (m9.has(10)) {
      const m10 = parsePbMap(m9.get(10)[0]);
      if (m10.has(4)) {
        maxContextTokens = m10.get(4)[0];
      }
    }
  }

  let lastStepIndex = -1;
  if (m1.has(20)) {
    for (const kvBuf of m1.get(20)) {
      const kv = parsePbMap(kvBuf);
      const key = kv.has(1) ? kv.get(1)[0].toString('utf8') : '';
      if (key === 'last_step_index' && kv.has(2)) {
        const n = Number(kv.get(2)[0].toString('utf8'));
        if (Number.isFinite(n)) lastStepIndex = n;
        break;
      }
    }
  }

  return {
    turn: idx,
    uncachedIn,
    cachedIn,
    contextTokens,
    outTokens,
    thinkTokens,
    maxContextTokens,
    lastStepIndex,
    stepIndices,
    requestError,
    attempts,
    pendingAttempt,
    generation: {
      requestIndex: idx, ttft, streaming,
      output: hasOutput ? usage.get(3)?.[0] || 0 : null,
      reply: hasOutput ? outTokens : null,
      thinking: hasOutput ? thinkTokens : null,
    },
  };
}

let lastDeckConvId = null; // '' when on New Conversation page, or uuid when on /c/<uuid>

function resolveLatestConvId(preferredId) {
  if (!existsSync(CONV_DIR)) return '';
  const files = readdirSync(CONV_DIR)
    .filter((f) => f.endsWith('.db'))
    .map((f) => ({
      id: basename(f, '.db'),
      mtimeMs: statSync(join(CONV_DIR, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);
  if (files.length === 0) return '';
  // Always follow the most recently modified conversation DB so switching
  // or starting a new chat in Desktop automatically updates the panel.
  return files[0].id;
}

async function makeEmptyContextResult() {
  return {
    uiVersion: 102,
    turnSpeed: null,
    turnMetrics: null,
    requestError: classifyRequestError(),
    generation: summarizeGeneration(),
    prefs: settingsStore.read(),
    cachedIn: 0,
    uncachedIn: 0,
    contextTokens: 0,
    maxContextTokens: 0,
    lastStepEpochMs: 0,
    turn0Tokens: 0,
    totalOutputTokens: 0,
    totalThinkingTokens: 0,
    ...await fetchQuota(),
  };
}

async function inspectConversation(convId, exact = false) {
  const safeConvId = typeof convId === 'string' && /^[0-9a-zA-Z_-]+$/.test(convId) ? convId : '';
  let targetId = '';
  if (exact) {
    lastDeckConvId = safeConvId;
    if (!safeConvId || !existsSync(join(CONV_DIR, `${safeConvId}.db`))) {
      return await makeEmptyContextResult();
    }
    targetId = safeConvId;
  } else {
    if (lastDeckConvId !== null) {
      if (!lastDeckConvId || !existsSync(join(CONV_DIR, `${lastDeckConvId}.db`))) {
        return await makeEmptyContextResult();
      }
      targetId = lastDeckConvId;
    } else {
      targetId =
        safeConvId && existsSync(join(CONV_DIR, `${safeConvId}.db`))
          ? safeConvId
          : resolveLatestConvId(safeConvId);
    }
    if (!targetId) {
      return await makeEmptyContextResult();
    }
  }

  const prefs = settingsStore.read();
  const snapshot = conversationCache.read(join(CONV_DIR, `${targetId}.db`), prefs.showTurnMetrics);
  if (!snapshot) return await makeEmptyContextResult();
  return {
    uiVersion: 102,
    ...snapshot,
    prefs,
    ...await fetchQuota(),
  };
}

const conversationCache = createSqliteSnapshotCache(readConversationSnapshot);

function readConversationSnapshot(dbPath, includeTurnMetrics = true) {
  const db = new DatabaseSync(dbPath, { readOnly: true });
  let rawRows = [];
  let cpRows = [];
  let lastStepEpochMs = 0;
  let userStepIndex = null;
  let turnSteps = [];
  let metricsUserStepIndex = null;
  let executors = [];
  try {
    rawRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
    cpRows = db.prepare('SELECT idx FROM steps WHERE step_type = 23 ORDER BY idx DESC').all();
    // A queued user input is not a new running turn until AGY consumes it.
    userStepIndex = db.prepare('SELECT idx FROM steps WHERE step_type = 14 AND status != 11 ORDER BY idx DESC LIMIT 1').get()?.idx ?? null;
    if (includeTurnMetrics) metricsUserStepIndex = db.prepare('SELECT idx FROM steps WHERE step_type = 14 ORDER BY idx DESC LIMIT 1').get()?.idx ?? null;
    const firstTurnStep = userStepIndex ?? metricsUserStepIndex;
    if (firstTurnStep !== null) {
      turnSteps = db.prepare('SELECT idx, step_type, status, metadata FROM steps WHERE idx >= ? ORDER BY idx').all(firstTurnStep).map(step => {
        const fields = parsePbMap(Buffer.from(step.metadata || []));
        const stamp = fields.get(7)?.[0] || fields.get(8)?.[0];
        const time = stamp ? parsePbMap(stamp) : new Map();
        const speedStep = {
          idx: step.idx, step_type: step.step_type, status: step.status,
          completedAtMs: (time.get(1)?.[0] || 0) * 1000 + (time.get(2)?.[0] || 0) / 1e6,
        };
        if (!includeTurnMetrics) return speedStep;
        const epoch = value => { const parts = parsePbMap(value || Buffer.alloc(0)); return parts.has(1) ? parts.get(1)[0] * 1000 + (parts.get(2)?.[0] || 0) / 1e6 : null; };
        const transitions = (parsePbMap(fields.get(26)?.[0] || Buffer.alloc(0)).get(1) || []).map(value => parsePbMap(value));
        const terminal = transitions.filter(item => [3, 6, 7, 12].includes(item.get(1)?.[0])).map(item => epoch(item.get(2)?.[0])).filter(value => value !== null);
        return {
          ...speedStep,
          recordedCompletedAtMs: epoch(fields.get(8)?.[0]),
          createdAtMs: epoch(fields.get(1)?.[0]),
          terminalAtMs: terminal.length ? Math.max(...terminal) : null,
          executionId: fields.get(12)?.[0]?.toString('utf8') || '',
        };
      });
      if (metricsUserStepIndex !== null && db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='executor_metadata'").get()) {
        executors = db.prepare('SELECT data FROM executor_metadata ORDER BY idx').all().map(row => {
          const fields = parsePbMap(Buffer.from(row.data || []));
          return { reason: fields.get(1)?.[0] || 0, lastStepIndex: fields.size ? (fields.get(3)?.[0] ?? 0) : -1, executionId: fields.get(9)?.[0]?.toString('utf8') || '' };
        });
      }
    }
    const stepRow = db.prepare('SELECT metadata FROM steps ORDER BY idx DESC LIMIT 1').get();
    if (stepRow?.metadata) {
      const sm = parsePbMap(Buffer.from(stepRow.metadata));
      if (sm.has(1)) {
        const tsMap = parsePbMap(sm.get(1)[0]);
        if (tsMap.has(1)) {
          lastStepEpochMs = Number(tsMap.get(1)[0]) * 1000;
        }
      }
    }
  } finally {
    db.close();
  }
  if (!lastStepEpochMs) {
    try {
      lastStepEpochMs = Math.max(statSync(dbPath).mtimeMs, existsSync(dbPath + '-wal') ? statSync(dbPath + '-wal').mtimeMs : 0);
    } catch {}
  }

  const turns = [];
  let maxContextTokens = 0;
  let latestGeneration = null;
  let latestRequestError = classifyRequestError();
  const parsedRequests = [];

  for (const row of rawRows) {
    const parsed = parseGenRow(row.idx, row.data, includeTurnMetrics);
    if (!parsed) continue;
    parsedRequests.push(parsed);
    latestGeneration = parsed.generation;
    latestRequestError = parsed.requestError;
    if (parsed.maxContextTokens > 0) {
      maxContextTokens = parsed.maxContextTokens;
    }
    if (parsed.contextTokens === 0) continue;
    turns.push(parsed);
  }

  // Start accumulating from the latest compaction checkpoint so pre-compaction
  // output/thinking tokens do not inflate the active context breakdown.
  let epochStart = 0;
  if (turns.length > 0) {
    for (const cp of cpRows) {
      const postIdx = turns.findIndex((t) => t.lastStepIndex >= cp.idx);
      if (postIdx >= 0) {
        epochStart = postIdx;
        break;
      }
    }
    for (let i = epochStart + 1; i < turns.length; i++) {
      if (turns[i].contextTokens < turns[i - 1].contextTokens * 0.7) {
        epochStart = i;
      }
    }
  }

  const latest = turns[turns.length - 1] || {
    uncachedIn: 0,
    cachedIn: 0,
    contextTokens: 0,
    outTokens: 0,
    thinkTokens: 0,
  };
  if (turns.length === 0 || latest.contextTokens === 0) {
    lastStepEpochMs = 0;
  }

  // latest.contextTokens is the prompt sent *before* latest generated its output/thinking,
  // so only accumulate prior turns within the active compaction epoch.
  let rawOut = 0;
  let rawThink = 0;
  for (let i = epochStart; i < turns.length - 1; i++) {
    rawOut += turns[i].outTokens;
    rawThink += turns[i].thinkTokens;
  }

  const turn0Tokens = Math.min(turns[epochStart]?.contextTokens || 0, latest.contextTokens);
  const availGen = Math.max(0, latest.contextTokens - turn0Tokens);
  const genSum = rawOut + rawThink;
  const genScale = genSum > availGen && genSum > 0 ? availGen / genSum : 1;
  const totalOutputTokens = Math.round(rawOut * genScale);
  const totalThinkingTokens = Math.round(rawThink * genScale);

  return {
    turnSpeed: summarizeTurnSpeed(parsedRequests, turnSteps, userStepIndex),
    turnMetrics: includeTurnMetrics ? summarizeTurnMetrics(parsedRequests, turnSteps.map(step => ({ ...step, completedAtMs: step.recordedCompletedAtMs })), metricsUserStepIndex, executors) : null,
    requestError: latestRequestError,
    generation: summarizeGeneration(latestGeneration),
    cachedIn: latest.cachedIn,
    uncachedIn: latest.uncachedIn,
    contextTokens: latest.contextTokens,
    maxContextTokens,
    lastStepEpochMs,
    turn0Tokens,
    totalOutputTokens,
    totalThinkingTokens,
  };
}

const PV_SVG = {
  db: '<svg class="pv-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/><path d="M3 12c0 1.66 4.03 3 9 3s9-1.34 9-3"/></svg>',
  clock: '<svg class="pv-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15.5 14"/></svg>',
  cal: '<svg class="pv-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
  warn: '<svg class="pv-svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9"><circle cx="12" cy="12" r="9"/><path d="M12 7v6"/><circle cx="12" cy="17" r=".8" fill="currentColor"/></svg>',
  ring: '<svg width="13" height="13" viewBox="0 0 18 18" style="transform:rotate(-90deg);flex-shrink:0"><circle cx="9" cy="9" r="6.5" fill="none" stroke="var(--agc-ring-track, rgba(142,142,147,0.28))" stroke-width="2.4"/><circle cx="9" cy="9" r="6.5" fill="none" stroke="var(--agc-good)" stroke-width="2.4" stroke-linecap="round" stroke-dasharray="40.84" stroke-dashoffset="6.1"/></svg>',
};

const PV_CARD_PREVIEW = {
  highlightActiveModel: `<div class="pv-active-model">
    <div class="pv-qm-row pv-qm-active"><span class="pv-qm-name">Gemini<span class="pv-qm-dot"></span></span><span class="pv-qm-bar"><span style="width:85%"></span></span><span class="pv-qm-pct">85%</span></div>
    <div class="pv-qm-row pv-qm-other"><span class="pv-qm-name">Claude</span><span class="pv-qm-bar"><span style="width:60%"></span></span><span class="pv-qm-pct">60%</span></div>
  </div>`,
  hideUnavailableQuota: `<div class="pv-hide-quota">
    <span class="pv-pill pv-hq-pill"><span class="pv-hq-miss">${PV_SVG.clock}<span>--%</span></span><span class="pv-hq-keep">${PV_SVG.cal}<span>85%</span></span></span>
    <span class="pv-pill pv-hq-pill"><span class="pv-hq-zero">${PV_SVG.clock}<span>0%</span></span><span class="pv-hq-keep">${PV_SVG.cal}<span>85%</span></span></span>
  </div>`,
  showCacheWarnings: `<div class="pv-cache-warn">
    <span class="pv-pill pv-ca-1">${PV_SVG.db}<span>&lt;3m</span></span>
    <span class="pv-pill pv-ca-2">${PV_SVG.db}<span>3m+</span></span>
    <span class="pv-pill pv-ca-3">${PV_SVG.db}<span>4m+</span></span>
  </div>`,
  showContextWarnings: `<div class="pv-ctx-warn">
    <span class="pv-pill pv-cw-1">${PV_SVG.db}<span class="pv-cw-val">40%</span></span>
    <span class="pv-pill pv-cw-2">${PV_SVG.db}<span class="pv-cw-val">75%</span></span>
    <span class="pv-pill pv-cw-3">${PV_SVG.db}<span class="pv-cw-val">90%</span></span>
  </div>`,
  showRequestErrors: `<div class="pv-err-strip">
    <span class="pv-pill">${PV_SVG.db}<span>42%</span></span>
    <span class="pv-pill">${PV_SVG.clock}<span>85%</span></span>
    <span class="pv-pill pv-pill-err">${PV_SVG.warn}<span>429</span></span>
  </div>`,
  showRequestMetrics: `<div class="pv-detail-card pv-req-card">
    <div class="pv-req-bar" aria-hidden="true"><i style="width:12%;background:var(--agc-c-turn0)"></i><i style="width:36%;background:var(--agc-c-read)"></i><i style="width:14%;background:var(--agc-c-think)"></i><i style="width:10%;background:var(--agc-c-out)"></i></div>
    <div class="pv-req-divider" aria-hidden="true"></div>
    <div class="pv-req-3col">
      <div class="pv-req-col">
        <div class="pv-req-top"><svg class="pv-req-ring" viewBox="0 0 12 12" width="10" height="10" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="none" stroke="rgba(142,142,147,0.24)" stroke-width="1.8"/><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="28 28.27" transform="rotate(-90 6 6)"/></svg><span>99%</span></div>
        <div class="pv-req-sub"><span data-i18n="cache">Cache</span> <span>1m</span></div>
      </div>
      <div class="pv-req-col pv-req-mid">
        <div class="pv-req-top"><span class="pv-req-speed-ico" aria-hidden="true"><svg viewBox="0 0 14 12" width="10" height="8.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2.6 3.1L6.3 6.0 2.6 8.9M7.5 8.9H11.5"/></svg></span><span>100.0 tok/s</span></div>
        <div class="pv-req-sub">1.0s–3.0s</div>
      </div>
      <div class="pv-req-col pv-req-end">
        <div class="pv-req-top"><span>1.4K</span></div>
        <div class="pv-req-sub"><span data-i18n="think">Think</span> <span>314</span></div>
      </div>
    </div>
    <div class="pv-req-c1">
      <svg class="pv-req-ring" viewBox="0 0 12 12" width="9.5" height="9.5" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="none" stroke="rgba(142,142,147,0.24)" stroke-width="1.8"/><circle cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="28 28.27" transform="rotate(-90 6 6)"/></svg>
      <span data-i18n="cache">Cache</span>
      <b>99%</b>
      <span class="pv-req-c1-age">1m</span>
    </div>
  </div>`,
};

const renderCheckCard = ({ id, helpId = id, key, tip = '', checked = false, preview = PV_CARD_PREVIEW[key] || '' }) => `
  <div class="setting-card${tip ? ' metric-setting' : ''}" data-setting-card="${key}" data-checked="${checked}">
    <div class="setting-head">
      <label class="setting-check">
        <input id="${id}" name="${key}" type="checkbox"${checked ? ' checked' : ''}${tip ? ` aria-describedby="help-${helpId}"` : ''} />
        <span data-i18n="${key}"></span>
      </label>${tip ? `<span class="setting-help-dot" aria-hidden="true">?</span>` : ''}
    </div>
    ${preview ? `<div class="setting-preview" aria-hidden="true">${preview}</div>` : ''}
    ${tip ? `<div class="metric-help" id="help-${helpId}" role="tooltip" data-i18n="${tip}"></div>` : ''}
  </div>`;

const renderPickCard = (key, items) => `
  <div class="setting-card" data-setting-card="${key}">
    <div class="setting-head"><span class="setting-label" data-i18n="${key}"></span>
      <div class="pv-pick-inline">
        ${items.map(([val, labelKey, iconHtml]) => `<button type="button" class="pv-swatch pv-swatch-icon" data-pick-setting="${key}" data-pick-value="${val}" data-pick-label="${labelKey}">${iconHtml}</button>`).join('')}
      </div>
    </div>
  </div>`;

// Segmented option control styled like the settings switches.
// Icon options are labelled for screen readers via data-pick-label.
const renderSeg = (key, options, segClass = '') => `<div class="setting-seg${segClass ? ' ' + segClass : ''}" role="group">${options.map(([value, labelKey, icon]) => `<button type="button" class="setting-seg-opt" data-pick-setting="${key}" data-pick-value="${value}" data-pick-label="${labelKey}">${icon}</button>`).join('')}</div>`;
const LAYOUT_OPTIONS = [
  ['columns', 'layoutColumns', '<span class="seg-ico seg-ico-cols" aria-hidden="true"><i></i><i></i><i></i></span>'],
  ['rows', 'layoutRows', '<span class="seg-ico seg-ico-rows" aria-hidden="true"><i></i><i></i><i></i></span>'],
];
const MARKER_OPTIONS = [
  ['square', 'markerSquare', '<span class="seg-ico seg-ico-marker" aria-hidden="true"></span>'],
  ['dot', 'markerDot', '<span class="seg-ico seg-ico-marker seg-ico-dot" aria-hidden="true"></span>'],
];
const REQUEST_POS_OPTIONS = [
  ['top', 'requestPosTop', '<span data-i18n="requestPosTop"></span>'],
  ['bottom', 'requestPosBottom', '<span data-i18n="requestPosBottom"></span>'],
];
// Column-field editor shown inside the context preview: one row per field
// (name / value / percent), visible rows first in the saved order, hidden rows
// struck through at the bottom. Shared with the page script via toString().
function renderFieldEditor(prefs, labels) {
  const items = [['turn0', 'var(--agc-c-turn0)', '14.6K', '3%'], ['read', 'var(--agc-c-read)', '120K', '23%'], ['think', 'var(--agc-c-think)', '30.8K', '6%'], ['write', 'var(--agc-c-out)', '16.1K', '3%']];
  const keys = { label: 'columnLabel', value: 'columnValue', percent: 'columnPercent' };
  const names = { label: 'fieldName', value: 'fieldValue', percent: 'fieldPercent' };
  const order = String(prefs.columnOrder || 'label,value,percent').split(',');
  const on = field => prefs[keys[field]] === true;
  const sorted = [...order.filter(on), ...order.filter(field => !on(field))];
  return sorted.map(field => `<div class="pv-field-row" data-field="${field}" data-on="${on(field)}"${on(field) ? ' draggable="true"' : ''} title="${labels.fieldDragTip || ''}">`
    + `<span class="pv-field-grip" aria-hidden="true"></span>`
    + items.map(([key, color, value, pct]) => `<span class="pv-field-cell" style="--pv-c:${color}">${field === 'label' ? (labels[key] || key) : field === 'value' ? value : pct}</span>`).join('')
    + `<button type="button" class="pv-field-toggle" role="switch" aria-checked="${on(field)}" aria-label="${labels[names[field]] || field}" data-toggle-setting="${keys[field]}"></button></div>`).join('');
}
const PV_CONTEXT_ITEMS = [['turn0', 'var(--agc-c-turn0)', '14.6K', '3%'], ['read', 'var(--agc-c-read)', '120K', '23%'], ['think', 'var(--agc-c-think)', '30.8K', '6%'], ['write', 'var(--agc-c-out)', '16.1K', '3%']];
const PV_TURN_ITEMS = [['elapsed', 'turnLabel', '42s'], ['requests', 'turnReqsLabel', '2'], ['thinking', 'turnThinking', '640'], ['write', 'turnWrite', '1.4K']];

const UI_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>agy-capsule</title>
  <script src="/preload.js"></script>
  <style>
${SIDEBAR_SKIN_CSS}
    * { box-sizing: border-box; }
    html, body { scrollbar-width: none; }
    html::-webkit-scrollbar, body::-webkit-scrollbar { display: none; width: 0; height: 0; }
    body {
      margin: 0;
      padding: 0;
      font-family: "Source Han Sans CN", "思源黑体 CN", "Source Han Sans SC", system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", "Microsoft YaHei UI", "Microsoft YaHei", "PingFang SC", Arial, sans-serif;
      font-weight: 400;
      font-variation-settings: normal;
      font-variant-ligatures: normal;
      background: var(--background, #141414);
      color: var(--foreground, #ebebeb);
      font-size: 12px;
      line-height: 1.35;
      user-select: none;
      -webkit-font-smoothing: antialiased;
    }
    .panel {
      width: 100%;
      max-width: 1120px;
      margin: 0 auto;
      min-width: 0;
      padding: 4px 2px;
      container-type: inline-size;
      container-name: stats;
    }
    .stats-layout {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      align-items: start;
      min-width: 0;
    }
    .stats-context {
      display: flex;
      flex-direction: column;
      min-width: 0;
    }
    body[data-request-position="top"] .stats-context > .foot-grid { order: -2; }
    body[data-request-position="top"] .stats-context > .divider { order: -1; }
    .stats-quota {
      display: grid;
      grid-template-columns: minmax(0, 1fr);
      gap: var(--agy-section-gap, 9px);
      align-items: start;
      min-width: 0;
    }
    .divider:has(+ #quota-root:empty) {
      display: none;
    }
    .cache-ring { width: 11px; height: 11px; flex-shrink: 0; display: block; color: var(--agc-muted); transition: color 0.18s ease; }
    .cache-ring[data-icon-state="warm"] { color: var(--agc-good); }
    .cache-ring[data-icon-state="warning"] { color: var(--agc-warn); }
    .cache-ring[data-icon-state="expired"] { color: var(--agc-danger); }
    #row-cached[data-cache-status="warning"] #val-cache-hit, #row-cached[data-cache-status="warning"] #val-cache-hit-k { color: var(--agc-warn); }
    #row-cached[data-cache-status="cold"] #val-cache-hit-k { color: var(--agc-danger); }
    .cache-pct { font-variant-numeric: tabular-nums; white-space: nowrap; }
    .cache-k:empty { display: none; }
    .summary-row {
      display: flex;
      flex-wrap: wrap;
      justify-content: space-between;
      align-items: baseline;
      gap: 10px;
      row-gap: 4px;
      margin-bottom: var(--agy-section-gap, 9px);
    }
    .used-pct {
      font-size: 13px;
      font-weight: 400;
      line-height: 1.35;
      color: var(--agc-muted);
    }
    .used-pct > #used-pct {
      font-size: 13px;
      font-weight: 600;
      color: var(--agc-fg-strong);
    }
    .used-fraction {
      margin-left: auto;
      white-space: nowrap;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.35;
      color: var(--agc-fg-strong);
      font-variant-numeric: tabular-nums;
    }
    .progress-track {
      position: relative;
      width: 100%;
      height: 4px;
      background: var(--agc-track, rgba(120, 120, 128, 0.24));
      box-shadow: inset 0 0 0 0.5px var(--agc-track-ring, rgba(255, 255, 255, 0.06));
      border-radius: 99px;
      display: flex;
      gap: 1px;
      overflow: hidden;
      margin-bottom: var(--agy-section-gap, 9px);
    }
    .seg {
      height: 100%;
      border-radius: 0;
      background-image: linear-gradient(180deg, var(--agc-seg-sheen, rgba(255, 255, 255, 0.16)) 0%, transparent 72%);
      transition: width 0.25s ease, opacity 0.14s ease, filter 0.14s ease;
      cursor: pointer;
    }
    .stats-context[data-hover-cat] .seg { opacity: 0.28; }
    .stats-context[data-hover-cat] .item-row { opacity: 0.36; }
    .stats-context[data-hover-cat="turn0"] #seg-turn0, .stats-context[data-hover-cat="read"] #seg-read,
    .stats-context[data-hover-cat="think"] #seg-think, .stats-context[data-hover-cat="out"] #seg-out { opacity: 1; filter: brightness(1.16); }
    .stats-context[data-hover-cat="turn0"] #row-turn0, .stats-context[data-hover-cat="read"] #row-read,
    .stats-context[data-hover-cat="think"] #row-think, .stats-context[data-hover-cat="out"] #row-out { opacity: 1; background: var(--agc-hover); }
    .stats-context[data-hover-cat="turn0"] #row-turn0 .item-label, .stats-context[data-hover-cat="read"] #row-read .item-label,
    .stats-context[data-hover-cat="think"] #row-think .item-label, .stats-context[data-hover-cat="out"] #row-out .item-label { color: var(--agc-fg-strong); }
    .item-row[data-zero="true"] { opacity: 0.44; }
    .item-row[data-zero="true"]:hover { opacity: 0.92; }
    .list, .turn-bar-list {
      display: grid;
      grid-template-columns: repeat(4, minmax(0, 1fr));
      align-items: start;
      gap: 6px;
    }
    .turn-bar-list {
      grid-template-columns: minmax(calc((100% - 18px) / 4), max-content) minmax(0, 1fr) calc((100% - 18px) / 4) calc((100% - 18px) / 4);
    }
    .item-row, .turn-bar-item {
      display: grid;
      grid-template-columns: auto minmax(0, 1fr);
      align-items: center;
      column-gap: 5px;
      row-gap: 2px;
      min-width: 0;
    }
    .item-body {
      display: flex;
      flex-direction: column;
      row-gap: 2px;
      column-gap: 10px;
      min-width: 0;
    }
    .item-label, .turn-bar-label, .turn-bar-short {
      color: var(--muted-foreground, #8e8e93);
      font-size: 12px;
      line-height: 1.35;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .turn-bar-item[data-turn-row="requests"] { container-type: inline-size; }
    .turn-bar-short { display: none; }
    @container (max-width: 39px) {
      .turn-bar-item[data-turn-row="requests"] .turn-bar-label { display: none; }
      .turn-bar-item[data-turn-row="requests"] .turn-bar-short { display: block; }
    }
    .item-row > .dot, .turn-bar-line {
      grid-row: 1 / span 2;
      align-self: stretch;
      width: 2.5px;
      margin: 2px 0;
      border-radius: 99px;
      flex-shrink: 0;
      transition: background-color 0.25s ease, opacity 0.25s ease;
    }
    .turn-bar-line {
      background: var(--agc-turn-line, color-mix(in srgb, var(--agc-muted) 50%, transparent));
    }
    .item-row > .dot { grid-row: 1; }
    .item-k, .item-pct, .turn-bar-val {
      grid-column: 2;
      color: var(--agc-fg-strong);
      white-space: nowrap;
      font-variant-numeric: tabular-nums;
      font-size: 12px;
      font-weight: 500;
      line-height: 1.35;
    }
    .item-pct { color: var(--agc-muted); font-weight: 400; }
    .divider {
      height: 0.5px;
      background: var(--agc-divider);
      margin: var(--agy-section-gap, 9px) 0;
    }
    .foot-grid { display: flex; justify-content: space-between; align-items: flex-start; column-gap: 6px; font-variant-numeric: tabular-nums; }
    .foot-gen-wrap { display: contents; }
    .foot-gen-wrap[hidden] { display: none; }
    .foot-col { flex: 0 1 auto; min-width: 0; }
    .foot-top { height: 17px; min-width: 0; display: flex; align-items: center; gap: 5px; white-space: nowrap; }
    .foot-top-right, .foot-sub-right { justify-content: flex-end; }
    .foot-val { font-size: 13px; font-weight: 500; line-height: 1.25; color: var(--agc-fg-strong); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .foot-sub { min-height: 15px; min-width: 0; margin-top: 3px; display: flex; flex-wrap: wrap; align-items: center; column-gap: 4px; row-gap: 1px; font-size: 12px; line-height: 1.25; color: var(--agc-muted); }
    .foot-sub > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .foot-sub > [data-el="footOutSub"] { white-space: normal; word-break: keep-all; }
    .foot-right { text-align: right; }
    .stats-context:has(> .foot-grid > [data-generation-block][hidden]) > .divider { margin: calc(var(--agy-section-gap, 9px) - 2px) 0; }
    .foot-grid:has(> [data-generation-block][hidden]) { display: block; }
    .foot-grid:has(> [data-generation-block][hidden]) #row-cached { display: flex; align-items: center; gap: 5px; min-height: 17px; width: 100%; font-size: 13px; line-height: 1.3; color: var(--agc-muted); }
    .foot-grid:has(> [data-generation-block][hidden]) #row-cached .foot-top,
    .foot-grid:has(> [data-generation-block][hidden]) #row-cached .foot-sub {
      display: contents;
      font-size: inherit;
      line-height: inherit;
    }
    .foot-grid:has(> [data-generation-block][hidden]) #dot-cached { order: 1; flex-shrink: 0; }
    .foot-grid:has(> [data-generation-block][hidden]) #sb-cache-ring { width: 11.5px; height: 11.5px; }
    .foot-grid:has(> [data-generation-block][hidden]) [data-i18n="cache"] { order: 2; }
    .foot-grid:has(> [data-generation-block][hidden]) #val-cache-hit {
      order: 3;
      font-size: 13px;
      font-weight: 500;
      line-height: 1.3;
      color: var(--agc-fg);
    }
    .foot-grid:has(> [data-generation-block][hidden]) #val-cache-hit-k { order: 4; margin-left: auto; font-size: 13px; line-height: 1.3; }
    body[data-context-layout="rows"] .foot-grid:has(> [data-generation-block][hidden]) #row-cached,
    body[data-turn-layout="rows"]:has([data-turn-metrics-block]:not([hidden])) .foot-grid:has(> [data-generation-block][hidden]) #row-cached { display: grid; grid-template-columns: 7px minmax(0, 1fr) auto minmax(33px, auto); column-gap: 10px; row-gap: 0; align-items: center; }
    body[data-context-layout="rows"] .foot-grid:has(> [data-generation-block][hidden]) #dot-cached,
    body[data-turn-layout="rows"]:has([data-turn-metrics-block]:not([hidden])) .foot-grid:has(> [data-generation-block][hidden]) #dot-cached { grid-column: 1; grid-row: 1; width: 7px; height: 7px; justify-self: center; overflow: visible; }
    body[data-context-layout="rows"] .foot-grid:has(> [data-generation-block][hidden]) #sb-cache-ring,
    body[data-turn-layout="rows"]:has([data-turn-metrics-block]:not([hidden])) .foot-grid:has(> [data-generation-block][hidden]) #sb-cache-ring { width: 9px; height: 9px; flex-shrink: 0; }
    body[data-context-layout="rows"] .foot-grid:has(> [data-generation-block][hidden]) [data-i18n="cache"],
    body[data-turn-layout="rows"]:has([data-turn-metrics-block]:not([hidden])) .foot-grid:has(> [data-generation-block][hidden]) [data-i18n="cache"] { grid-column: 2; grid-row: 1; margin-left: -5px; }
    body[data-context-layout="rows"] .foot-grid:has(> [data-generation-block][hidden]) #val-cache-hit,
    body[data-turn-layout="rows"]:has([data-turn-metrics-block]:not([hidden])) .foot-grid:has(> [data-generation-block][hidden]) #val-cache-hit { grid-column: 3; grid-row: 1; justify-self: end; }
    body[data-context-layout="rows"] .foot-grid:has(> [data-generation-block][hidden]) #val-cache-hit-k,
    body[data-turn-layout="rows"]:has([data-turn-metrics-block]:not([hidden])) .foot-grid:has(> [data-generation-block][hidden]) #val-cache-hit-k { grid-column: 4; grid-row: 1; margin-left: 0; justify-self: end; }
    .foot-speed-toggle { appearance: none; border: none; background: transparent; font: inherit; color: inherit; text-align: center; flex: 0 0 auto; max-width: 100%; padding: 2px 6px; margin: -2px 0; border-radius: 5px; cursor: pointer; transition: background 0.14s ease, transform 0.1s ease; }
    .foot-speed-toggle:hover { background: var(--agc-hover); }
    .foot-speed-toggle:active { transform: scale(0.985); }
    .foot-speed-toggle .foot-top, .foot-speed-toggle .foot-sub { justify-content: center; flex-wrap: nowrap; white-space: nowrap; }
    .speed-slot { width: 12px; height: 10px; display: inline-flex; align-items: center; justify-content: center; flex-shrink: 0; color: var(--agc-muted); }
    .speed-slot[data-tier="green"] { color: var(--agc-good); }
    .speed-slot[data-tier="yellow"] { color: var(--agc-warn); }
    .speed-slot[data-tier="red"] { color: var(--agc-danger); }
    .speed-slot[data-mode="total"] [data-el="sbSpeedGlyphStream"], .speed-slot[data-mode="stream"] [data-el="sbSpeedGlyphTotal"] { display: none; }
    .quota-group { margin-bottom: var(--agy-section-gap, 9px); transition: opacity 0.16s ease; }
    .stats-quota .quota-group + .quota-group { margin-top: var(--agy-section-gap, 9px); padding-top: var(--agy-section-gap, 9px); border-top: 0.5px solid var(--agc-divider); }
    body[data-highlight-active-model="true"] .quota-group[data-active="false"] { opacity: 0.54; }
    body[data-highlight-active-model="true"] .quota-group[data-active="false"]:hover { opacity: 0.96; }
    .quota-group:last-child, .quota-bucket:last-child { margin-bottom: 0; }
    .quota-title-row { display: flex; justify-content: space-between; align-items: center; gap: 8px; margin-bottom: var(--agy-row-gap, 4px); }
    .quota-group-title {
      overflow-wrap: anywhere;
      font-size: 13px;
      font-weight: 600;
      line-height: 1.35;
      color: var(--agc-fg);
    }
    .quota-group[data-active="true"] .quota-group-title { color: var(--agc-fg-strong); }
    .quota-active { display: none; align-items: center; gap: 4px; font-size: 12px; font-weight: 400; color: var(--agc-fg); white-space: nowrap; flex-shrink: 0; }
    .quota-active-dot { width: 5px; height: 5px; border-radius: 50%; background: var(--agc-good); flex-shrink: 0; }
    body[data-highlight-active-model="true"] .quota-group[data-active="true"] .quota-active { display: inline-flex; }
    .quota-bucket {
      margin-bottom: var(--agy-row-gap, 4px);
      border-radius: 5px;
      padding: 2.5px 5px;
      margin-left: -5px;
      margin-right: -5px;
      transition: background 0.14s ease;
    }
    .quota-bucket:hover { background: var(--agc-hover); }
    .quota-line1 {
      display: grid;
      grid-template-columns: 54px minmax(58px, 1fr) minmax(46px, auto);
      align-items: center;
      column-gap: 8px;
      font-size: 12px;
      line-height: 1.35;
      font-variant-numeric: tabular-nums;
    }
    .quota-label {
      color: var(--agc-muted);
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
      min-width: 0;
    }
    .quota-mid {
      text-align: right;
      color: var(--agc-muted);
      white-space: nowrap;
    }
    .quota-right {
      display: flex;
      justify-content: flex-end;
      align-items: center;
      gap: 6px;
      color: var(--agc-fg-strong);
      font-weight: 500;
      white-space: nowrap;
    }
    .quota-bucket[data-tone="warn"] .quota-pct { color: var(--agc-warn); }
    .quota-bucket[data-tone="danger"] .quota-pct { color: var(--agc-danger); font-weight: 600; }
    .settings { display: flex; flex-direction: column; gap: 0; width: 100%; }
    .sidebar-content { padding: 12px 14px; }
    .sidebar-view[hidden] { display: none; }
    .sidebar-nav { position: sticky; top: 0; z-index: 20; margin: -12px -14px 10px; padding: 8px 14px; background: var(--background, #141414); border-bottom: 0.5px solid var(--agc-divider); }
    .sidebar-tabs { position: relative; display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); align-items: center; max-width: 1120px; margin: 0 auto; padding: 2.5px; border-radius: 7px; background: color-mix(in srgb, var(--foreground, #ebebeb) 6%, var(--background, #141414)); border: 1px solid color-mix(in srgb, var(--foreground, #ebebeb) 10%, transparent); }
    .sidebar-tabs button { position: relative; z-index: 1; min-width: 0; min-height: 26px; padding: 3px 8px; border: 0; border-radius: 5px; background: transparent; color: var(--muted-foreground, #8e8e93); font: inherit; font-size: 12.5px; font-weight: 500; cursor: pointer; transition: color .15s ease; }
    .sidebar-tabs button[aria-selected="true"] { color: var(--foreground, #ebebeb); font-weight: 600; }
    .sidebar-tabs button:hover { color: var(--foreground, #ebebeb); }
    .sidebar-tabs button:focus-visible { outline: 2px solid var(--agc-accent); outline-offset: 1px; }
    .sidebar-toggle-track { position: absolute; inset: 2.5px; border-radius: 5px; pointer-events: none; }
    .sidebar-toggle-thumb { display: block; width: 50%; height: 100%; border-radius: 5px; background: color-mix(in srgb, var(--foreground, #ebebeb) 14%, var(--background, #141414)); box-shadow: 0 1px 2.5px rgba(0,0,0,.22), inset 0 0 0 1px color-mix(in srgb, var(--foreground, #ebebeb) 14%, transparent); transform: translateX(0); transition: transform .18s cubic-bezier(.22,1,.36,1); }
    .sidebar-tabs[data-view="settings"] .sidebar-toggle-thumb { transform: translateX(100%); }
    @media(prefers-reduced-motion:reduce) { .sidebar-toggle-thumb { transition: none; } }
    @media(pointer:coarse) { .sidebar-tabs button { min-height: 44px; } }
    .settings-scope { margin-top: 10px; padding: 12px 0 6px; border-top: 0.5px solid var(--agc-divider); font-size: 12px; font-weight: 600; color: var(--muted-foreground, #8e8e93); letter-spacing: .01em; }
    .settings-scope.metric-setting { position: relative; }
    .settings-scope-title { font-size: 12px; font-weight: 600; color: var(--muted-foreground, #8e8e93); }
    .setting-card { position: relative; display: flex; flex-direction: column; gap: 7px; padding: 9px 0; border-top: 0.5px solid var(--agc-divider); background: transparent; }
    .settings > .setting-card:first-child, .settings-scope + .setting-card { border-top: 0; }
    .setting-card[data-parent-off="true"], [data-parent-off="true"] { opacity: .45; }
    [data-parent-off="true"] .setting-check,
    [data-parent-off="true"] input[type="checkbox"] { cursor: not-allowed; }
    .setting-head.setting-pair-head { justify-content: flex-start; gap: 14px; flex-wrap: nowrap; }
    .setting-pair-item { display: inline-flex; align-items: center; gap: 6px; min-width: 0; }
    .setting-pair-item .setting-check { flex: 0 1 auto; }
    .setting-speed-pair .setting-help-dot, .setting-pair-head .setting-help-dot, .setting-option-card .setting-help-dot { margin-left: auto; }
    .pv-detail-pop { overflow: hidden; max-height: 120px; opacity: 1; margin: 2px 0 6px; transition: max-height .2s ease, opacity .18s ease, margin .2s ease; }
    .pv-detail-pop[data-open="false"] { max-height: 0; opacity: 0; margin: 0; pointer-events: none; }
    .pv-detail-card { padding: 8px 10px; border-radius: 9px; border: 0.5px solid var(--agc-divider); background: color-mix(in srgb, var(--foreground, #ebebeb) 3.5%, var(--background, #141414)); font-size: 11.5px; color: var(--muted-foreground, #8e8e93); font-variant-numeric: tabular-nums; }
    .setting-head { display: flex; align-items: center; justify-content: space-between; gap: 6px; min-height: 22px; }
    .setting-head > label, .setting-label { font-size: 13px; color: var(--foreground, #ebebeb); min-width: 0; }
    .setting-head select { width: auto; min-width: 0; max-width: 56%; margin-left: auto; padding: 3px 7px; font: inherit; font-size: 12px; color: var(--foreground, #ebebeb); background: var(--card, #222225); border: 1px solid var(--border, #444); border-radius: 5px; }
    .setting-check { flex: 1; min-width: 0; display: flex; align-items: center; gap: 7px; cursor: pointer; }
    .setting-check input[type="checkbox"] { appearance: none; -webkit-appearance: none; position: relative; margin: 0; flex-shrink: 0; width: 28px; height: 15px; border-radius: 99px; background: color-mix(in srgb, var(--foreground, #ebebeb) 13%, transparent); border: 1px solid color-mix(in srgb, var(--foreground, #ebebeb) 16%, transparent); cursor: pointer; transition: background .18s ease, border-color .18s ease; }
    .setting-check input[type="checkbox"]::after { content: ""; position: absolute; top: 1.5px; left: 1.5px; width: 10px; height: 10px; border-radius: 50%; background: var(--muted-foreground, #8e8e93); transform: translateX(0); transition: transform .18s cubic-bezier(.22,1,.36,1), background .18s ease; }
    .setting-check input[type="checkbox"]:checked { background: color-mix(in srgb, var(--agc-good) 22%, transparent); border-color: color-mix(in srgb, var(--agc-good) 65%, transparent); }
    .setting-check input[type="checkbox"]:checked::after { transform: translateX(13px); background: var(--agc-good); }
    .setting-check input[type="checkbox"]:focus-visible { outline: 2px solid var(--agc-accent); outline-offset: 1px; }
    .setting-check > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .setting-help-dot { flex-shrink: 0; width: 15px; height: 15px; padding: 0; border-radius: 50%; border: 1px solid var(--border, rgba(142,142,147,.4)); background: transparent; color: var(--muted-foreground, #8e8e93); font: inherit; font-size: 10.5px; line-height: 13px; text-align: center; cursor: help; }
    .metric-help { position: absolute; bottom: calc(100% + 5px); left: 0; z-index: 10; box-sizing: border-box; width: 100%; max-width: 360px; padding: 10px 12px; border: 0.5px solid var(--agc-divider); border-radius: 9px; background: var(--card, #222225); color: var(--foreground, #ebebeb); line-height: 1.5; overflow-wrap: anywhere; box-shadow: 0 8px 24px #0004; visibility: hidden; pointer-events: none; }
    .metric-setting:not([data-help-dismissed]) .setting-head:hover ~ .metric-help,
    .metric-setting:not([data-help-dismissed]):focus-within .metric-help { visibility: visible; }
    .setting-preview { padding: 2px 0 1px; background: transparent; border: 0; font-size: 11.5px; line-height: 1.25; color: var(--muted-foreground, #8e8e93); font-variant-numeric: tabular-nums; overflow: hidden; }
    .pv-svg { width: 11px; height: 11px; flex-shrink: 0; }
    .pv-pill { display: inline-flex; align-items: center; gap: 4px; padding: 2px 6px; border-radius: 5.5px; background: var(--secondary, rgba(128,128,128,.16)); color: var(--muted-foreground, #8e8e93); white-space: nowrap; }
    /* Same-row clickable block pickers */
    .setting-opts { display: inline-flex; align-items: center; gap: 8px; min-width: 0; }
    .setting-option-card:not([data-layout="columns"]) [data-for-layout="columns"],
    .setting-option-card:not([data-layout="rows"]) [data-for-layout="rows"] { display: none; }
    .setting-option-card[data-checked="false"] .setting-opts { opacity: .45; pointer-events: none; }
    .setting-opts-extra { display: inline-flex; }
    .setting-seg { display: inline-flex; flex-shrink: 0; padding: 2px; gap: 2px; border-radius: 6px; background: color-mix(in srgb, var(--foreground, #ebebeb) 6%, transparent); border: 1px solid color-mix(in srgb, var(--foreground, #ebebeb) 12%, transparent); }
    .setting-seg-opt { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 17px; padding: 0; border: 1px solid transparent; border-radius: 4px; background: transparent; color: var(--muted-foreground, #8e8e93); font: inherit; cursor: pointer; transition: background .18s ease, color .18s ease, border-color .18s ease; }
    .setting-seg-opt:hover { color: var(--foreground, #ebebeb); }
    .setting-seg-opt[data-active="true"] { background: color-mix(in srgb, var(--foreground, #ebebeb) 14%, var(--card, #222225)); border-color: color-mix(in srgb, var(--foreground, #ebebeb) 18%, transparent); color: var(--agc-good); }
    .setting-seg-text .setting-seg-opt { width: auto; min-width: 24px; padding: 0 7px; font-size: 11px; line-height: 1; white-space: nowrap; }
    .setting-seg-opt:focus-visible, .pv-field-toggle:focus-visible { outline: 2px solid var(--agc-accent); outline-offset: 1px; }
    .pv-detail-pop[data-layout="rows"] > [data-for-layout="columns"],
    .pv-detail-pop[data-layout="columns"] > [data-for-layout="rows"] { display: none; }
    .pv-fields { display: flex; flex-direction: column; }
    .pv-field-row { display: grid; grid-template-columns: 8px repeat(4, minmax(0, 1fr)) 22px; align-items: center; column-gap: 6px; padding: 1px 0; border-radius: 4px; transition: box-shadow .12s ease; }
    .pv-field-row[draggable="true"] { cursor: grab; }
    .pv-field-row[data-dragging="true"] { opacity: .5; }
    .pv-field-row[data-drop="before"] { box-shadow: inset 0 2px 0 var(--agc-good); }
    .pv-field-row[data-drop="after"] { box-shadow: inset 0 -2px 0 var(--agc-good); }
    .pv-field-grip { width: 6px; height: 10px; opacity: .55; background-image: radial-gradient(currentColor 1px, transparent 1.2px); background-size: 3px 3.4px; }
    .pv-field-row[data-on="false"] .pv-field-grip { visibility: hidden; }
    .pv-field-cell { min-width: 0; padding-left: 5px; border-left: 2px solid var(--pv-c); line-height: 1.35; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .pv-field-row[data-on="false"] .pv-field-cell { border-left-color: transparent; text-decoration: line-through; opacity: .5; }
    .pv-field-toggle { position: relative; justify-self: end; width: 22px; height: 12px; padding: 0; border-radius: 99px; background: color-mix(in srgb, var(--agc-good) 22%, transparent); border: 1px solid color-mix(in srgb, var(--agc-good) 65%, transparent); cursor: pointer; transition: background .18s ease, border-color .18s ease; }
    .pv-field-toggle::after { content: ""; position: absolute; top: 1px; left: 11px; width: 8px; height: 8px; border-radius: 50%; background: var(--agc-good); transition: left .18s cubic-bezier(.22,1,.36,1), background .18s ease; }
    .pv-field-toggle[aria-checked="false"] { background: color-mix(in srgb, var(--foreground, #ebebeb) 13%, transparent); border-color: color-mix(in srgb, var(--foreground, #ebebeb) 16%, transparent); }
    .pv-field-toggle[aria-checked="false"]::after { left: 1px; background: var(--muted-foreground, #8e8e93); }
    .seg-ico { display: inline-flex; width: 11px; height: 9px; }
    .seg-ico > i { background: currentColor; border-radius: 1px; }
    .seg-ico-cols { justify-content: space-between; }
    .seg-ico-cols > i { width: 1.5px; height: 100%; }
    .seg-ico-rows { flex-direction: column; justify-content: space-between; }
    .seg-ico-rows > i { width: 100%; height: 1.5px; }
    .seg-ico-marker { width: 7px; height: 7px; border-radius: 1.5px; background: currentColor; }
    .seg-ico-dot { border-radius: 50%; }
    .pv-live .item-label, .pv-live .item-k, .pv-live .item-pct, .pv-live .turn-bar-label, .pv-live .turn-bar-short, .pv-live .turn-bar-val { font-size: 11.5px; }
    .pv-live .list, .pv-live .turn-bar-list { row-gap: 4px; }
    .pv-pick-inline { display: inline-flex; flex-wrap: wrap; justify-content: flex-end; align-items: center; gap: 5px; margin-left: auto; }
    .pv-swatch { display: inline-flex; align-items: center; justify-content: center; gap: 5px; min-width: 0; min-height: 27px; padding: 4px 6px; border-radius: 5.5px; border: 0.5px solid var(--agc-divider); background: var(--card, #222225); color: var(--muted-foreground, #8e8e93); font: inherit; font-size: 11px; cursor: pointer; transition: border-color .12s ease, color .12s ease; }
    .pv-swatch-icon { min-width: 38px; padding: 4px 10px; }
    .pv-swatch:hover { background: var(--secondary, #303034); color: var(--foreground, #ebebeb); }
    .pv-swatch[data-active="true"] { border-color: var(--agc-accent); color: var(--foreground, #ebebeb); background: color-mix(in srgb, var(--agc-accent) 14%, var(--card, #222225)); font-weight: 500; }
    .pv-ico-layout { display: inline-flex; align-items: flex-end; gap: 2.5px; height: 12px; flex-shrink: 0; }
    .pv-ico-layout i { display: block; width: 5px; border: 1.2px solid currentColor; border-radius: 1.5px; }
    .pv-il-tall { height: 12px; }
    .pv-il-short { height: 7.5px; }
    .pv-ico-skin { display: inline-block; width: 13px; height: 10px; border-radius: 2.5px; flex-shrink: 0; }
    .pv-skin-frosted { background: linear-gradient(135deg, color-mix(in srgb, currentColor 28%, transparent), color-mix(in srgb, currentColor 8%, transparent)); border: 0.5px solid color-mix(in srgb, currentColor 55%, transparent); box-shadow: inset 0 0.5px 0 rgba(255,255,255,0.28); }
    .pv-skin-native { background: transparent; border: 1.2px solid currentColor; }
    .pv-ico-density { display: inline-flex; flex-direction: column; justify-content: center; width: 12px; height: 12px; flex-shrink: 0; }
    .pv-ico-density i { display: block; height: 1.5px; width: 100%; background: currentColor; border-radius: 1px; }
    .pv-ico-density i:nth-child(2) { width: 75%; }
    .pv-id-compact { gap: 1.5px; }
    .pv-id-standard { gap: 2.8px; }
    .pv-id-spacious { gap: 4px; }
    .pv-ico-bar { width: 16px; height: 4px; border-radius: 99px; background: rgba(142,142,147,.3); overflow: hidden; flex-shrink: 0; }
    .pv-ico-bar i { display: block; width: 78%; height: 100%; background: var(--agc-good); border-radius: inherit; }
    /* Active model highlight: state-driven */
    .pv-active-model { display: flex; flex-direction: column; gap: 4px; }
    .pv-qm-row { display: grid; grid-template-columns: 58px 1fr auto; align-items: center; gap: 6px; transition: opacity .2s ease; }
    .pv-qm-name { display: inline-flex; align-items: center; gap: 4px; color: var(--foreground, #ebebeb); font-weight: 500; }
    .pv-qm-dot { width: 4.5px; height: 4.5px; border-radius: 50%; background: var(--agc-good); opacity: 0; transform: scale(.5); transition: opacity .2s ease, transform .2s ease; }
    .pv-qm-bar { height: 4px; border-radius: 99px; background: rgba(142,142,147,.24); overflow: hidden; }
    .pv-qm-bar > span { display: block; height: 100%; background: var(--agc-good); border-radius: inherit; }
    .pv-qm-pct { font-size: 10.5px; }
    .pv-qm-other { opacity: 1; transition: opacity .2s ease; }
    [data-setting-card="highlightActiveModel"][data-checked="true"] .pv-qm-other { opacity: .38; }
    [data-setting-card="highlightActiveModel"][data-checked="true"] .pv-qm-dot { opacity: 1; transform: scale(1); }
    /* Hide absent quota windows: unchecked shows --%, checked hides --% while keeping 0% */
    .pv-hide-quota { display: flex; align-items: center; gap: 6px; }
    .pv-hq-pill { flex: 0 0 auto; gap: 0; }
    .pv-hq-miss, .pv-hq-zero, .pv-hq-keep { display: inline-flex; align-items: center; gap: 3px; overflow: hidden; white-space: nowrap; }
    .pv-hq-miss { max-width: 56px; opacity: 1; margin-right: 6px; transition: max-width .22s ease, opacity .18s ease, margin-right .22s ease; }
    .pv-hq-zero { margin-right: 6px; color: var(--agc-danger); font-weight: 600; }
    [data-setting-card="hideUnavailableQuota"][data-checked="true"] .pv-hq-miss { max-width: 0; opacity: 0; margin-right: 0; }
    /* Cache expiry alert: unchecked all neutral, checked 3m+ yellow icon, 4m+ red icon */
    .pv-cache-warn { display: flex; align-items: center; gap: 6px; }
    .pv-cache-warn .pv-pill { flex: 0 0 auto; }
    .pv-cache-warn .pv-svg { transition: color .18s ease; }
    [data-setting-card="showCacheWarnings"][data-checked="true"] .pv-ca-2 .pv-svg { color: var(--agc-warn); }
    [data-setting-card="showCacheWarnings"][data-checked="true"] .pv-ca-3 .pv-svg { color: var(--agc-danger); }
    /* Context warning colors: normal stays neutral; only 75% / 90% change color. */
    .pv-ctx-warn { display: flex; align-items: center; gap: 6px; }
    .pv-ctx-warn .pv-pill { flex: 0 0 auto; }
    .pv-cw-val { color: var(--muted-foreground, #8e8e93); font-weight: 400; transition: color .18s ease; }
    [data-setting-card="showContextWarnings"][data-checked="true"] .pv-cw-2 .pv-cw-val { color: var(--agc-warn); font-weight: 600; }
    [data-setting-card="showContextWarnings"][data-checked="true"] .pv-cw-3 .pv-cw-val { color: var(--agc-danger); font-weight: 600; }
    /* Request failure capsule: unchecked hides 3rd error pill, checked shows it */
    .pv-err-strip { display: flex; align-items: center; gap: 6px; }
    .pv-err-strip .pv-pill { flex: 0 0 auto; }
    .pv-pill-err { color: var(--agc-danger); background: color-mix(in srgb, var(--agc-danger) 14%, transparent); font-weight: 600; max-width: 120px; opacity: 1; overflow: hidden; transition: max-width .22s ease, opacity .18s ease, padding .22s ease; }
    [data-setting-card="showRequestErrors"][data-checked="false"] .pv-pill-err { max-width: 0; opacity: 0; padding-left: 0; padding-right: 0; }
    .pv-req-card { display: flex; flex-direction: column; }
    .pv-req-bar { display: flex; gap: 1px; width: 100%; height: 3.5px; border-radius: 99px; overflow: hidden; background: var(--agc-track, rgba(120,120,128,.24)); opacity: .72; order: 0; }
    .pv-req-bar > i { display: block; height: 100%; }
    .pv-req-divider { height: 0.5px; background: var(--agc-divider); margin: 6px 0; order: 1; }
    .pv-req-3col { display: flex; justify-content: space-between; align-items: flex-start; column-gap: 8px; order: 2; }
    [data-setting-card="showRequestMetrics"][data-position="top"] .pv-req-3col,
    [data-setting-card="showRequestMetrics"][data-position="top"] .pv-req-c1 { order: 0; }
    [data-setting-card="showRequestMetrics"][data-position="top"] .pv-req-bar { order: 2; }
    .pv-req-col { flex: 0 1 auto; min-width: 0; }
    .pv-req-mid { flex: 0 0 auto; max-width: 100%; text-align: center; }
    .pv-req-end { text-align: right; }
    .pv-req-top { display: flex; align-items: center; gap: 4px; font-weight: 500; color: var(--agc-fg-strong); white-space: nowrap; }
    .pv-req-mid .pv-req-top { justify-content: center; }
    .pv-req-end .pv-req-top { justify-content: flex-end; }
    .pv-req-sub { margin-top: 2px; font-size: 11px; color: var(--agc-muted); display: flex; flex-wrap: wrap; align-items: center; column-gap: 4px; row-gap: 1px; }
    .pv-req-sub > span { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
    .pv-req-mid .pv-req-sub { justify-content: center; flex-wrap: nowrap; white-space: nowrap; }
    .pv-req-end .pv-req-sub { justify-content: flex-end; }
    .pv-req-ring, .pv-req-speed-ico { color: var(--agc-good); display: inline-flex; flex-shrink: 0; }
    .pv-req-c1 { display: none; align-items: center; gap: 5px; font-size: 12px; color: var(--agc-muted); order: 2; }
    .pv-req-c1 b { font-weight: 500; color: var(--agc-fg-strong); }
    .pv-req-c1-age { margin-left: auto; }
    [data-setting-card="showRequestMetrics"][data-checked="false"] .pv-req-3col { display: none; }
    [data-setting-card="showRequestMetrics"][data-checked="false"] .pv-req-c1 { display: flex; }
    /* Speed breathing & cooldown */
    .pv-speed-cap { display: flex; align-items: center; }
    .pv-speed-cap .pv-pill { gap: 5px; }
    .pv-sc-val { display: inline-flex; align-items: center; gap: 4px; max-width: 90px; opacity: 1; overflow: hidden; white-space: nowrap; transition: max-width .22s ease, opacity .18s ease, margin .22s ease; }
    [data-setting-card="showSpeed"][data-checked="false"] .pv-sc-val { max-width: 0; opacity: 0; margin-left: -5px; }
    .pv-sc-val .pv-sa-dot { display: none; }
    [data-setting-card="showSpeed"][data-speed-fx="true"] .pv-sc-val { color: var(--agc-good); font-weight: 600; }
    [data-setting-card="showSpeed"][data-speed-fx="true"] .pv-sc-val .pv-sa-dot { display: inline-block; }
    .pv-sa-dot { width: 5px; height: 5px; border-radius: 50%; background: currentColor; flex-shrink: 0; animation: dk-speed-breathe 1.2s ease-in-out infinite; }
    [data-setting-card="showSpeed"][data-speed-fx="true"]:hover .pv-sc-val,
    [data-setting-card="showSpeed"][data-speed-fx="true"]:focus-within .pv-sc-val { animation: pv-speed-lifecycle 3.6s ease-in-out infinite; }
    @keyframes dk-speed-breathe { 0%,100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.78); } }
    @keyframes pv-speed-lifecycle { 0%,60% { color: var(--agc-good); } 75%,95% { color: var(--muted-foreground, #8e8e93); } 100% { color: var(--agc-good); } }
    @media (prefers-reduced-motion: reduce) {
      .setting-card *, .setting-card *::before, .setting-card *::after { animation: none !important; transition: none !important; }
    }
    .quota-meter { display: inline-block; flex: 1; min-width: 20px; max-width: none; height: 4px; background: var(--agc-track, rgba(120,120,128,.24)); box-shadow: inset 0 0 0 0.5px var(--agc-track-ring, rgba(255,255,255,.06)); border-radius: 99px; overflow: hidden; }
    .quota-meter > span { display: block; height: 100%; border-radius: inherit; background-image: linear-gradient(180deg, var(--agc-seg-sheen, rgba(255,255,255,.16)) 0%, transparent 72%); transition: width 0.25s ease; }
    .generation-block { margin-top: var(--agy-section-gap, 9px); padding-top: var(--agy-section-gap, 9px); border-top: 0.5px solid var(--agc-divider); color: var(--agc-muted); font-variant-numeric: tabular-nums; }
    .panel .list { row-gap: var(--agy-row-gap); }
    .panel .quota-group { margin: 0; min-width: 0; }
    .panel .quota-group-title { margin-bottom: 0; }
    .panel .quota-bucket { margin-bottom: var(--agy-row-gap); }
    .panel .quota-bucket:last-child { margin-bottom: 0; }
    .panel .generation-block { margin-top: var(--agy-section-gap); padding-top: var(--agy-section-gap); }
    body[data-quota-indicator="bar"] .quota-right { min-width: 0; justify-content: flex-end; }
    body[data-quota-indicator="bar"] .quota-right > span:last-child { min-width: 34px; text-align: right; }
    body[data-quota-indicator="bar"] .quota-line1 { grid-template-columns: 54px minmax(0, 1fr) minmax(46px, auto); }
    body[data-language^="zh"] .quota-line1 { grid-template-columns: 42px minmax(58px, 1fr) minmax(46px, auto); }
    body[data-language^="zh"][data-quota-indicator="bar"] .quota-line1 { grid-template-columns: 42px minmax(0, 1fr) minmax(46px, auto); }
    .quota-group:not(:has(.quota-mid:not(:empty))) .quota-line1 { grid-template-columns: 54px minmax(0, 1fr); }
    body[data-language^="zh"] .quota-group:not(:has(.quota-mid:not(:empty))) .quota-line1 { grid-template-columns: 42px minmax(0, 1fr); }
    .quota-group:not(:has(.quota-mid:not(:empty))) .quota-mid { display: none; }
    #quota-root.stats-quota { grid-template-columns: minmax(48px, max-content) minmax(18px, 1fr) max-content minmax(0, max-content); column-gap: 8px; row-gap: 0; }
    body[data-language^="zh"] #quota-root.stats-quota { grid-template-columns: minmax(38px, max-content) minmax(18px, 1fr) max-content minmax(0, max-content); }
    /* Only narrow cards share their internal columns through the parent grid. */
    @container stats (width < 420px) {
      #quota-root.stats-quota:not(:has(.quota-mid:not(:empty))) { grid-template-columns: minmax(48px, max-content) minmax(18px, 1fr) max-content; }
      body[data-language^="zh"] #quota-root.stats-quota:not(:has(.quota-mid:not(:empty))) { grid-template-columns: minmax(38px, max-content) minmax(18px, 1fr) max-content; }
    }
    #quota-root.stats-quota .quota-group { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; }
    #quota-root.stats-quota .quota-title-row { grid-column: 1 / -1; }
    #quota-root.stats-quota .quota-bucket, #quota-root.stats-quota .quota-line1 { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: center; }
    #quota-root.stats-quota .quota-label { grid-column: 1; }
    #quota-root.stats-quota .quota-right { grid-column: 2 / 4; display: grid; grid-template-columns: subgrid; align-items: center; column-gap: 8px; min-width: 0; }
    #quota-root.stats-quota .quota-right > svg { grid-column: 1; justify-self: end; }
    #quota-root.stats-quota .quota-meter { grid-column: 1; width: 100%; }
    #quota-root.stats-quota .quota-pct { grid-column: 2; justify-self: end; min-width: 0; text-align: right; }
    #quota-root.stats-quota .quota-mid { grid-column: 4; justify-self: end; text-align: right; }
    @container stats (min-width: 420px) {
      .stats-layout { gap: var(--agy-section-gap, 9px); }
      .stats-context,
      .panel .quota-group,
      .stats-quota .quota-group + .quota-group {
        margin-top: 0;
        padding: var(--agy-pad-y, 10px) var(--agy-pad-x, 12px);
        border-radius: 11px;
        border: 0.5px solid var(--agc-divider);
        background: color-mix(in srgb, var(--foreground, #ebebeb) 3%, transparent);
      }
      .stats-layout > .divider { display: none; }
      #quota-root.stats-quota,
      body[data-language^="zh"] #quota-root.stats-quota {
        grid-template-columns: repeat(auto-fit, minmax(195px, 1fr));
        gap: var(--agy-section-gap, 9px);
      }
      #quota-root.stats-quota .quota-group {
        grid-column: auto;
        grid-template-columns: minmax(48px, max-content) minmax(18px, 1fr) max-content minmax(0, max-content);
        column-gap: 8px;
        align-content: start;
      }
      body[data-language^="zh"] #quota-root.stats-quota .quota-group {
        grid-template-columns: minmax(38px, max-content) minmax(18px, 1fr) max-content minmax(0, max-content);
      }
      #quota-root.stats-quota .quota-group:not(:has(.quota-mid:not(:empty))) {
        grid-template-columns: minmax(48px, max-content) minmax(18px, 1fr) max-content;
      }
      body[data-language^="zh"] #quota-root.stats-quota .quota-group:not(:has(.quota-mid:not(:empty))) {
        grid-template-columns: minmax(38px, max-content) minmax(18px, 1fr) max-content;
      }
    }
    @container stats (min-width: 540px) {
      .stats-layout {
        grid-template-columns: clamp(260px, 36%, 350px) minmax(0, 1fr);
        align-items: start;
      }
      .stats-layout:has(> #quota-root:empty) {
        grid-template-columns: minmax(0, 380px);
        justify-content: center;
      }
      #quota-root.stats-quota,
      body[data-language^="zh"] #quota-root.stats-quota {
        grid-template-columns: repeat(auto-fit, minmax(210px, 1fr));
      }
    }
    body:not([data-context-layout="rows"]) .item-pct { display: none; }
    body[data-column-percent="true"]:not([data-context-layout="rows"]) .item-pct { display: block; }
    body[data-column-label="false"]:not([data-context-layout="rows"]) .item-label,
    body[data-column-value="false"]:not([data-context-layout="rows"]) .item-k { display: none; }
    body[data-context-layout="rows"] .list { grid-template-columns: auto minmax(0, 1fr) auto minmax(38px, auto); column-gap: 8px; align-items: center; margin: 0 -5px; }
    body[data-context-layout="rows"] .item-row,
    body[data-turn-layout="rows"] .turn-bar-item { grid-column: 1 / -1; display: grid; grid-template-columns: subgrid; align-items: center; padding: 2.5px 5px; border-radius: 5px; transition: background 0.14s ease, opacity 0.14s ease; }
    body[data-context-layout="rows"] .item-row:hover,
    body[data-turn-layout="rows"] .turn-bar-item:hover { background: var(--agc-hover); }
    body[data-context-layout="rows"] .item-body { grid-column: 2 / -1; display: grid; grid-template-columns: subgrid; column-gap: 10px; align-items: center; }
    body[data-context-layout="rows"] .item-label { grid-column: 1; grid-row: 1; }
    body[data-context-layout="rows"] .item-pct { grid-column: 2; grid-row: 1; justify-self: end; }
    body[data-context-layout="rows"] .item-k { grid-column: 3; grid-row: 1; justify-self: end; }
    body[data-turn-layout="rows"] .turn-bar-list { grid-template-columns: auto minmax(0, 1fr) auto; column-gap: 8px; row-gap: var(--agy-row-gap); align-items: center; margin: 0 -5px; }
    body[data-turn-layout="rows"] .turn-bar-label { grid-column: 2; grid-row: 1; display: block; }
    body[data-turn-layout="rows"] .turn-bar-short { display: none; }
    body[data-turn-layout="rows"] .turn-bar-item[data-turn-row="requests"] { container-type: normal; }
    body[data-turn-layout="rows"] .turn-bar-val { grid-column: 3; grid-row: 1; justify-self: end; }
    body[data-context-layout="rows"] .item-row > .dot,
    body[data-turn-layout="rows"] .turn-bar-line { grid-column: 1; grid-row: 1; align-self: center; width: 7px; height: 7px; margin: 0; border-radius: 2px; }
    body[data-context-marker="dot"][data-context-layout="rows"] .item-row > .dot,
    body[data-turn-marker="dot"][data-turn-layout="rows"] .turn-bar-line { border-radius: 50%; }
    body[data-show-context-breakdown="false"] .panel .list { display: none; }
    body[data-show-context-breakdown="false"] .panel .progress-track { margin-bottom: 0; }
    .item-label { order: var(--agy-order-label, 0); }
    .item-k { order: var(--agy-order-value, 1); }
    .item-pct { order: var(--agy-order-percent, 2); }
    body[data-label-case="lowercase"] .panel .used-pct,
    body[data-label-case="lowercase"] .panel .foot-sub,
    body[data-label-case="lowercase"] .panel .item-label,
    body[data-label-case="lowercase"] .panel .turn-bar-label,
    body[data-label-case="lowercase"] .panel .turn-bar-short,
    body[data-label-case="lowercase"] .panel .quota-label { text-transform: lowercase; }
    .cdp-notice { max-width: 1120px; margin: 0 auto 10px; padding: 8px 10px; border-radius: 7px; border: 1px solid color-mix(in srgb, var(--agc-warn, #e0a030) 45%, transparent); background: color-mix(in srgb, var(--agc-warn, #e0a030) 8%, var(--background, #141414)); font-size: 12px; color: var(--muted-foreground, #8e8e93); }
    .cdp-notice[hidden] { display: none; }
    .cdp-notice-title { font-weight: 600; color: var(--foreground, #ebebeb); margin-bottom: 3px; }
    .cdp-notice p { margin: 0 0 4px; }
    .cdp-notice summary { cursor: pointer; color: var(--foreground, #ebebeb); }
    .cdp-notice ol { margin: 5px 0 0; padding-left: 18px; display: grid; gap: 4px; }
    .cdp-notice code { user-select: text; font-family: ui-monospace, Consolas, monospace; font-size: 11px; padding: 0 3px; border-radius: 3px; background: color-mix(in srgb, var(--foreground, #ebebeb) 8%, transparent); color: var(--foreground, #ebebeb); word-break: break-all; }
    @media(pointer:coarse) { .pv-swatch { min-height: 40px; } }
  </style>
</head>
<body data-ui-skin="${DEFAULT_UI_SKIN}">
  <main class="sidebar-content">
  <div class="sidebar-nav">
    <div class="sidebar-tabs" role="tablist" aria-label="Sidebar 页面" data-view="stats">
      <button type="button" id="sidebar-tab-stats" role="tab" aria-selected="true" aria-controls="sidebar-stats" tabindex="0">统计</button>
      <span class="sidebar-toggle-track" aria-hidden="true"><span class="sidebar-toggle-thumb"></span></span>
      <button type="button" id="sidebar-tab-settings" role="tab" aria-selected="false" aria-controls="sidebar-settings" tabindex="-1">设置</button>
    </div>
  </div>
  <aside class="cdp-notice" id="cdp-notice" role="status" hidden>
    <div class="cdp-notice-title" data-cdp-i18n="cdpTitle">底栏胶囊未启用</div>
    <p data-cdp-i18n="cdpBody"></p>
    <details>
      <summary data-cdp-i18n="cdpHow">设置方法</summary>
      <ol>
        <li><span data-cdp-i18n="cdpScript"></span> <code>powershell -ExecutionPolicy Bypass -File scripts\\enable-cdp.ps1</code></li>
        <li><span data-cdp-i18n="cdpManual"></span> <code>--remote-debugging-port=0</code></li>
        <li data-cdp-i18n="cdpRestart"></li>
      </ol>
    </details>
  </aside>
  <div class="panel sidebar-view" id="sidebar-stats" role="tabpanel" aria-labelledby="sidebar-tab-stats" tabindex="0">
    <div class="stats-layout">
      <section class="stats-context">
        <div class="summary-row">
          <div class="used-pct" data-context-tip="overview"><span data-i18n="ctxTitle">Context</span> <span id="used-pct">0%</span> <span data-i18n="used">used</span></div>
          <div class="used-fraction" id="used-fraction" data-context-tip="overview">0 / --</div>
        </div>

        <div class="progress-track" id="progress-track" data-context-tip="overview">
          <div class="seg" id="seg-turn0" data-cat="turn0" style="width: 0%; background: var(--agc-c-turn0)"></div>
          <div class="seg" id="seg-read" data-cat="read" style="width: 0%; background: var(--agc-c-read)"></div>
          <div class="seg" id="seg-think" data-cat="think" style="width: 0%; background: var(--agc-c-think)"></div>
          <div class="seg" id="seg-out" data-cat="out" style="width: 0%; background: var(--agc-c-out)"></div>
        </div>

        <div class="list">
          <div class="item-row" id="row-turn0" data-cat="turn0" data-context-tip="turn0">
            <span class="dot" style="background:var(--agc-c-turn0)"></span>
            <div class="item-body"><span class="item-label" data-i18n="turn0">Turn0</span><span class="item-k" id="val-turn0-k">0</span><span class="item-pct" id="val-turn0-pct">0%</span></div>
          </div>

          <div class="item-row" id="row-read" data-cat="read" data-context-tip="read">
            <span class="dot" style="background:var(--agc-c-read)"></span>
            <div class="item-body"><span class="item-label" data-i18n="read">Read</span><span class="item-k" id="val-read-k">0</span><span class="item-pct" id="val-read-pct">0%</span></div>
          </div>

          <div class="item-row" id="row-think" data-cat="think" data-context-tip="think">
            <span class="dot" style="background:var(--agc-c-think)"></span>
            <div class="item-body"><span class="item-label" data-i18n="think">Think</span><span class="item-k" id="val-think-k">0</span><span class="item-pct" id="val-think-pct">0%</span></div>
          </div>

          <div class="item-row" id="row-out" data-cat="out" data-context-tip="write">
            <span class="dot" style="background:var(--agc-c-out)"></span>
            <div class="item-body"><span class="item-label" data-i18n="write">Write</span><span class="item-k" id="val-out-k">0</span><span class="item-pct" id="val-out-pct">0%</span></div>
          </div>
        </div>

        ${presentation.turnMetricsMarkup()}
        <div class="divider"></div>
        <div class="foot-grid">
          <div class="foot-col" id="row-cached">
            <div class="foot-top">
              <span class="dot" id="dot-cached" style="display:inline-flex;align-items:center;justify-content:center;background:transparent">
                <svg class="cache-ring" id="sb-cache-ring" viewBox="0 0 12 12" width="11" height="11" aria-hidden="true"><circle cx="6" cy="6" r="4.5" fill="none" stroke="var(--agc-ring-track, rgba(142,142,147,0.28))" stroke-width="1.8"></circle><circle id="sb-cache-arc" cx="6" cy="6" r="4.5" fill="none" stroke="currentColor" stroke-width="1.8" stroke-dasharray="0 28.27" transform="rotate(-90 6 6)" style="display:none"></circle></svg>
              </span>
              <span class="foot-val cache-pct" id="val-cache-hit">0%</span>
            </div>
            <div class="foot-sub"><span data-i18n="cache">Cache</span><span class="cache-k" id="val-cache-hit-k"></span></div>
          </div>
          <div class="foot-gen-wrap" data-generation-block>
            <button type="button" class="foot-col foot-speed-toggle" id="sb-speed-toggle" aria-pressed="false">
              <div class="foot-top">
                <span class="speed-slot" id="sb-speed-slot" data-mode="total"><svg viewBox="0 0 14 12" width="11" height="10" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path data-el="sbSpeedGlyphTotal" d="M2.6 3.1L6.3 6.0 2.6 8.9M7.5 8.9H11.5"></path><path data-el="sbSpeedGlyphStream" d="M3.8 9.5A2.3 2.3 0 0 1 4.07 4.92 3.2 3.2 0 0 1 10.4 5.5 2.0 2.0 0 0 1 10.5 9.5Z"></path></svg></span>
                <span class="foot-val" data-generation="speed">—</span>
              </div>
              <div class="foot-sub"><span data-generation="timing">—</span></div>
            </button>
            <div class="foot-col foot-right" data-el="footOutCol">
              <div class="foot-top foot-top-right"><span class="foot-val" data-el="footOutVal">—</span></div>
              <div class="foot-sub foot-sub-right"><span data-el="footOutSub">—</span></div>
            </div>
          </div>
        </div>
      </section>
      <div class="divider"></div>
      <div id="quota-root" class="stats-quota"></div>
    </div>
  </div>

  <section class="settings sidebar-view" id="sidebar-settings" role="tabpanel" aria-labelledby="sidebar-tab-settings" tabindex="0" hidden>
    ${renderPickCard('settingsLanguage', [
      ['en', '', 'EN'],
      ['zh-CN', '', '简'],
      ['zh-TW', '', '繁'],
    ])}
    ${renderPickCard('language', [
      ['en', '', 'EN'],
      ['zh-CN', '', '简'],
      ['zh-TW', '', '繁'],
    ])}

    <div class="settings-scope" data-i18n="appearanceSection"></div>
    ${renderPickCard('uiSkin', [
      ['native', 'nativeSkin', '<span class="pv-ico-skin pv-skin-native" aria-hidden="true"></span><span data-i18n="nativeSkin">Native</span>'],
      ['frosted', 'frostedSkin', '<span class="pv-ico-skin pv-skin-frosted" aria-hidden="true"></span><span data-i18n="frostedSkin">Frosted</span>'],
    ])}
    ${renderPickCard('panelLayout', [
      ['natural', 'naturalLayout', '<span class="pv-ico-layout"><i class="pv-il-tall"></i><i class="pv-il-short"></i></span>'],
      ['matched', 'matchedLayout', '<span class="pv-ico-layout"><i class="pv-il-tall"></i><i class="pv-il-tall"></i></span>'],
    ])}
    ${renderPickCard('density', [
      ['compact', 'compact', '<span class="pv-ico-density pv-id-compact"><i></i><i></i><i></i></span>'],
      ['standard', 'standard', '<span class="pv-ico-density pv-id-standard"><i></i><i></i><i></i></span>'],
      ['spacious', 'spacious', '<span class="pv-ico-density pv-id-spacious"><i></i><i></i><i></i></span>'],
    ])}
    ${renderPickCard('labelCase', [
      ['lowercase', 'lowercase', 'aa'],
      ['titlecase', 'titlecase', 'Aa'],
    ])}
    ${renderPickCard('quotaIndicator', [
      ['ring', 'ring', PV_SVG.ring],
      ['bar', 'bar', '<span class="pv-ico-bar"><i></i></span>'],
    ])}
    ${renderPickCard('resetFormat', [
      ['compact', 'compactTime', '4h 55m'],
      ['localized', 'localizedTime', '<span data-stats-i18n="localizedTimeSample"></span>'],
    ])}

    <div class="settings-scope" data-settings-scope="features" data-i18n="featuresSection"></div>
    ${renderCheckCard({ id: 'setting-highlight-active-model', key: 'highlightActiveModel', checked: DEFAULT_SETTINGS.highlightActiveModel })}
    ${renderCheckCard({ id: 'setting-hide-unavailable-quota', key: 'hideUnavailableQuota', checked: DEFAULT_SETTINGS.hideUnavailableQuota })}
    ${renderCheckCard({ id: 'setting-cache-warnings', key: 'showCacheWarnings', checked: DEFAULT_SETTINGS.showCacheWarnings })}
    ${renderCheckCard({ id: 'setting-context-warnings', key: 'showContextWarnings', checked: DEFAULT_SETTINGS.showContextWarnings })}
    ${renderCheckCard({ id: 'setting-request-errors', key: 'showRequestErrors', checked: DEFAULT_SETTINGS.showRequestErrors })}
    <div class="setting-card setting-speed-pair metric-setting" data-setting-card="showSpeed" data-checked="true" data-speed-fx="false">
      <div class="setting-head setting-pair-head">
        <div class="setting-pair-item">
          <label class="setting-check">
            <input id="setting-show-speed" name="showSpeed" type="checkbox" checked aria-describedby="help-speed-pair" />
            <span data-i18n="showSpeed"></span>
          </label>
        </div>
        <div class="setting-pair-item" data-setting-card="speedAnimation" data-checked="false" data-parent-off="false">
          <label class="setting-check">
            <input id="setting-speed-animation" name="speedAnimation" type="checkbox" aria-describedby="help-speed-pair" />
            <span data-i18n="speedAnimation"></span>
          </label>
        </div>
        <span class="setting-help-dot" aria-hidden="true">?</span>
      </div>
      <div class="setting-preview" aria-hidden="true">
        <div class="pv-speed-cap">
          <span class="pv-pill">${PV_SVG.db}<span>42%</span><span class="pv-sc-val"><span class="pv-sa-dot"></span><span>38.4 tok/s</span></span></span>
        </div>
      </div>
      <div class="metric-help" id="help-speed-pair" role="tooltip" data-i18n="speedPairTip"></div>
    </div>
    <div class="setting-card setting-option-card" data-setting-card="showContextBreakdown" data-layout-key="contextLayout" data-checked="${DEFAULT_SETTINGS.showContextBreakdown}" data-layout="${DEFAULT_SETTINGS.contextLayout}">
      <div class="setting-head setting-pair-head">
        <div class="setting-pair-item"><label class="setting-check"><input id="setting-show-context-breakdown" name="showContextBreakdown" type="checkbox"${DEFAULT_SETTINGS.showContextBreakdown ? ' checked' : ''} /><span data-i18n="showContextBreakdown"></span></label></div>
        <div class="setting-opts">${renderSeg('contextLayout', LAYOUT_OPTIONS)}<span class="setting-opts-extra" data-for-layout="rows">${renderSeg('contextMarker', MARKER_OPTIONS)}</span></div>
      </div>
    </div>
    <div class="pv-detail-pop" data-preview-group="context" data-open="${DEFAULT_SETTINGS.showContextBreakdown}" data-layout="${DEFAULT_SETTINGS.contextLayout}">
      <div class="pv-detail-card pv-fields" data-for-layout="columns" data-field-editor data-order-setting="columnOrder">${renderFieldEditor(DEFAULT_SETTINGS, presentation.dictionaries.en)}</div>
      <div class="pv-detail-card pv-live" data-for-layout="rows" aria-hidden="true"><div class="list">
        ${PV_CONTEXT_ITEMS.map(([key, color, value, pct]) => `<div class="item-row"><span class="dot" style="background:${color}"></span><div class="item-body"><span class="item-label" data-i18n="${key}"></span><span class="item-k">${value}</span><span class="item-pct">${pct}</span></div></div>`).join('')}
      </div></div>
    </div>
    <div class="setting-card metric-setting" data-setting-card="showRequestMetrics" data-position="${DEFAULT_SETTINGS.requestPosition}" data-checked="${DEFAULT_SETTINGS.showRequestMetrics}">
      <div class="setting-head setting-pair-head">
        <div class="setting-pair-item"><label class="setting-check"><input id="setting-show-request-metrics" name="showRequestMetrics" type="checkbox"${DEFAULT_SETTINGS.showRequestMetrics ? ' checked' : ''} aria-describedby="help-request-metrics" /><span data-i18n="showRequestMetrics"></span></label></div>
        <div class="setting-opts">${renderSeg('requestPosition', REQUEST_POS_OPTIONS, 'setting-seg-text')}</div>
        <span class="setting-help-dot" aria-hidden="true">?</span>
      </div>
      <div class="setting-preview" aria-hidden="true">${PV_CARD_PREVIEW.showRequestMetrics}</div>
      <div class="metric-help" id="help-request-metrics" role="tooltip" data-i18n="requestSectionTip"></div>
    </div>
    <div class="setting-card setting-option-card metric-setting" data-setting-card="showTurnMetrics" data-layout-key="turnLayout" data-checked="${DEFAULT_SETTINGS.showTurnMetrics}" data-layout="columns">
      <div class="setting-head setting-pair-head">
        <div class="setting-pair-item"><label class="setting-check"><input id="setting-show-turn-metrics" name="showTurnMetrics" type="checkbox"${DEFAULT_SETTINGS.showTurnMetrics ? ' checked' : ''} aria-describedby="help-turn-metrics" /><span data-i18n="showTurnMetrics"></span></label></div>
        <div class="setting-opts">${renderSeg('turnLayout', LAYOUT_OPTIONS)}<span class="setting-opts-extra" data-for-layout="rows">${renderSeg('turnMarker', MARKER_OPTIONS)}</span></div>
        <span class="setting-help-dot" aria-hidden="true">?</span>
      </div>
      <div class="metric-help" id="help-turn-metrics" role="tooltip" data-i18n="turnSectionTip"></div>
    </div>
    <div class="pv-detail-pop" data-preview-group="turn" data-open="${DEFAULT_SETTINGS.showTurnMetrics}" aria-hidden="true">
      <div class="pv-detail-card pv-live"><div class="turn-bar-list">
        ${PV_TURN_ITEMS.map(([key, labelKey, value]) => `<div class="turn-bar-item" data-turn-row="${key}"><span class="turn-bar-line"></span><span class="turn-bar-label" data-i18n="${labelKey}"></span>${key === 'requests' ? '<span class="turn-bar-short" data-i18n="turnReqsShort" aria-hidden="true">Re</span>' : ''}<span class="turn-bar-val">${value}</span></div>`).join('')}
      </div></div>
    </div>
  </section>

  </main>
  <script>
    ${getPresentationScript()}
    const presentation = globalThis.__agyCapsulePresentation;
    ${renderFieldEditor.toString()}
    let prefs = ${JSON.stringify(DEFAULT_SETTINGS)};
    let prefsJson = JSON.stringify(prefs);
    let labels = presentation.apply(document.body, prefs);
    let settingsLabels = presentation.dictionaries[prefs.settingsLanguage];
    let savingSettings = false;
    let settingsEpoch = 0;
    let lastData = null;
    let lastQuotaHtml = '';
    const sidebarTabs = document.querySelector('.sidebar-tabs');
    const panelEl = document.querySelector('.panel');
    const statsCtxEl = document.querySelector('.stats-context');
    let sidebarView = 'stats';
    const sidebarScroll = { stats: 0, settings: 0 };
    function selectSidebarView(view, focus = false) {
      if (view !== sidebarView) {
        sidebarScroll[sidebarView] = window.scrollY;
        sidebarView = view;
        sidebarTabs.dataset.view = view;
        for (const name of ['stats', 'settings']) {
          const selected = name === view;
          const tab = document.getElementById('sidebar-tab-' + name);
          tab.setAttribute('aria-selected', String(selected));
          tab.tabIndex = selected ? 0 : -1;
          document.getElementById('sidebar-' + name).hidden = !selected;
        }
        renderCdpNotice();
        window.scrollTo({ top: sidebarScroll[view], behavior: 'instant' });
        if (view === 'stats' && lastData) renderData(lastData);
      }
      if (focus) document.getElementById('sidebar-tab-' + view).focus({ preventScroll: true });
    }
    for (const view of ['stats', 'settings']) {
      document.getElementById('sidebar-tab-' + view).addEventListener('click', () => selectSidebarView(view));
    }
    sidebarTabs.querySelector('.sidebar-toggle-track').addEventListener('click', () => selectSidebarView(sidebarView === 'stats' ? 'settings' : 'stats', true));
    sidebarTabs.addEventListener('keydown', event => {
      if (!['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) return;
      event.preventDefault();
      const view = event.key === 'Home' ? 'stats' : event.key === 'End' ? 'settings' : sidebarView === 'stats' ? 'settings' : 'stats';
      selectSidebarView(view, true);
    });
    document.getElementById('row-cached').addEventListener('mouseenter', () => {
      if (lastData) document.getElementById('row-cached').title = presentation.cacheTooltip(lastData, labels, Date.now(), prefs);
    });
    if (statsCtxEl) {
      statsCtxEl.dataset.speedMode = statsCtxEl.dataset.speedMode || 'total';
      for (const el of statsCtxEl.querySelectorAll('.seg[data-cat], .item-row[data-cat]')) {
        const cat = el.dataset.cat;
        el.addEventListener('mouseenter', () => { statsCtxEl.dataset.hoverCat = cat; });
        el.addEventListener('mouseleave', () => { if (statsCtxEl.dataset.hoverCat === cat) delete statsCtxEl.dataset.hoverCat; });
      }
      const sbSpeedToggle = document.getElementById('sb-speed-toggle');
      if (sbSpeedToggle) {
        sbSpeedToggle.addEventListener('click', () => {
          statsCtxEl.dataset.speedMode = statsCtxEl.dataset.speedMode === 'stream' ? 'total' : 'stream';
          presentation.renderGeneration(statsCtxEl, lastData?.generation, labels, prefs);
        });
      }
    }
    for (const setting of document.querySelectorAll('.metric-setting')) {
      const resetHelp = () => {
        for (const other of document.querySelectorAll('.metric-setting')) other.dataset.helpDismissed = 'true';
        const help = setting.querySelector('.metric-help');
        if (help) {
          const roomAbove = setting.getBoundingClientRect().top - document.querySelector('.sidebar-nav').getBoundingClientRect().bottom;
          const below = roomAbove < help.getBoundingClientRect().height + 8;
          help.style.top = below ? 'calc(100% + 5px)' : 'auto';
          help.style.bottom = below ? 'auto' : 'calc(100% + 5px)';
        }
        setting.removeAttribute('data-help-dismissed');
      };
      setting.addEventListener('mouseenter', resetHelp);
      setting.addEventListener('focusin', resetHelp);
    }
    document.addEventListener('keydown', event => {
      if (event.key === 'Escape') for (const setting of document.querySelectorAll('.metric-setting')) setting.dataset.helpDismissed = 'true';
    });
    function applySettings(next) {
      prefs = { ...prefs, ...next };
      prefsJson = JSON.stringify(prefs);
      labels = presentation.apply(document.body, prefs);
      const effectiveSettingsLang = prefs.settingsLanguage || 'zh-CN';
      settingsLabels = presentation.dictionaries[effectiveSettingsLang] || presentation.dictionaries['zh-CN'];
      sidebarTabs.lang = effectiveSettingsLang;
      sidebarTabs.setAttribute('aria-label', settingsLabels.sidebarNavigation);
      document.getElementById('sidebar-tab-stats').textContent = settingsLabels.sidebarStats;
      document.getElementById('sidebar-tab-settings').textContent = settingsLabels.sidebarSettings;
      document.getElementById('sidebar-stats').lang = document.body.dataset.language;
      for (const select of document.querySelectorAll('.settings select[name]')) select.value = prefs[select.name];
      for (const checkbox of document.querySelectorAll('.settings input[type="checkbox"]')) {
        const checked = prefs[checkbox.name] === true;
        checkbox.checked = checked;
        const card = checkbox.closest('[data-setting-card]');
        if (card) card.dataset.checked = String(checked);
      }
      const speedCard = document.querySelector('[data-setting-card="showSpeed"]');
      if (speedCard) speedCard.dataset.speedFx = String(prefs.showSpeed !== false && prefs.speedAnimation === true);
      const speedAnimCard = document.querySelector('[data-setting-card="speedAnimation"]');
      if (speedAnimCard) speedAnimCard.dataset.parentOff = String(prefs.showSpeed === false);
      for (const card of document.querySelectorAll('.setting-option-card')) {
        if (card.dataset.layoutKey) card.dataset.layout = prefs[card.dataset.layoutKey] === 'rows' ? 'rows' : 'columns';
      }
      const requestCard = document.querySelector('[data-setting-card="showRequestMetrics"]');
      if (requestCard) requestCard.dataset.position = prefs.requestPosition === 'top' ? 'top' : 'bottom';
      const contextPreview = document.querySelector('[data-preview-group="context"]');
      if (contextPreview) {
        contextPreview.dataset.open = String(prefs.showContextBreakdown !== false);
        contextPreview.dataset.layout = prefs.contextLayout === 'rows' ? 'rows' : 'columns';
      }
      renderFields();
      const turnPreview = document.querySelector('[data-preview-group="turn"]');
      if (turnPreview) turnPreview.dataset.open = String(prefs.showTurnMetrics !== false);
      updateControlState();
      for (const swatch of document.querySelectorAll('[data-pick-setting]')) {
        const active = String(prefs[swatch.dataset.pickSetting] === swatch.dataset.pickValue);
        swatch.dataset.active = active;
        swatch.setAttribute('aria-pressed', active);
        const label = settingsLabels[swatch.dataset.pickLabel] || ({ en: 'English', 'zh-CN': '简体中文', 'zh-TW': '繁體中文' })[swatch.dataset.pickValue] || swatch.dataset.pickValue;
        const name = settingsLabels[swatch.dataset.pickSetting] + ': ' + label;
        swatch.setAttribute('aria-label', name);
        swatch.removeAttribute('title');
      }
      if (lastData && sidebarView === 'stats') renderData(lastData);
      else if (lastData) renderCdpNotice();
    }
    const fieldEditor = document.querySelector('[data-field-editor]');
    const FIELD_KEYS = { label: 'columnLabel', value: 'columnValue', percent: 'columnPercent' };
    var fieldHtml = '';
    let draggedField = '';
    function renderFields() {
      const editor = document.querySelector('[data-field-editor]');
      if (!editor) return;
      const html = renderFieldEditor(prefs, settingsLabels);
      if (html === fieldHtml) return;
      // FLIP: animate rows from their old position so a moved row stays traceable.
      const before = new Map([...editor.children].map(row => [row.dataset.field, row.getBoundingClientRect().top]));
      fieldHtml = html;
      editor.innerHTML = html;
      for (const row of editor.children) {
        const delta = (before.get(row.dataset.field) ?? row.getBoundingClientRect().top) - row.getBoundingClientRect().top;
        if (!delta) continue;
        row.animate([{ transform: 'translateY(' + delta + 'px)' }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(.22,1,.36,1)' });
      }
    }
    function fieldOrder() {
      return String(prefs.columnOrder || 'label,value,percent').split(',');
    }
    function visibleOrder(order) {
      return order.filter(field => prefs[FIELD_KEYS[field]] === true);
    }
    applySettings(prefs);
    function apiOptions(path) {
      const params = new URLSearchParams(window.location.search);
      const token = params.get('token') || window.sidecar?.token || '';
      const query = new URLSearchParams();
      if (token) query.set('token', token);
      return { url: path + (query.size ? '?' + query : ''), headers: token ? { 'X-Sidecar-Token': token } : {} };
    }
    async function saveSettings(patch) {
      if (savingSettings) return;
      const previous = { ...prefs };
      savingSettings = true;
      settingsEpoch++;
      applySettings(patch);
      updateControlState();
      try {
        const api = apiOptions('/api/settings');
        const res = await fetch(api.url, { method: 'POST', headers: { ...api.headers, 'Content-Type': 'application/json' }, body: JSON.stringify(patch) });
        const data = await res.json();
        if (!res.ok || data.error) throw new Error('Save failed');
        applySettings(data);
      } catch {
        applySettings(previous);
        window.alert(settingsLabels.saveFailed);
      } finally {
        settingsEpoch++;
        savingSettings = false;
        updateControlState();
      }
    }
    for (const select of document.querySelectorAll('.settings select[name], .settings input[name]')) {
      select.addEventListener('change', () => {
        const value = select.type === 'checkbox' ? select.checked : select.value;
        const patch = { [select.name]: value };
        if (select.name === 'showSpeed' && !value) patch.speedAnimation = false;
        void saveSettings(patch);
      });
    }
    if (fieldEditor) {
      fieldEditor.addEventListener('click', event => {
        const toggle = event.target.closest('.pv-field-toggle');
        if (!toggle) return;
        const field = toggle.closest('.pv-field-row').dataset.field;
        const turnOn = prefs[FIELD_KEYS[field]] !== true;
        const order = fieldOrder().filter(f => f !== field);
        // Hidden lines drop to the end; a re-enabled line joins the end of the visible ones.
        order.splice(turnOn ? visibleOrder(order).length : order.length, 0, field);
        void saveSettings({ [FIELD_KEYS[field]]: turnOn, columnOrder: order.join(',') });
      });
      fieldEditor.addEventListener('dragstart', event => {
        const row = event.target.closest('.pv-field-row[draggable="true"]');
        if (!row) return;
        draggedField = row.dataset.field;
        row.dataset.dragging = 'true';
        event.dataTransfer.effectAllowed = 'move';
        event.dataTransfer.setData('text/plain', draggedField);
      });
      const clearDrop = () => { for (const row of fieldEditor.children) { delete row.dataset.drop; delete row.dataset.dragging; } };
      const dropTarget = event => {
        const row = event.target.closest('.pv-field-row[data-on="true"]');
        if (!row || !draggedField || row.dataset.field === draggedField) return null;
        const rect = row.getBoundingClientRect();
        return { row, place: event.clientY < rect.top + rect.height / 2 ? 'before' : 'after' };
      };
      fieldEditor.addEventListener('dragover', event => {
        const target = dropTarget(event);
        for (const row of fieldEditor.children) if (row !== target?.row) delete row.dataset.drop;
        if (!target) return;
        event.preventDefault();
        target.row.dataset.drop = target.place;
      });
      fieldEditor.addEventListener('dragend', () => { clearDrop(); draggedField = ''; });
      fieldEditor.addEventListener('drop', event => {
        const target = dropTarget(event);
        clearDrop();
        if (!target) return;
        event.preventDefault();
        const order = fieldOrder().filter(f => f !== draggedField);
        order.splice(order.indexOf(target.row.dataset.field) + (target.place === 'after' ? 1 : 0), 0, draggedField);
        draggedField = '';
        void saveSettings({ columnOrder: order.join(',') });
      });
    }
    for (const swatch of document.querySelectorAll('[data-pick-setting]')) {
      swatch.addEventListener('click', () => {
        const key = swatch.dataset.pickSetting;
        const value = swatch.dataset.pickValue;
        if (prefs[key] !== value) void saveSettings({ [key]: value });
      });
    }

    function renderQuota(groups, activeModelText = '') {
      const root = document.getElementById('quota-root');
      if (!Array.isArray(groups) || groups.length === 0) {
        if (lastQuotaHtml !== '' || root.childElementCount > 0) {
          root.replaceChildren();
          lastQuotaHtml = '';
        }
        return;
      }
      let html = '';
      const windowOrder = { '5h': 0, weekly: 1 };
      const isBar = presentation.appearance(prefs).quotaIndicator === 'bar';
      const hasActiveModel = Boolean(activeModelText && String(activeModelText).trim());
      for (const g of groups) {
        const title = presentation.formatGroupTitle(g.displayName);
        const activeColor = presentation.activeGroupColor(g.buckets, 'var(--agc-muted)');
        const activeAttr = hasActiveModel ? ' data-active="' + String(presentation.matchActiveGroup(activeModelText, g)) + '"' : '';
        html += '<div class="quota-group"' + activeAttr + '>';
        html += '<div class="quota-title-row"><span class="quota-group-title">' + presentation.escapeHtml(title) + '</span><span class="quota-active"><span class="quota-active-dot" style="background:' + activeColor + '"></span><span>' + presentation.escapeHtml(labels.active) + '</span></span></div>';
        const buckets = [...(g.buckets || [])].sort(
          (a, b) => (windowOrder[a.window] ?? 2) - (windowOrder[b.window] ?? 2)
        );
        for (const b of buckets) {
          const baseLabel = presentation.formatBucketLabel(b, labels);
          const resetShort = presentation.formatReset(b.resetTime, prefs);
          const pctLeft = Math.round((b.remainingFraction || 0) * 100);
          const rowTone = pctLeft <= 10 ? ' data-tone="danger"' : pctLeft <= 25 ? ' data-tone="warn"' : '';
          html += '<div class="quota-bucket"' + rowTone + '>';
          html += '  <div class="quota-line1" data-quota-tooltip="' + presentation.escapeHtml(JSON.stringify({ pool: title, window: b.window, displayName: b.displayName, remainingFraction: b.remainingFraction, resetTime: b.resetTime })) + '">';
          const color = presentation.quotaColor(pctLeft / 100);
          const indicator = isBar
            ? '<span class="quota-meter"><span style="width:' + Math.max(0, Math.min(100, pctLeft)) + '%;background:' + color + '"></span></span>'
            : presentation.makeRingSvg(b.remainingFraction, 18);
          html += '    <span class="quota-label">' + presentation.escapeHtml(baseLabel) + '</span>';
          html += '    <span class="quota-right">' + indicator + '<span class="quota-pct notranslate" translate="no">' + pctLeft + '%</span></span>';
          html += '    <span class="quota-mid notranslate" translate="no">' + presentation.escapeHtml(resetShort) + '</span>';
          html += '  </div>';
          html += '</div>';
        }
        html += '</div>';
      }
      if (html !== lastQuotaHtml) {
        lastQuotaHtml = html;
        root.innerHTML = html;
        presentation.applyQuotaTooltips(root, labels);
      }
    }

    const setText = (id, val) => { const el = document.getElementById(id); if (el && el.textContent !== val) el.textContent = val; };
    const setWidth = (id, val) => { const el = document.getElementById(id); if (el && el.style.width !== val) el.style.width = val; };
    const setZero = (id, zero) => { const el = document.getElementById(id); const v = String(zero); if (el && el.dataset.zero !== v) el.dataset.zero = v; };

    async function refresh() {
      const requestedSettingsEpoch = settingsEpoch;
      try {
        const urlParams = new URLSearchParams(window.location.search);
        const token = urlParams.get('token') || '';
        const convId = window.sidecar?.conversationId || urlParams.get('conversationId') || '';
        const qs = new URLSearchParams();
        if (convId) qs.set('conversationId', convId);
        if (token) qs.set('token', token);
        const qStr = qs.toString() ? '?' + qs.toString() : '';
        const headers = token ? { 'X-Sidecar-Token': token } : {};
        const res = await fetch('/api/context' + qStr, { method: 'GET', headers });
        const d = await res.json();
        if (d.error) return;
        if (d.uiVersion && d.uiVersion !== 102) {
          window.location.reload();
          return;
        }
        lastData = d;
        if (!savingSettings && requestedSettingsEpoch === settingsEpoch && d.prefs) {
          if (JSON.stringify({ ...prefs, ...d.prefs }) !== prefsJson) applySettings(d.prefs);
          else if (sidebarView === 'stats') renderData(d);
          else renderCdpNotice();
        } else if (sidebarView === 'stats') {
          renderData(d);
        } else {
          renderCdpNotice();
        }
      } catch (e) {
        console.error(e);
      }
    }

    function renderData(d) {
      presentation.renderContextTooltips(panelEl, d, labels);
      presentation.renderAlerts(document.body, d, prefs, labels);
      if (statsCtxEl) presentation.renderGeneration(statsCtxEl, d.generation, labels, prefs);
      presentation.renderTurnMetrics(panelEl, d.turnMetrics, labels, prefs);

      const bd = presentation.contextBreakdown(d);
      setText('used-pct', bd.pillCtx);
      setText('used-fraction', bd.usedFrac);
      setWidth('seg-read', bd.segReadW);
      setWidth('seg-out', bd.segOutW);
      setWidth('seg-think', bd.segThinkW);
      setWidth('seg-turn0', bd.segTurn0W);

      const cache = presentation.cacheView(d, prefs);
      const rowCachedEl = document.getElementById('row-cached');
      const valCacheHitEl = document.getElementById('val-cache-hit');
      const valCacheHitKEl = document.getElementById('val-cache-hit-k');
      const sbCacheRing = document.getElementById('sb-cache-ring');
      const sbCacheArc = document.getElementById('sb-cache-arc');
      const cacheStatus = cache.status || 'fresh';
      if (rowCachedEl && rowCachedEl.dataset.cacheStatus !== cacheStatus) rowCachedEl.dataset.cacheStatus = cacheStatus;
      presentation.renderCacheRing(sbCacheRing, sbCacheArc, cache.status, cache.hitPct);
      if (valCacheHitEl) {
        if (valCacheHitEl.style.color) valCacheHitEl.style.color = '';
        if (valCacheHitEl.style.textDecoration !== cache.valDeco) valCacheHitEl.style.textDecoration = cache.valDeco;
        if (valCacheHitEl.style.opacity !== cache.valOp) valCacheHitEl.style.opacity = cache.valOp;
        if (valCacheHitEl.textContent !== cache.text) valCacheHitEl.textContent = cache.text;
      }
      if (valCacheHitKEl) {
        const cacheSubText = cache.status === 'cold' ? (labels.cacheExpiredTag || 'expired') : (cache.countdown || cache.age || '');
        if (valCacheHitKEl.style.color) valCacheHitKEl.style.color = '';
        if (valCacheHitKEl.textContent !== cacheSubText) valCacheHitKEl.textContent = cacheSubText;
      }
      if (rowCachedEl) {
        const nextTip = presentation.cacheTooltip(d, labels, Date.now(), prefs);
        if (rowCachedEl.title !== nextTip) rowCachedEl.title = nextTip;
      }

      setZero('row-turn0', bd.turn0 === 0);
      setZero('row-read', bd.read === 0);
      setZero('row-think', bd.think === 0);
      setZero('row-out', bd.out === 0);

      setText('val-turn0-k', bd.turn0K);
      setText('val-read-k', bd.readK);
      setText('val-think-k', bd.thinkK);
      setText('val-out-k', bd.outK);
      setText('val-turn0-pct', bd.turn0Pct);
      setText('val-read-pct', bd.readPct);
      setText('val-think-pct', bd.thinkPct);
      setText('val-out-pct', bd.outPct);

      renderQuota(d.quotaGroups, d.activeModelText);
      renderCdpNotice();
    }

    // Shown on both tabs; text follows the open tab's language.
    function renderCdpNotice() {
      const notice = document.getElementById('cdp-notice');
      notice.hidden = !['missing', 'unreachable'].includes(lastData?.deckCdp);
      if (notice.hidden) return;
      const dict = sidebarView === 'settings' ? settingsLabels : labels;
      notice.lang = sidebarView === 'settings' ? prefs.settingsLanguage : document.body.dataset.language;
      for (const node of notice.querySelectorAll('[data-cdp-i18n]')) {
        const value = dict?.[node.dataset.cdpI18n];
        if (value && node.textContent !== value) node.textContent = value;
      }
    }

    function updateControlState() {
      const busy = savingSettings;
      for (const control of document.querySelectorAll('.settings select, .settings input, .settings button:not(.setting-help-dot)')) {
        const optionCard = control.closest('.setting-option-card');
        const detailPop = control.closest('.pv-detail-pop');
        const parentDisabled = (control.name === 'speedAnimation' && prefs.showSpeed === false)
          || (!!optionCard && !control.closest('.setting-pair-item') && optionCard.dataset.checked === 'false')
          || (!!detailPop && detailPop.dataset.open === 'false');
        control.disabled = busy || parentDisabled;
      }
    }
    refresh();
    setInterval(refresh, 1000);
  </script>
</body>
</html>`;

export { inspectConversation, UI_HTML, parseGenRow, readConversationSnapshot };

const isMain = (() => {
  try {
    return Boolean(process.argv[1]) && realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
})();

if (isMain) installEpipeGuard();
let deckInjector = null;
if (isMain && process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
  const { SidecarApp } = await import('sidecar_sdk');
  const app = new SidecarApp();
  app.page('/', () => UI_HTML);
  app.page('/ui.html', () => UI_HTML);
  app.api('/api/context', async (data) => ({
    ...await inspectConversation(data?.conversationId || app.config.conversationId),
    deckCdp: deckInjector?.status?.() ?? 'unknown',
  }), 'GET');
  app.api('/api/settings', () => settingsStore.read(), 'GET');
  app.api('/api/settings', (data) => settingsStore.update(data), 'POST');
  app.run();
  installAsyncHostRoutes(app);
}
if (isMain && (process.env.ANTIGRAVITY_LS_ADDRESS || process.env.ANTIGRAVITY_SIDECAR_WEB_PORT)) {
  const injector = deckInjector = startDeckInjector(inspectConversation);
  let stopping = false;
  const shutdown = async (reason) => {
    if (stopping) return;
    stopping = true;
    stopWatching();
    console.log('[agy-capsule] restarting/stopping:', reason);
    try { await injector.stop(); }
    finally { process.exit(0); }
  };
  const stopWatching = startSelfReloadWatcher(dirname(fileURLToPath(import.meta.url)), () => void shutdown('plugin files changed'));
  for (const signal of ['SIGTERM', 'SIGINT']) process.once(signal, () => void shutdown(signal));
}
