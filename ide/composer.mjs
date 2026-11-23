import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const socketMatches = (target, wsOrigin) => {
  if (!target || !/^[A-Za-z0-9_-]+$/.test(target.id || '') || !URL.canParse(target.webSocketDebuggerUrl)) return false;
  const ws = new URL(target.webSocketDebuggerUrl);
  return ws.origin === wsOrigin && ws.pathname === '/devtools/page/' + target.id &&
    !ws.username && !ws.password && !ws.search && !ws.hash;
};
const isWorkbench = target => {
  if (target?.type !== 'page' || !URL.canParse(target.url)) return false;
  const url = new URL(target.url);
  return url.protocol === 'vscode-file:' && url.hostname === 'vscode-app' && !url.username && !url.password &&
    url.pathname.endsWith('/out/vs/code/electron-browser/workbench/workbench.html');
};

// Read one non-sensitive host scalar, not DOM contents or extension state. This
// is called only after the trusted workbench and debugger socket are verified.
function readWorkbenchWindow(target) {
  return new Promise(resolveWindow => {
    let ws, done = false;
    const finish = value => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try { ws?.close(); } catch {}
      resolveWindow(Number.isSafeInteger(value) && value > 0 ? value : null);
    };
    const timer = setTimeout(() => finish(null), 2000);
    try {
      ws = new WebSocket(target.webSocketDebuggerUrl);
      ws.onopen = () => {
        try {
          ws.send(JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: {
            expression: 'Number.isSafeInteger(window.vscodeWindowId) && window.vscodeWindowId > 0 ? window.vscodeWindowId : null',
            returnByValue: true,
          } }));
        } catch { finish(null); }
      };
      ws.onmessage = event => {
        try {
          const reply = JSON.parse(event.data);
          if (reply.id === 1) finish(reply.result?.exceptionDetails ? null : reply.result?.result?.value);
        } catch { finish(null); }
      };
      ws.onerror = ws.onclose = () => finish(null);
    } catch { finish(null); }
  });
}

// Only trust the origin announced by Google's extension in THIS window's
// extension-host log, not whichever loopback page happened to open last.
export function ideComposerSession(logPath, workspaceUris) {
  const extHost = dirname(logPath);
  const expectedWindow = Number(logPath.match(/(?:^|[\\/])window(\d+)[\\/]exthost(?:[\\/]|$)/i)?.[1]);
  const knownWindows = new Map();
  let stamp, origin;
  return {
    portFile: resolve(extHost, '../../../..', 'DevToolsActivePort'),
    composerOrigin() {
      try {
        const folder = readdirSync(extHost).filter(n => /^output_logging_\d+T\d+$/.test(n)).sort().at(-1);
        if (!folder) return null;
        const logs = join(extHost, folder);
        const name = readdirSync(logs).find(n => /^\d+-Antigravity\.log$/.test(n));
        if (!name) return null;
        const path = join(logs, name), st = statSync(path);
        const key = path + ':' + st.size + ':' + st.mtimeMs;
        if (key !== stamp) {
          const entries = readFileSync(path, 'utf8').matchAll(/^\[LAUNCH\] Server at (http:\/\/127\.0\.0\.1:\d{1,5}) is READY after \d+ attempt\(s\)\.\r?$/gm);
          origin = [...entries].at(-1)?.[1] ?? null;
          stamp = key;
        }
        return origin;
      } catch { return null; }
    },
    isComposerTarget(t) {
      if (t?.type !== 'iframe' || !URL.canParse(t.url)) return false;
      const url = new URL(t.url), q = url.searchParams;
      const uri = q.get('workspaceUri') || '';
      // Re-read folders after add/remove operations in a multi-root workspace.
      // Array callers remain supported, but the IDE adapter uses a provider.
      const currentUris = typeof workspaceUris === 'function' ? workspaceUris() : workspaceUris;
      return url.protocol === 'http:' && url.hostname === '127.0.0.1' &&
        q.get('extensionView') === 'true' && q.get('hostVariant') === 'antigravity-ide' &&
        q.get('extensionVariant') === 'vs-code' && (currentUris?.length ? currentUris.includes(uri) : uri === '');
    },
    async filterWindowTargets(candidates, allTargets, wsOrigin) {
      if (!Number.isSafeInteger(expectedWindow) || expectedWindow <= 0 || !URL.canParse(wsOrigin)) return [];
      const endpoint = new URL(wsOrigin);
      if (endpoint.protocol !== 'ws:' || endpoint.hostname !== '127.0.0.1' ||
        !endpoint.port || endpoint.username || endpoint.password || endpoint.pathname !== '/' || endpoint.search || endpoint.hash) return [];
      const byId = new Map(allTargets.map(target => [target.id, target]));
      const pending = new Map(), active = new Set();
      const matching = await Promise.all(candidates.map(async candidate => {
        const wrapper = byId.get(candidate.parentId), top = byId.get(wrapper?.parentId);
        if (wrapper?.type !== 'iframe' || !URL.canParse(wrapper.url)) return null;
        const url = new URL(wrapper.url);
        if (url.protocol !== 'vscode-webview:' || !url.hostname || url.pathname !== '/index.html' ||
          !isWorkbench(top) || !socketMatches(top, endpoint.origin)) return null;
        const key = endpoint.origin + '/' + top.id;
        active.add(key);
        let number = knownWindows.get(key);
        if (number === undefined) {
          if (!pending.has(key)) pending.set(key, readWorkbenchWindow(top));
          number = await pending.get(key);
          if (number !== null) knownWindows.set(key, number);
        }
        return number === expectedWindow ? candidate : null;
      }));
      for (const key of knownWindows.keys()) if (!active.has(key)) knownWindows.delete(key);
      return matching.filter(Boolean);
    },
  };
}
