/**
 * Stat-gated SQLite + Language Server RPC telemetry service for agy-capsule.
 *
 * Tier 1: File-stat-gated read-only SQLite (`gen_metadata` + `steps`) + latest generator
 *         metadata RPC (`tps`, `streamingTps`, `ttft`, `duration`, `model`, errors).
 * Tier 2: Cached `RetrieveUserQuotaSummary` (10s TTL, invalidated immediately on new turn).
 * Tier 3: Asynchronous debounced/on-demand 7-category full trajectory & attachment breakdown.
 */
import { DatabaseSync } from 'node:sqlite';
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { basename, dirname, extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  calcImageTokens,
  core,
  findCompactionEpochStart,
  getImageDimensions,
  parseGenMetadataRow,
  parseStepTimestampMs,
} from './core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const UUID_RE = /^[0-9a-f-]{36}$/i;
const QUOTA_TTL_MS = 10_000;
const MODEL_CONFIGS_TTL_MS = 30_000;
const TIER3_DEBOUNCE_MS = 550;
const ACTIVE_RPC_INTERVAL_MS = 1_500;
const IN_FLIGHT_SETTLE_MS = 2_500;
const MAX_IN_FLIGHT_WAIT_MS = 180_000;
const DEFAULT_MAX_CONTEXT = 256_000;

const TEXT_EXTENSIONS = new Set([
  '.txt', '.md', '.markdown', '.json', '.jsonl', '.csv', '.tsv',
  '.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.py', '.rb', '.go', '.rs',
  '.java', '.kt', '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.swift',
  '.html', '.htm', '.css', '.scss', '.xml', '.svg', '.yaml', '.yml',
  '.toml', '.ini', '.conf', '.env', '.sql', '.sh', '.bash', '.ps1', '.bat', '.log',
]);
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.gif', '.bmp', '.webp']);

const UI_PREF_VALIDATORS = {
  langMode: (v) => v === 'auto' || v === 'en' || v === 'zh-CN' || v === 'zh-TW',
  themeMode: (v) => v === 'auto' || v === 'light' || v === 'dark',
};

function resolveAppDataRoot() {
  const exeDataDir = process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  if (exeDataDir) {
    for (let d = exeDataDir; d !== dirname(d); d = dirname(d)) {
      if (basename(d) === 'sidecar_data') {
        return dirname(d);
      }
    }
  }
  const home = homedir();
  for (const product of ['antigravity', 'antigravity-ide', 'antigravity-cli']) {
    const candidate = join(home, '.gemini', product);
    if (existsSync(join(candidate, 'conversations'))) {
      return candidate;
    }
  }
  return join(home, '.gemini', 'antigravity');
}

function resolveDefaultStateDir() {
  if (process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR) {
    return process.env.ANTIGRAVITY_EXECUTABLE_DATA_DIR;
  }
  const home = homedir();
  const base =
    process.platform === 'win32'
      ? process.env.LOCALAPPDATA || join(home, 'AppData', 'Local')
      : process.platform === 'darwin'
        ? join(home, 'Library', 'Application Support')
        : process.env.XDG_STATE_HOME || join(home, '.local', 'state');
  return join(base, 'agy-capsule');
}

function safeStat(filePath) {
  try {
    const s = statSync(filePath);
    return { exists: true, mtimeMs: s.mtimeMs, size: s.size };
  } catch {
    return { exists: false, mtimeMs: 0, size: -1 };
  }
}

export function createTelemetryService(options = {}) {
  const appDataRoot = options.appDataRoot || resolveAppDataRoot();
  const convDir = options.convDir || join(appDataRoot, 'conversations');
  const stateDir = options.stateDir || resolveDefaultStateDir();
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const nowFn = options.nowFn || (() => Date.now());
  const onLsDead = typeof options.onLsDead === 'function' ? options.onLsDead : null;

  const getLsAddress = () => options.lsAddress ?? process.env.ANTIGRAVITY_LS_ADDRESS ?? '';
  const getCsrfToken = () => options.csrfToken ?? process.env.ANTIGRAVITY_CSRF_TOKEN ?? '';

  const prefsPath = join(stateDir, 'ui-prefs.json');
  let prefsCache = null;
  let prefsEpoch = 1;

  function sanitizePrefs(raw) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const out = {};
    for (const [k, check] of Object.entries(UI_PREF_VALIDATORS)) {
      if (check(raw[k])) out[k] = raw[k];
    }
    return out;
  }

  function readPrefs() {
    if (prefsCache) return prefsCache;
    try {
      if (existsSync(prefsPath)) {
        prefsCache = sanitizePrefs(JSON.parse(readFileSync(prefsPath, 'utf8')));
        return prefsCache;
      }
    } catch {}
    prefsCache = {};
    return prefsCache;
  }

  function applyPrefsPatch(patch) {
    const updates = sanitizePrefs(patch);
    if (Object.keys(updates).length === 0) return readPrefs();
    const merged = { ...readPrefs(), ...updates };
    prefsCache = merged;
    prefsEpoch++;
    try {
      mkdirSync(dirname(prefsPath), { recursive: true });
      const payload = JSON.stringify(merged, null, 2);
      const tmp = `${prefsPath}.${process.pid}.tmp`;
      try {
        writeFileSync(tmp, payload, 'utf8');
        renameSync(tmp, prefsPath);
      } catch {
        try {
          rmSync(tmp, { force: true });
        } catch {}
        writeFileSync(prefsPath, payload, 'utf8');
      }
    } catch {}
    return merged;
  }

  // Connection & quota caches
  let lsConnFailures = 0;
  let quotaCache = null; // { groups, fetchedAt, epoch, hash }
  let quotaEpoch = 0;
  let lastQuotaHash = '';
  let quotaInFlight = null;
  let modelConfigsCache = null; // { configs, fetchedAt }

  async function callLsRpc(method, body = {}) {
    const lsAddr = getLsAddress();
    const csrf = getCsrfToken();
    if (!lsAddr || !csrf || typeof fetchImpl !== 'function') return null;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetchImpl(
        `http://${lsAddr}/exa.language_server_pb.LanguageServerService/${method}`,
        {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Connect-Protocol-Version': '1',
            'x-codeium-csrf-token': csrf,
          },
          body: JSON.stringify(body),
          signal: controller.signal,
        }
      );
      lsConnFailures = 0;
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      if (err?.name !== 'AbortError') {
        lsConnFailures++;
        if (lsConnFailures >= 5 && onLsDead) {
          onLsDead();
        }
      }
      return null;
    } finally {
      clearTimeout(timer);
    }
  }

  async function getQuotaGroups(forceRefresh = false) {
    const now = nowFn();
    if (!forceRefresh && quotaCache && now - quotaCache.fetchedAt < QUOTA_TTL_MS) {
      return quotaCache;
    }
    if (quotaInFlight) return quotaInFlight;
    quotaInFlight = (async () => {
      const data = await callLsRpc('RetrieveUserQuotaSummary', {});
      if (data) {
        const rawGroups = data?.response?.groups || data?.groups || [];
        const groups = core.normalizeQuotaGroups(rawGroups);
        const nextHash = JSON.stringify(groups);
        if (nextHash !== lastQuotaHash) {
          lastQuotaHash = nextHash;
          quotaEpoch++;
        }
        quotaCache = { groups, fetchedAt: nowFn(), epoch: quotaEpoch };
        return quotaCache;
      }
      return quotaCache || { groups: [], fetchedAt: 0, epoch: quotaEpoch };
    })();
    try {
      return await quotaInFlight;
    } finally {
      quotaInFlight = null;
    }
  }

  async function getCascadeModelConfigs() {
    const now = nowFn();
    if (modelConfigsCache && now - modelConfigsCache.fetchedAt < MODEL_CONFIGS_TTL_MS) {
      return modelConfigsCache.configs;
    }
    const res = await callLsRpc('GetUserStatus', {});
    const configs = res?.userStatus?.cascadeModelConfigData?.clientModelConfigs || [];
    if (res) {
      modelConfigsCache = { configs, fetchedAt: now };
    }
    return modelConfigsCache?.configs || [];
  }

  // Attachment scanning caches
  const filesCache = new Map();
  let cachedPython = undefined;
  let pythonQueue = Promise.resolve();

  function resolvePython() {
    if (cachedPython !== undefined) return cachedPython;
    const home = homedir();
    const candidates = [];
    if (process.env.AGY_CAPSULE_PYTHON) candidates.push(process.env.AGY_CAPSULE_PYTHON);
    if (process.platform === 'win32') {
      const localPrograms = join(process.env.LOCALAPPDATA || join(home, 'AppData', 'Local'), 'Programs', 'Python');
      if (existsSync(localPrograms)) {
        try {
          for (const dir of readdirSync(localPrograms).sort().reverse()) {
            candidates.push(join(localPrograms, dir, 'python.exe'));
          }
        } catch {}
      }
    }
    for (const p of candidates) {
      try {
        if (p && existsSync(p) && statSync(p).size > 0) {
          cachedPython = p;
          return cachedPython;
        }
      } catch {}
    }
    for (const cmd of process.platform === 'win32' ? ['python', 'python3', 'py'] : ['python3', 'python']) {
      try {
        const check = spawnSync(cmd, ['-c', 'import sys; print(sys.executable)'], {
          encoding: 'utf8',
          timeout: 2500,
          windowsHide: true,
        });
        if (check.status === 0 && check.stdout.trim()) {
          cachedPython = check.stdout.trim().split(/\r?\n/)[0];
          return cachedPython;
        }
      } catch {}
    }
    cachedPython = null;
    return null;
  }

  function runPythonScan(items, lang) {
    return new Promise((resolve, reject) => {
      const py = resolvePython();
      if (!py) return reject(new Error('Python not installed'));
      const source = readFileSync(join(__dirname, 'attachment_scan.py'), 'utf8');
      const child = spawn(py, ['-I', '-c', source, '--json-lines'], {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, AGY_CAPSULE_LANG: lang || 'en' },
      });
      let output = '';
      let errors = '';
      let timedOut = false;
      const completed = [];
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill();
      }, 45000);
      child.stdout.on('data', (chunk) => {
        output += chunk;
        let at;
        while ((at = output.indexOf('\n')) >= 0) {
          const line = output.slice(0, at).trim();
          output = output.slice(at + 1);
          if (line) {
            try {
              completed.push(JSON.parse(line));
            } catch {}
          }
        }
      });
      child.stderr.on('data', (chunk) => {
        if (errors.length < 1000) errors += chunk;
      });
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        const reason = timedOut ? 'Scan timed out' : code !== 0 ? errors.slice(0, 120) || 'Parse failed' : 'No result';
        const done = new Set(completed.map((v) => v.key));
        for (const item of items) {
          if (!done.has(item.key)) {
            completed.push({ key: item.key, ...core.emptyMeasure(), status: 'unknown', unknownParts: [reason] });
          }
        }
        resolve(completed);
      });
      child.stdin.on('error', () => {});
      child.stdin.end(JSON.stringify(items));
    });
  }

  function parseNativeAttachment(filePath, stat, mime) {
    const ext = extname(filePath).toLowerCase();
    const mimeLower = String(mime || '').toLowerCase();

    if ((IMAGE_EXTENSIONS.has(ext) || mimeLower.startsWith('image/')) && stat.size <= 32 * 1024 * 1024) {
      const headerLen = Math.min(stat.size, 65536);
      const buf = Buffer.allocUnsafe(headerLen);
      const fd = openSync(filePath, 'r');
      let bytesRead = 0;
      try {
        bytesRead = readSync(fd, buf, 0, headerLen, 0);
      } finally {
        closeSync(fd);
      }
      const dims = getImageDimensions(buf.subarray(0, bytesRead));
      const [low, high] = calcImageTokens(dims.width, dims.height);
      return {
        status: 'parsed',
        width: dims.width,
        height: dims.height,
        chars: 0,
        dimensions: dims.width ? `${dims.width}x${dims.height}` : null,
        bytes: stat.size,
        tokens: low,
        low,
        high,
        unknownParts: [],
      };
    }

    if (
      (TEXT_EXTENSIONS.has(ext) || mimeLower.startsWith('text/') || mimeLower === 'application/json') &&
      stat.size <= 12 * 1024 * 1024
    ) {
      const buf = readFileSync(filePath);
      if (!buf.subarray(0, Math.min(buf.length, 4096)).includes(0)) {
        const m = core.measureText(buf.toString('utf8'));
        return {
          status: 'parsed',
          chars: m.chars,
          bytes: stat.size,
          tokens: m.tokens,
          low: m.low,
          high: m.high,
          unknownParts: [],
        };
      }
    }

    return null;
  }

  async function scanAttachments(media, lang) {
    if (!Array.isArray(media) || media.length === 0) return [];
    const results = new Map();
    const work = [];

    for (const item of media) {
      try {
        if (item.inlineData) {
          const mime = String(item.mime || '').toLowerCase();
          const buf = Buffer.from(item.inlineData, 'base64');
          if (mime.startsWith('image/')) {
            const dims = getImageDimensions(buf);
            const [low, high] = calcImageTokens(dims.width, dims.height);
            results.set(item.uri, {
              status: 'parsed',
              width: dims.width,
              height: dims.height,
              chars: 0,
              dimensions: dims.width ? `${dims.width}x${dims.height}` : null,
              bytes: buf.length,
              tokens: low,
              low,
              high,
              unknownParts: [],
            });
            continue;
          }
          if (mime.startsWith('text/') || mime === 'application/json' || mime === 'text/csv') {
            const m = core.measureText(buf.toString('utf8'));
            results.set(item.uri, { status: 'parsed', ...m, bytes: buf.length, unknownParts: [] });
            continue;
          }
          const est = Math.ceil(buf.length / 4);
          results.set(item.uri, {
            status: 'parsed',
            chars: buf.length,
            bytes: buf.length,
            tokens: est,
            low: Math.ceil(est * 0.9),
            high: Math.ceil(est * 1.1),
            unknownParts: [],
          });
          continue;
        }

        if (!item.uri || /^https?:/i.test(item.uri)) throw new Error('No local attachment');
        const targetPath = item.uri.startsWith('file:') ? fileURLToPath(item.uri) : item.uri;
        if (!existsSync(targetPath)) throw new Error('Attachment missing');
        const target = realpathSync(targetPath);
        const stat = statSync(target);
        if (!stat.isFile()) throw new Error('Not a regular file');
        const cacheKey = `${target.toLowerCase()}|${stat.size}|${stat.mtimeMs}`;

        if (filesCache.has(cacheKey)) {
          results.set(item.uri, filesCache.get(cacheKey));
          continue;
        }

        const nativeParsed = parseNativeAttachment(target, stat, item.mime);
        if (nativeParsed) {
          filesCache.set(cacheKey, nativeParsed);
          results.set(item.uri, nativeParsed);
          continue;
        }

        work.push({ key: item.uri, path: target, cacheKey });
      } catch (e) {
        results.set(item.uri, { ...core.emptyMeasure(), status: 'unknown', unknownParts: [e.message] });
      }
    }

    if (work.length > 0) {
      try {
        const task = pythonQueue.then(() =>
          runPythonScan(
            work.map(({ key, path: p }) => ({ key, path: p })),
            lang
          )
        );
        pythonQueue = task.catch(() => {});
        const parsed = await task;
        for (const r of parsed) {
          const job = work.find((w) => w.key === r.key);
          if (job) {
            filesCache.set(job.cacheKey, r);
            results.set(job.key, r);
          }
        }
      } catch (e) {
        for (const job of work) {
          results.set(job.key, { ...core.emptyMeasure(), status: 'unknown', unknownParts: [e.message] });
        }
      }
    }

    return media.map((item) => {
      const r = results.get(item.uri) || { ...core.emptyMeasure(), status: 'unknown', unknownParts: ['No stats'] };
      const tokens = r.tokens != null ? r.tokens : Math.round(((r.low || 0) + (r.high || 0)) / 2);
      return {
        name: item.name,
        mime: item.mime,
        references: item.references,
        source: item.source,
        status: r.status,
        tokens,
        chars: r.chars || 0,
        bytes: r.bytes || 0,
        dimensions: r.dimensions || null,
        unknownParts: r.unknownParts || [],
      };
    });
  }

  // Per-conversation state & metrics
  const convCache = new Map(); // convId -> { statKey, sqliteInfo, rpcLatest, lastRpcAt, scanKey, scanData, scanBusy, scanSeq, scanTimer, scanPromise }
  const metrics = { sqliteReads: 0, statCacheHits: 0, tier3Scans: 0 };

  function getOrInitConvState(convId) {
    let cs = convCache.get(convId);
    if (!cs) {
      cs = {
        statKey: '',
        sqliteInfo: null,
        rpcLatest: null,
        lastRpcAt: 0,
        scanKey: '',
        scanData: null,
        scanBusy: false,
        scanSeq: 0,
        scanError: '',
        scanTimer: null,
        scanPromise: null,
        initialized: false,
        settledSteps: 0,
        settledTurnsCount: 0,
        lastMutationAt: 0,
        lastRpcSig: '',
        rpcPending: false,
      };
      convCache.set(convId, cs);
    }
    return cs;
  }

  function readSqliteSnapshot(convId) {
    const dbPath = join(convDir, `${convId}.db`);
    const dbStat = safeStat(dbPath);
    if (!dbStat.exists || dbStat.size === 0) {
      return { exists: false, statKey: dbStat.exists ? 'empty' : 'missing' };
    }
    const walStat = safeStat(`${dbPath}-wal`);
    const statKey = `${dbStat.mtimeMs}:${dbStat.size}:${walStat.mtimeMs}:${walStat.size}`;
    const cs = getOrInitConvState(convId);

    if (cs.statKey === statKey && cs.sqliteInfo) {
      metrics.statCacheHits++;
      return { ...cs.sqliteInfo, statChanged: false };
    }

    metrics.sqliteReads++;
    let rawRows = [];
    let cpIndices = [];
    let latestStepIdx = -1;
    let latestStepType = -1;
    let totalSteps = 0;
    let lastStepEpochMs = 0;

    let db = null;
    try {
      db = new DatabaseSync(dbPath, { readOnly: true });
      rawRows = db.prepare('SELECT idx, data FROM gen_metadata ORDER BY idx ASC').all();
      cpIndices = db
        .prepare('SELECT idx FROM steps WHERE step_type = 23 ORDER BY idx DESC')
        .all()
        .map((r) => Number(r.idx));
      const countRow = db.prepare('SELECT COUNT(*) AS cnt, MAX(idx) AS maxIdx FROM steps').get();
      totalSteps = Number(countRow?.cnt || 0);
      latestStepIdx = countRow?.maxIdx != null ? Number(countRow.maxIdx) : -1;
      const stepRow = db.prepare('SELECT step_type, metadata FROM steps ORDER BY idx DESC LIMIT 1').get();
      if (stepRow?.step_type != null) {
        latestStepType = Number(stepRow.step_type);
      }
      if (stepRow?.metadata) {
        lastStepEpochMs = parseStepTimestampMs(stepRow.metadata);
      }
    } catch {
      if (cs.sqliteInfo) {
        return { ...cs.sqliteInfo, statChanged: false };
      }
      return { exists: false, statKey: 'unready' };
    } finally {
      try {
        db?.close();
      } catch {}
    }

    const maxFileMtimeMs = Math.max(dbStat.mtimeMs || 0, walStat.mtimeMs || 0);
    if (!lastStepEpochMs && maxFileMtimeMs > 0) {
      lastStepEpochMs = maxFileMtimeMs;
    }
    const rawLastStepMs = lastStepEpochMs || maxFileMtimeMs;

    const turns = [];
    let maxContextTokens = DEFAULT_MAX_CONTEXT;
    for (const row of rawRows) {
      const parsed = parseGenMetadataRow(row.idx, row.data);
      if (!parsed || parsed.inputTokens === 0) continue;
      if (parsed.maxContextTokens > 0) {
        maxContextTokens = parsed.maxContextTokens;
      }
      turns.push(parsed);
    }

    const epochStart = findCompactionEpochStart(turns, cpIndices);
    const latestTurn = turns.length > 0 ? turns[turns.length - 1] : null;
    if (!latestTurn) {
      lastStepEpochMs = 0;
    }

    if (cs.sqliteInfo && rawRows.length > cs.sqliteInfo.genRowCount) {
      // Invalidate quota cache right after a new billed turn completes
      if (quotaCache) quotaCache.fetchedAt = 0;
    }

    const info = {
      exists: true,
      statKey,
      genRowCount: rawRows.length,
      turnsCount: turns.length,
      epochStart,
      compacted: epochStart > 0 || cpIndices.length > 0,
      latestTurn,
      maxContextTokens,
      totalSteps,
      latestStepIdx,
      latestStepType,
      lastStepEpochMs,
      rawLastStepMs,
    };
    cs.statKey = statKey;
    cs.sqliteInfo = info;
    return { ...info, statChanged: true };
  }

  async function refreshTailGeneratorRpc(convId, sqliteInfo, lang, force = false) {
    const cs = getOrInitConvState(convId);
    const now = nowFn();

    if (!sqliteInfo.exists || sqliteInfo.totalSteps === 0) {
      cs.initialized = false;
      cs.rpcPending = false;
      return { latest: cs.rpcLatest, isTurnInFlight: false };
    }

    const activityMs = sqliteInfo.rawLastStepMs || 0;
    if (!cs.initialized) {
      cs.initialized = true;
      if (sqliteInfo.turnsCount > 0) {
        const recentLiveWrite = activityMs > 0 && now >= activityMs - 5_000 && now - activityMs <= IN_FLIGHT_SETTLE_MS;
        cs.settledTurnsCount = sqliteInfo.turnsCount;
        cs.settledSteps =
          recentLiveWrite && sqliteInfo.latestStepType !== 2
            ? Math.max(0, sqliteInfo.totalSteps - 1)
            : sqliteInfo.totalSteps;
        cs.lastMutationAt = recentLiveWrite ? now : 0;
      } else {
        cs.settledTurnsCount = 0;
        cs.settledSteps = 0;
        cs.lastMutationAt =
          activityMs > 0 && now >= activityMs - 5_000 && now - activityMs <= MAX_IN_FLIGHT_WAIT_MS ? activityMs : 0;
      }
    } else if (sqliteInfo.statChanged) {
      const isLiveTimestamp = activityMs > 0 && now >= activityMs - 5_000 && now - activityMs <= 10_000;
      if (sqliteInfo.turnsCount > cs.settledTurnsCount) {
        cs.settledTurnsCount = sqliteInfo.turnsCount;
        cs.settledSteps = sqliteInfo.totalSteps;
        cs.lastMutationAt = isLiveTimestamp ? now : 0;
      } else if (sqliteInfo.totalSteps > cs.settledSteps) {
        cs.lastMutationAt = isLiveTimestamp ? now : 0;
      } else if (isLiveTimestamp) {
        cs.lastMutationAt = now;
      }
    }

    const evaluateInFlight = (tNow) => {
      if (!cs.lastMutationAt || tNow - cs.lastMutationAt >= MAX_IN_FLIGHT_WAIT_MS) {
        cs.settledSteps = sqliteInfo.totalSteps;
        cs.settledTurnsCount = sqliteInfo.turnsCount;
        cs.rpcPending = false;
        return false;
      }
      const inSettleWindow = tNow - cs.lastMutationAt < IN_FLIGHT_SETTLE_MS;
      if (
        !inSettleWindow &&
        !cs.rpcPending &&
        sqliteInfo.turnsCount > 0 &&
        sqliteInfo.latestStepType === 2 &&
        sqliteInfo.totalSteps > cs.settledSteps
      ) {
        cs.settledSteps = sqliteInfo.totalSteps;
      }
      const waitingForModel = sqliteInfo.totalSteps > cs.settledSteps;
      return Boolean(waitingForModel || cs.rpcPending || inSettleWindow);
    };

    const preInFlight = evaluateInFlight(now);
    const shouldPoll =
      force ||
      sqliteInfo.statChanged ||
      (preInFlight && now - cs.lastRpcAt >= ACTIVE_RPC_INTERVAL_MS);

    if (!shouldPoll) {
      return { latest: cs.rpcLatest, isTurnInFlight: preInFlight };
    }

    cs.lastRpcAt = now;
    const configs = await getCascadeModelConfigs();
    const offset = Math.max(0, (sqliteInfo.genRowCount || 0) - 3);
    const tail = await callLsRpc('GetCascadeTrajectoryGeneratorMetadata', {
      cascadeId: convId,
      generatorMetadataOffset: offset,
      includeMessages: false,
    });

    if (tail && Array.isArray(tail.generatorMetadata)) {
      let best = null;
      for (let i = tail.generatorMetadata.length - 1; i >= 0; i--) {
        best = core.summarizeGeneratorMeta(tail.generatorMetadata[i], {
          lang,
          cascadeModelConfigs: configs,
          previousValidContext: cs.rpcLatest,
        });
        if (best) break;
      }
      if (best) {
        cs.rpcLatest = best;
      }
      const lastRawModel = tail.generatorMetadata.at(-1)?.chatModel;
      const tailPending = Boolean(
        lastRawModel &&
          !lastRawModel.error &&
          !(lastRawModel.retryInfos || []).at(-1)?.error &&
          !lastRawModel.usage?.outputTokens &&
          !lastRawModel.streamingDuration
      );
      const rpcSig = best
        ? `${best.actual ?? ''}:${best.output ?? ''}:${best.speed?.tps ?? ''}:${best.speed?.duration ?? ''}:${best.error || ''}`
        : '';
      if (cs.lastRpcSig !== '' && rpcSig !== cs.lastRpcSig) {
        cs.lastMutationAt = nowFn();
      }
      cs.lastRpcSig = rpcSig;
      cs.rpcPending = Boolean(
        tailPending && cs.lastMutationAt > 0 && nowFn() - cs.lastMutationAt < MAX_IN_FLIGHT_WAIT_MS
      );
    }
    return { latest: cs.rpcLatest, isTurnInFlight: evaluateInFlight(nowFn()) };
  }

  async function executeTier3Scan(convId, lang, force = false) {
    const cs = getOrInitConvState(convId);
    if (cs.scanPromise) return cs.scanPromise;
    const sq = cs.sqliteInfo;
    if (!sq?.exists || sq.totalSteps === 0) return null;

    const targetScanKey = `${sq.totalSteps}:${sq.latestTurn?.actualTokens || 0}:${sq.genRowCount}`;
    if (!force && cs.scanKey === targetScanKey && cs.scanData) {
      return cs.scanData;
    }

    cs.scanBusy = true;
    cs.scanError = '';
    cs.scanSeq++;

    cs.scanPromise = (async () => {
      try {
        metrics.tier3Scans++;
        if (force) filesCache.clear();
        const [full, configs] = await Promise.all([
          callLsRpc('GetCascadeTrajectory', { cascadeId: convId, trajectoryVerbosity: 3 }),
          getCascadeModelConfigs(),
        ]);

        const trajectory = full?.trajectory;
        if (!trajectory) {
          throw new Error('Conversation history unavailable');
        }
        const steps = [...(trajectory.steps || [])];
        const expected = Number(full.numTotalSteps ?? steps.length);
        while (steps.length < expected) {
          const page = await callLsRpc('GetCascadeTrajectorySteps', {
            cascadeId: convId,
            stepOffset: steps.length,
            trajectoryVerbosity: 3,
          });
          if (!page?.steps?.length) break;
          steps.push(...page.steps);
        }

        const session = core.analyzeSteps(steps, { lang });
        const attachments = await scanAttachments(session.media, lang);
        const attachmentTotal = core.emptyMeasure();
        for (const a of attachments) {
          const n = a.references || 1;
          core.addMeasure(attachmentTotal, {
            chars: (a.chars || 0) * n,
            bytes: (a.bytes || 0) * n,
            tokens: (a.tokens || 0) * n,
            low: (a.tokens || 0) * n,
            high: (a.tokens || 0) * n,
          });
        }

        const count = Number(full.numTotalGeneratorMetadata ?? trajectory.generatorMetadata?.length ?? 0);
        const tail = await callLsRpc('GetCascadeTrajectoryGeneratorMetadata', {
          cascadeId: convId,
          generatorMetadataOffset: Math.max(0, count - 3),
          includeMessages: false,
        });

        let latestModel = null;
        let rpcMeta = null;
        for (const m of (tail?.generatorMetadata || []).slice().reverse()) {
          const summary = core.summarizeGeneratorMeta(m, { lang, cascadeModelConfigs: configs });
          if (summary) {
            rpcMeta = summary;
            latestModel = m.chatModel;
            break;
          }
        }

        const system = latestModel
          ? core.measureText(
              (latestModel.promptSections || []).map((p) => p.content || '').join('\n') ||
                latestModel.systemPrompt ||
                ''
            )
          : core.emptyMeasure();
        const definitions = latestModel
          ? core.measureText(JSON.stringify(latestModel.tools || []))
          : core.emptyMeasure();

        const unknownFiles = attachments.filter((a) => a.status !== 'parsed').length;
        const sysWeight = (system.tokens || 0) + (definitions.tokens || 0);
        const entries = [
          { id: 'system', weight: sysWeight },
          { id: 'tools', weight: session.groups.tools.tokens || 0 },
          { id: 'assistant', weight: session.groups.assistant.tokens || 0 },
          { id: 'thinking', weight: session.groups.thinking.tokens || 0 },
          { id: 'user', weight: session.groups.user.tokens || 0 },
          { id: 'summaries', weight: session.groups.summaries.tokens || 0 },
          { id: 'attachment-total', weight: attachmentTotal.tokens || 0 },
        ];
        const { totalWeight, shares } = core.computeContextShares(entries);

        cs.scanKey = targetScanKey;
        cs.scanData = {
          steps: session.steps,
          activeSteps: session.activeSteps,
          compacted: session.compacted,
          userMessages: session.userMessages,
          assistantMessages: session.assistantMessages,
          currentError: session.currentError,
          attachments: attachments.map((a) => ({
            name: a.name,
            status: a.status,
            tokens: a.tokens,
            dimensions: a.dimensions,
          })),
          unknownFiles,
          complete: unknownFiles === 0,
          totalWeight,
          shares,
          rpcMeta,
          scannedAt: nowFn(),
        };
        return cs.scanData;
      } catch (e) {
        cs.scanError = e.message || 'Scan failed';
        return null;
      } finally {
        cs.scanBusy = false;
        cs.scanSeq++;
        cs.scanPromise = null;
      }
    })();

    return cs.scanPromise;
  }

  function scheduleTier3Scan(convId, lang, force = false) {
    const cs = getOrInitConvState(convId);
    const sq = cs.sqliteInfo;
    if (!sq?.exists || sq.totalSteps === 0) return;
    if (!getLsAddress() || !getCsrfToken()) return;

    const targetScanKey = `${sq.totalSteps}:${sq.latestTurn?.actualTokens || 0}:${sq.genRowCount}`;
    if (!force && cs.scanKey === targetScanKey && cs.scanData) return;

    if (force) {
      if (cs.scanTimer) {
        clearTimeout(cs.scanTimer);
        cs.scanTimer = null;
      }
      void executeTier3Scan(convId, lang, true);
      return;
    }

    if (!cs.scanTimer && !cs.scanPromise) {
      cs.scanTimer = setTimeout(() => {
        cs.scanTimer = null;
        void executeTier3Scan(convId, lang, false);
      }, TIER3_DEBOUNCE_MS);
    }
  }

  function mergeTelemetryLatest(sqliteInfo, rpcLatest, scanData, lang) {
    const t = sqliteInfo.latestTurn;
    const baseRpc = rpcLatest || scanData?.rpcMeta || null;
    const budget = t?.maxContextTokens || baseRpc?.budget || DEFAULT_MAX_CONTEXT;

    let actual = t ? t.actualTokens : baseRpc?.actual ?? null;
    const input = t ? t.inputTokens : baseRpc?.input ?? null;
    const cached = t ? t.cachedIn : baseRpc?.cached ?? 0;
    const freshInput = t ? t.uncachedIn : baseRpc?.freshInput ?? (input != null ? Math.max(0, input - cached) : null);
    const output = t ? t.outTokens : baseRpc?.output ?? null;
    const thinking = t ? t.thinkTokens : baseRpc?.thinking ?? 0;

    let error = baseRpc?.error || '';
    let errorClassification = baseRpc?.errorClassification || null;
    if (error && errorClassification?.lang !== lang) {
      errorClassification = core.classifyRequestError(error, {
        lang,
        currentModel: baseRpc?.model || '',
        cascadeModelConfigs: modelConfigsCache?.configs || [],
      });
    }
    let exceeded = Boolean(baseRpc?.exceeded);
    let network = Boolean(baseRpc?.network);
    let serviceLimit = baseRpc?.serviceLimit || null;
    let status = baseRpc?.status || 'pending';

    const stepErr = scanData?.currentError;
    if (stepErr && !error) {
      const cls = core.classifyRequestError(stepErr.text, {
        lang,
        currentModel: baseRpc?.model || '',
        cascadeModelConfigs: modelConfigsCache?.configs || [],
      });
      error = stepErr.text;
      errorClassification = cls;
      exceeded = cls.kind === 'context_overflow';
      network = cls.kind === 'network_error';
      serviceLimit = cls.serviceLimit || serviceLimit;
      status = cls.kind;
    }

    if (exceeded) {
      actual = null;
    }

    const percent = exceeded ? 100 : actual != null && budget > 0 ? Math.min(100, (actual / budget) * 100) : null;
    if (status === 'pending') {
      if (actual != null) status = 'reported';
      else if (baseRpc?.estimate > 0) status = 'estimated';
    }

    return {
      actual,
      estimate: baseRpc?.estimate ?? null,
      budget,
      serviceLimit,
      exceeded,
      network,
      error,
      errorClassification,
      estimated: actual === null,
      freshInput,
      input,
      cached,
      output,
      thinking,
      percent,
      model: baseRpc?.model || '',
      modelLabel: baseRpc?.modelLabel || '',
      status,
      speed: baseRpc?.speed || null,
      lastStepEpochMs: sqliteInfo.lastStepEpochMs || 0,
    };
  }

  async function getSnapshot(clientState = {}) {
    if (clientState.prefsPatch && typeof clientState.prefsPatch === 'object') {
      applyPrefsPatch(clientState.prefsPatch);
    }

    const prefs = readPrefs();
    const convId = typeof clientState.convId === 'string' && UUID_RE.test(clientState.convId) ? clientState.convId : '';
    const lang = core.normalizeLocale(
      prefs.langMode && prefs.langMode !== 'auto' ? prefs.langMode : clientState.lang || 'en',
      'en'
    );

    if (!convId) {
      const quota = await getQuotaGroups(Boolean(clientState.forceScan));
      const rev = `idle|${quota.epoch}|${prefsEpoch}`;
      return {
        rev,
        convId: '',
        prefs,
        quotaGroups: quota.groups,
        latest: null,
        scan: null,
        scanBusy: false,
        scanError: '',
        isTurnInFlight: false,
      };
    }

    const sqliteInfo = readSqliteSnapshot(convId);
    const cs = getOrInitConvState(convId);
    const quota = await getQuotaGroups(Boolean(clientState.forceScan));
    const { latest: rpcLatest, isTurnInFlight } = await refreshTailGeneratorRpc(
      convId,
      sqliteInfo,
      lang,
      Boolean(clientState.forceScan)
    );

    if (clientState.forceScan || clientState.wantScan || sqliteInfo.statChanged || !cs.scanData) {
      scheduleTier3Scan(convId, lang, Boolean(clientState.forceScan));
    }

    const latest = mergeTelemetryLatest(sqliteInfo, rpcLatest, cs.scanData, lang);
    const speedKey = latest.speed ? `${latest.speed.tps}:${latest.speed.ttft}:${latest.speed.duration}` : '';
    const errKey = latest.errorClassification?.kind || 'none';
    const rev = [
      convId,
      sqliteInfo.statKey,
      speedKey,
      errKey,
      latest.estimate || 0,
      isTurnInFlight ? '1' : '0',
      cs.scanSeq,
      cs.scanBusy ? '1' : '0',
      quota.epoch,
      prefsEpoch,
      lang,
    ].join('|');

    return {
      rev,
      convId,
      prefs,
      quotaGroups: quota.groups,
      latest,
      scan: cs.scanData,
      scanBusy: cs.scanBusy,
      scanError: cs.scanError,
      isTurnInFlight,
    };
  }

  function dispose() {
    for (const cs of convCache.values()) {
      if (cs.scanTimer) clearTimeout(cs.scanTimer);
    }
    convCache.clear();
  }

  return {
    getSnapshot,
    readSqliteSnapshot,
    executeTier3Scan,
    readPrefs,
    applyPrefsPatch,
    getMetrics: () => ({ ...metrics }),
    dispose,
  };
}
