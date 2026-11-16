/**
 * Low-overhead Chrome DevTools Protocol (CDP) injector for agy-capsule.
 *
 * - Connects strictly to Antigravity UI pages (`https://127.0.0.1:<port>/...`)
 * - Injects the Shadow DOM + Core runtime bundle ONCE per page lifecycle
 * - Polls only a ~60-byte `pullClientState` call each second and pushes
 *   `applyServerState` strictly when `snapshot.rev` changes
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { getBrowserCoreScript } from './core.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
export const CAPSULE_VERSION = 13;
const TICK_INTERVAL_MS = 1000;
const LIST_POLL_CONNECTED_MS = 4000;
const LIST_POLL_DISCONNECTED_MS = 1500;

export function computeBundleHash(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export function needsBundleInjection(clientState, expectedHash) {
  return (
    !clientState ||
    typeof clientState !== 'object' ||
    clientState.v !== CAPSULE_VERSION ||
    clientState.hash !== expectedHash
  );
}

export function resolveCdpPortFile() {
  if (process.platform === 'darwin') {
    return join(homedir(), 'Library', 'Application Support', 'Antigravity', 'DevToolsActivePort');
  }
  if (process.platform === 'win32') {
    return join(process.env.APPDATA || join(homedir(), 'AppData', 'Roaming'), 'Antigravity', 'DevToolsActivePort');
  }
  return join(process.env.XDG_CONFIG_HOME || join(homedir(), '.config'), 'Antigravity', 'DevToolsActivePort');
}

export function buildRuntimeBundleWithHash(initTs = Date.now()) {
  const coreScript = getBrowserCoreScript();
  const rendererSrc = readFileSync(join(__dirname, 'renderer_client.js'), 'utf8');
  const hash = computeBundleHash(`${coreScript}\n${rendererSrc}`);
  const code = `${coreScript}\nglobalThis.__AGY_CAPSULE_INIT_TS = ${Number(initTs)};\nglobalThis.__AGY_CAPSULE_BUNDLE_HASH = ${JSON.stringify(hash)};\n${rendererSrc}\ntrue;`;
  return { code, hash };
}

export function buildRuntimeBundle(initTs = Date.now()) {
  return buildRuntimeBundleWithHash(initTs).code;
}

export function isAntigravityUiTarget(target) {
  return Boolean(
    target &&
      target.type === 'page' &&
      /^https:\/\/127\.0\.0\.1:\d+\//.test(target.url || '') &&
      target.webSocketDebuggerUrl
  );
}

export function startDeckInjector(telemetry, options = {}) {
  const instanceTs = Number(options.instanceTs || Date.now());
  const portFile = options.portFile || resolveCdpPortFile();
  const { code: runtimeBundle, hash: bundleHash } = buildRuntimeBundleWithHash(instanceTs);
  const onSuperseded = typeof options.onSuperseded === 'function' ? options.onSuperseded : () => process.exit(0);

  const sockets = new Map(); // targetId -> { ws, pending: Map, nextId, lastRev }
  let cachedPages = [];
  let lastListAt = 0;
  let lastErr = '';
  let stopped = false;

  function logOnce(msg) {
    if (msg !== lastErr) {
      lastErr = msg;
      console.error('[agy-capsule]', msg);
    }
  }

  function readCdpPort() {
    try {
      return readFileSync(portFile, 'utf8').split(/\r?\n/)[0].trim();
    } catch {
      return '';
    }
  }

  async function connectTarget(target) {
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    const entry = { ws, pending: new Map(), nextId: 1, lastRev: '' };
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        ws.onopen = null;
        ws.onerror = null;
        try {
          ws.close();
        } catch {}
        reject(new Error('ws timeout'));
      }, 3000);
      ws.onopen = () => {
        clearTimeout(t);
        resolve();
      };
      ws.onerror = () => {
        clearTimeout(t);
        try {
          ws.close();
        } catch {}
        reject(new Error('ws error'));
      };
    });
    if (stopped) {
      try {
        ws.close();
      } catch {}
      throw new Error('injector stopped');
    }
    ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        const cb = entry.pending.get(msg.id);
        if (cb) {
          entry.pending.delete(msg.id);
          cb(msg);
        }
      } catch {}
    };
    ws.onclose = () => {
      for (const cb of entry.pending.values()) {
        try {
          cb(undefined);
        } catch {}
      }
      entry.pending.clear();
      sockets.delete(target.id);
    };
    sockets.set(target.id, entry);
    return entry;
  }

  function evaluate(entry, expression) {
    return new Promise((resolve) => {
      if (!entry?.ws || entry.ws.readyState !== 1) {
        resolve(undefined);
        return;
      }
      const id = entry.nextId++;
      const t = setTimeout(() => {
        entry.pending.delete(id);
        resolve(undefined);
      }, 3000);
      entry.pending.set(id, (msg) => {
        clearTimeout(t);
        resolve(msg?.result?.result?.value);
      });
      try {
        entry.ws.send(
          JSON.stringify({
            id,
            method: 'Runtime.evaluate',
            params: { expression, returnByValue: true },
          })
        );
      } catch {
        clearTimeout(t);
        entry.pending.delete(id);
        resolve(undefined);
      }
    });
  }

  async function refreshPagesIfNeeded(now) {
    const interval = sockets.size > 0 ? LIST_POLL_CONNECTED_MS : LIST_POLL_DISCONNECTED_MS;
    if (sockets.size > 0 && now - lastListAt < interval && cachedPages.length > 0) {
      return cachedPages;
    }
    const port = readCdpPort();
    if (!port) {
      logOnce('DevToolsActivePort not found');
      return [];
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`, {
        signal: AbortSignal.timeout(3000),
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const targets = await res.json();
      lastListAt = now;
      cachedPages = Array.isArray(targets) ? targets.filter(isAntigravityUiTarget) : [];
      const activeIds = new Set(cachedPages.map((t) => t.id));
      for (const [id, entry] of sockets.entries()) {
        if (!activeIds.has(id)) {
          try {
            entry.ws.close();
          } catch {}
          sockets.delete(id);
        }
      }
      return cachedPages;
    } catch (e) {
      logOnce(`CDP list failed: ${e.message}`);
      return sockets.size > 0 ? cachedPages : [];
    }
  }

  async function tick() {
    if (stopped) return;
    const pages = await refreshPagesIfNeeded(Date.now());
    for (const t of pages) {
      if (stopped) return;
      try {
        const entry = sockets.get(t.id) || (await connectTarget(t));
        let clientState = await evaluate(entry, `globalThis.__agyCapsule?.pullClientState?.(${instanceTs}) ?? null`);
        if (clientState === undefined) continue;

        if (clientState === 'superseded') {
          stop();
          onSuperseded();
          return;
        }

        if (needsBundleInjection(clientState, bundleHash)) {
          const injected = await evaluate(entry, runtimeBundle);
          if (!injected) continue;
          entry.lastRev = '';
          clientState = await evaluate(entry, `globalThis.__agyCapsule?.pullClientState?.(${instanceTs}) ?? null`);
          if (clientState === undefined) continue;
          if (clientState === 'superseded') {
            stop();
            onSuperseded();
            return;
          }
        }

        if (!clientState || typeof clientState !== 'object') continue;

        const snapshot = await telemetry.getSnapshot(clientState);
        if (snapshot && snapshot.rev !== entry.lastRev) {
          const applied = await evaluate(
            entry,
            `globalThis.__agyCapsule?.applyServerState?.(${JSON.stringify(snapshot)}) ?? false`
          );
          if (applied === true) {
            entry.lastRev = snapshot.rev;
          } else {
            entry.lastRev = '';
          }
        }
        lastErr = '';
      } catch (e) {
        const existing = sockets.get(t.id);
        if (existing) {
          try {
            existing.ws.close();
          } catch {}
          sockets.delete(t.id);
        }
        logOnce(`page ${t.id}: ${e.message}`);
      }
    }
  }

  let busy = false;
  const timer = setInterval(async () => {
    if (busy || stopped) return;
    busy = true;
    try {
      await tick();
    } finally {
      busy = false;
    }
  }, TICK_INTERVAL_MS);

  function stop() {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    for (const entry of sockets.values()) {
      try {
        entry.ws.close();
      } catch {}
    }
    sockets.clear();
  }

  console.log('[agy-capsule] injector started, port file:', portFile);
  return { stop };
}
