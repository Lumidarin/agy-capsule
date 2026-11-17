import { statSync } from 'node:fs';

function fileStamp(path) {
  try {
    const s = statSync(path, { bigint: true });
    return { size: s.size, key: `${s.ino}:${s.size}:${s.mtimeNs}:${s.ctimeNs}` };
  } catch {
    return null;
  }
}

// Cache database-derived values only; settings, quotas and local clocks remain live.
export function createSqliteSnapshotCache(readSnapshot) {
  const entries = new Map();
  return {
    read(path) {
      const db = fileStamp(path);
      if (!db || db.size === 0n) {
        entries.delete(path);
        return null;
      }
      const key = db.key + '|' + (fileStamp(path + '-wal')?.key || 'no-wal');
      const previous = entries.get(path);
      if (previous?.key === key) return previous.value;
      try {
        const value = readSnapshot(path);
        // Stamp BEFORE reading: a concurrent write must be retried next poll,
        // not accidentally cached as already consumed.
        entries.delete(path);
        entries.set(path, { key, value });
        if (entries.size > 8) entries.delete(entries.keys().next().value);
        return value;
      } catch {
        // An unready/temporarily busy DB may reuse only its own last good value.
        // Do not advance the stamp, so the next poll retries it.
        return previous?.value ?? null;
      }
    },
  };
}
