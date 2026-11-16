/**
 * Headless Sidecar entry point for agy-capsule.
 *
 * Uses dynamic `import('sidecar_sdk')` when running under the Antigravity Language
 * Server so the module can also be imported/tested standalone without sidecar_sdk.
 */
import { realpathSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createTelemetryService } from './telemetry.mjs';
import { startDeckInjector } from './deck_injector.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const WATCH_FILES = ['server.mjs', 'core.mjs', 'telemetry.mjs', 'deck_injector.mjs', 'renderer_client.js'];

function startSelfReloadWatcher(onChanged) {
  const baseline = new Map();
  for (const name of WATCH_FILES) {
    try {
      baseline.set(name, statSync(join(__dirname, name)).mtimeMs);
    } catch {}
  }
  const timer = setInterval(() => {
    for (const [name, prevMtime] of baseline.entries()) {
      try {
        const cur = statSync(join(__dirname, name)).mtimeMs;
        if (cur !== prevMtime) {
          clearInterval(timer);
          onChanged(name);
          return;
        }
      } catch {}
    }
  }, 3000);
  timer.unref?.();
  return timer;
}

export async function startSidecar(options = {}) {
  const telemetry = createTelemetryService({
    onLsDead: () => process.exit(0),
    ...options,
  });

  let injector = null;

  if (process.env.ANTIGRAVITY_SIDECAR_WEB_PORT) {
    try {
      const { SidecarApp } = await import('sidecar_sdk');
      const app = new SidecarApp();
      app.page('/', () => '<!doctype html><html><body>agy-capsule headless sidecar active</body></html>');
      app.api(
        '/api/context',
        (data) => telemetry.getSnapshot({ convId: data?.conversationId || app.config?.conversationId || '' }),
        'GET'
      );
      app.run();
    } catch (e) {
      console.error('[agy-capsule] sidecar_sdk unavailable:', e?.message || e);
    }
  }

  if (process.env.ANTIGRAVITY_LS_ADDRESS || process.env.ANTIGRAVITY_SIDECAR_WEB_PORT || options.forceInjector) {
    injector = startDeckInjector(telemetry, {
      onSuperseded: () => {
        injector?.stop();
        telemetry.dispose();
        process.exit(0);
      },
    });
  }

  return { telemetry, injector };
}

const isMainModule =
  Boolean(process.argv[1]) &&
  (() => {
    try {
      return realpathSync(resolve(process.argv[1])) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
      return false;
    }
  })();

if (isMainModule) {
  const { telemetry, injector } = await startSidecar();
  startSelfReloadWatcher(() => {
    injector?.stop();
    telemetry.dispose();
    process.exit(0);
  });
}
