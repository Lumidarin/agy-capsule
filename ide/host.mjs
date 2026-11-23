import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteSnapshotCache } from '../agy-capsule/sidecars/agy_capsule/sqlite_cache.mjs';
import { parsePbMap } from '../agy-capsule/sidecars/agy_capsule/conversation_db.mjs';
export { userBillingMode, quotaAvailability, readComposerBilling } from './billing.mjs';

const validId = id => typeof id === 'string' && /^[a-zA-Z0-9_-]{1,128}$/.test(id);
const first = (map, field) => map.get(field)?.[0];
const unpack = bytes => parsePbMap(Buffer.isBuffer(bytes) ? bytes : Buffer.alloc(0));
const decode = value => typeof value === 'string' ? unpack(Buffer.from(value, 'base64')) : new Map();

// The host indexes uss-activeCascadeIds by workbench window, not workspace.
// Do not use another window's row, even if it is the only one in the map.
export function windowId(logPath) {
  return logPath.match(/(?:^|[\\/])window(\d+)[\\/]exthost(?:[\\/]|$)/i)?.[1];
}
export function activeId(rows, win) {
  const id = win && first(decode(rows?.[win]?.value), 3)?.toString('utf8');
  return validId(id) ? id : '';
}
// The embedded Google chat panel persists its selection in this workspace's
// memento. Only read that extension's row; never guess by modification time.
export function workspaceChat(storagePath) {
  const path = storagePath && join(dirname(storagePath), 'state.vscdb');
  const cache = createSqliteSnapshotCache(file => {
    const db = new DatabaseSync(file, { readOnly: true, timeout: 100 });
    try {
      const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get('google.google-antigravity');
      if (!row) return null;
      const id = JSON.parse(row.value).lastConversationId;
      return { id: validId(id) ? id : '' };
    } finally { db.close(); }
  });
  return () => path ? cache.read(path) : null;
}
export function conversationPath(directory, id) {
  return validId(id) ? join(directory, id + '.db') : null;
}
export async function conversationIds(directory) {
  try {
    return (await readdir(directory, { withFileTypes: true }))
      .filter(f => f.isFile() && f.name.endsWith('.db')).map(f => f.name.slice(0, -3)).filter(validId).sort();
  } catch (err) { if (err.code === 'ENOENT') return []; throw err; }
}

// IDE 2.8 UserStatus -> CascadeModelConfigData -> ClientModelConfig.quota_info.
// This feed identifies models, not 5-hour/weekly pools. Never invent a window.
export function modelQuotas(value) {
  const configs = unpack(first(decode(value), 33)).get(1) || [];
  return configs.flatMap(bytes => {
    const model = unpack(bytes);
    const label = first(model, 1)?.toString('utf8');
    const info = unpack(first(model, 15));
    const raw = first(info, 1);
    if (!label || !Buffer.isBuffer(raw) || raw.length !== 4) return [];
    const fraction = raw.readFloatLE();
    if (!(fraction >= 0 && fraction <= 1)) return [];
    const reset = first(unpack(first(info, 2)), 1);
    return [{ label, percent: Math.round(fraction * 100), reset: reset > 0 && reset < 4e9 ? reset * 1000 : null }];
  });
}
