import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { createSqliteSnapshotCache } from '../agy-capsule/sidecars/agy_capsule/sqlite_cache.mjs';

test('unchanged SQLite is reused; WAL-only writes and checkpoints refresh it', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-wal-'));
  const path = join(dir, 'test.db');
  const writer = new DatabaseSync(path);
  try {
    writer.exec('PRAGMA journal_mode=WAL; CREATE TABLE stats(value INTEGER); INSERT INTO stats VALUES(1)');
    let reads = 0;
    const cache = createSqliteSnapshotCache(file => {
      reads++;
      const db = new DatabaseSync(file, { readOnly: true });
      try { return db.prepare('SELECT value FROM stats').get().value; }
      finally { db.close(); }
    });
    assert.equal(cache.read(path), 1);
    assert.equal(cache.read(path), 1);
    assert.equal(reads, 1);
    const mainBefore = statSync(path).mtimeMs;
    writer.exec('UPDATE stats SET value=2');
    assert.equal(statSync(path).mtimeMs, mainBefore, 'This update lives in WAL, not the main DB');
    assert.equal(cache.read(path), 2);
    assert.equal(reads, 2);
    writer.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    assert.equal(cache.read(path), 2);
    assert.equal(reads, 3);
  } finally { writer.close(); rmSync(dir, { recursive: true, force: true }); }
});

test('unready files do not read; failed refresh retries its own snapshot without leaking another conversation', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-unready-'));
  try {
    const a = join(dir, 'a.db'), b = join(dir, 'b.db');
    let fail = false, reads = 0;
    const cache = createSqliteSnapshotCache(file => { reads++; if (fail) throw new Error('busy'); return statSync(file).size; });
    assert.equal(cache.read(a), null);
    writeFileSync(a, ''); assert.equal(cache.read(a), null); assert.equal(reads, 0);
    writeFileSync(a, 'a'); assert.equal(cache.read(a), 1);
    fail = true; writeFileSync(a, 'changed'); assert.equal(cache.read(a), 1);
    writeFileSync(b, 'b'); assert.equal(cache.read(b), null);
    fail = false; assert.equal(cache.read(a), 7);
    rmSync(a); assert.equal(cache.read(a), null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('a write during a read is detected by the next poll rather than frozen under a later stamp', () => {
  const dir = mkdtempSync(join(tmpdir(), 'agy-race-'));
  const file = join(dir, 'test.db'); writeFileSync(file, 'a');
  try {
    let reads = 0;
    const cache = createSqliteSnapshotCache(path => {
      const result = statSync(path).size;
      if (++reads === 1) writeFileSync(path, 'updated');
      return result;
    });
    assert.equal(cache.read(file), 1);
    assert.equal(cache.read(file), 7);
    assert.equal(reads, 2);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
