import { createCloudTelemetryStore } from '../agy-capsule/sidecars/agy_capsule/cloud_telemetry.mjs';

const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);

// This cache is a display fallback for one exact main conversation, not a
// second history source. SQLite remains authoritative as soon as it exists.
export function createIdeCloudFallback({ hasLocal, now = Date.now }) {
  const store = createCloudTelemetryStore(8, now);
  const eligible = id => {
    if (!validId(id)) return false;
    if (!hasLocal(id)) return true;
    store.set(id, null);
    return false;
  };
  return {
    needsCloudTelemetry: eligible,
    onCloudTelemetry(id, raw) {
      if (!eligible(id)) return;
      if (raw === null || raw?.conversationId !== id || !Array.isArray(raw.steps) || !raw.steps.length) {
        store.set(id, null);
        return;
      }
      store.set(id, raw);
    },
    read(id, includeTurnMetrics = true, child = false) {
      // The renderer extractor deliberately excludes subagent trajectories.
      // A side/child chat must use its own local record, never a parent cache.
      if (child || !eligible(id)) return null;
      return store.read(id, includeTurnMetrics);
    },
  };
}
