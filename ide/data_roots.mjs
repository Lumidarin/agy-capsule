import { statSync } from 'node:fs';
import { homedir } from 'node:os';
import { isAbsolute, join, parse, resolve } from 'node:path';

// dataDirectory is a product root containing conversations/, not that child
// folder itself. The caller must supply the user-level configuration value,
// never a value inherited from an opened workspace's settings.json.
export function resolveDataRoots({ home = homedir(), dataDirectory = '', native = false } = {}) {
  const explicit = dataDirectory !== '' && dataDirectory != null;
  if (explicit && (typeof dataDirectory !== 'string' || !isAbsolute(dataDirectory) ||
    (process.platform === 'win32' && parse(dataDirectory).root.replaceAll('/', '\\') === '\\'))) {
    return { root: null, directory: null, explicit: true, error: 'absolute-path-required' };
  }
  const root = explicit ? resolve(dataDirectory) : join(home, '.gemini', native ? 'antigravity-ide' : 'antigravity');
  return { root, directory: join(root, 'conversations'), explicit, error: null };
}

function inspectDirectory(path) {
  try {
    const value = statSync(path, { throwIfNoEntry: false });
    return !value ? 'missing' : value.isDirectory() ? 'directory' : 'file';
  } catch { return 'unreadable'; }
}

// This is a filesystem diagnosis, not a cloud/local classifier. A selected ID
// without a file may still be waiting for its first write, or may be cloud-only.
// Never substitute another chat or search another profile to fill it in.
export function diagnoseConversation(roots, conversationId = '') {
  if (roots?.error || !roots?.root || !roots?.directory) return { state: 'invalid-path', path: null };
  const rootState = inspectDirectory(roots.root);
  if (rootState === 'missing') return { state: roots.explicit ? 'root-missing' : 'uninitialized', path: null };
  if (rootState !== 'directory') return { state: rootState === 'unreadable' ? 'unreadable' : 'not-directory', path: null };
  const directoryState = inspectDirectory(roots.directory);
  if (directoryState === 'missing') return { state: 'uninitialized', path: null };
  if (directoryState !== 'directory') return { state: directoryState === 'unreadable' ? 'unreadable' : 'not-directory', path: null };
  if (!conversationId) return { state: 'new-conversation', path: null };
  if (typeof conversationId !== 'string' || !/^[a-zA-Z0-9_-]{1,128}$/.test(conversationId)) return { state: 'invalid-conversation', path: null };
  const path = join(roots.directory, conversationId + '.db');
  try {
    const value = statSync(path, { throwIfNoEntry: false });
    if (!value || value.isFile() && value.size === 0) return { state: 'waiting-for-data', path: null };
    return value.isFile() ? { state: 'ready', path } : { state: 'not-a-file', path: null };
  } catch { return { state: 'unreadable', path: null }; }
}
