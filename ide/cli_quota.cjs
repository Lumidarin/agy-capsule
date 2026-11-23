// On-demand fallback through the official CLI's /usage view, not its credentials.
const { join } = require('node:path');
const { homedir } = require('node:os');
const { existsSync } = require('node:fs');

const SOURCE = 'Antigravity CLI current account';
const clean = line => line.replace(/[│┃╭╮╰╯┌┐└┘─━]/g, ' ').trim();
const gate = text => /(?:do you |can you )?trust (?:this|the files|the authors)|sign in to continue|choose.{0,30}(?:login|sign.in)|select.{0,20}(?:account|authentication)|press enter to (?:login|sign in)|permission required/i.test(text);
const completion = text => /^\s*(?:[>❯❱]\s*)?\/usage\s+(?:View |Show |Check )?(?:model quota usage|your (?:quota|usage)|resource consumption)/im.test(text);

// Parse only labelled windows. In particular, a disabled window without a
// numeric percentage is NOT equivalent to 0% or 100%.
function parseQuotaScreen(text, now = Date.now()) {
  const groups = [], unavailable = [];
  let group, window, lastBucket;
  const setGroup = name => {
    group = groups.find(g => g.displayName === name);
    if (!group) groups.push(group = { displayName: name, buckets: [] });
    window = undefined; lastBucket = undefined;
  };
  for (const raw of text.split(/\r?\n/)) {
    const line = clean(raw);
    if (/within each group/i.test(line)) break;
    if (/^Gemini Models(?:\s|$)/i.test(line)) setGroup('Gemini Models');
    else if (/^Claude (?:and|&) GPT (?:models|Models)(?:\s|$)/i.test(line)) setGroup('Claude and GPT models');
    else {
      const named = line.match(/^(Gemini [\w .+-]+?)\s+(?:Weekly|Five Hour|5.Hour) Limit(?: Remaining)?\s*$/i);
      if (named) setGroup(named[1]);
    }
    if (!group) continue;
    if (/^Weekly Limit(?: Remaining)?\s*$/i.test(line) || /^Gemini .+ Weekly Limit(?: Remaining)?\s*$/i.test(line)) window = 'weekly';
    else if (/^(?:Five Hour|5.Hour) Limit(?: Remaining)?\s*$/i.test(line)) window = '5h';
    if (window) {
      const amount = line.match(/\b(\d+(?:\.\d+)?)\s*%/);
      if (amount && Number(amount[1]) <= 100) {
        lastBucket = { window, remainingFraction: Number(amount[1]) / 100 };
        group.buckets.push(lastBucket); window = undefined;
      } else if (/^Disabled\s*:/i.test(line)) {
        unavailable.push({ displayName: group.displayName, window, reason: 'disabled-without-percentage' });
        window = undefined; lastBucket = undefined;
      }
    }
    if (lastBucket && /^Refreshes in\b/i.test(line)) {
      const values = [...line.matchAll(/(\d+)\s*(d|h|m|s)\b/gi)];
      const duration = values.reduce((sum, [, n, unit]) => sum + Number(n) * ({ d: 86400, h: 3600, m: 60, s: 1 }[unit.toLowerCase()]), 0);
      if (duration > 0 && duration < 366 * 86400) lastBucket.resetTime = new Date(now + duration * 1000).toISOString();
    }
  }
  return { groups: groups.filter(g => g.buckets.length), unavailable };
}

async function readUsage({ pty, Terminal, cliPath, cwd, env = process.env, timeoutMs = 25000, pollMs = 200, now = Date.now, signal }) {
  const term = new Terminal({ cols: 160, rows: 72, allowProposedApi: true });
  let child, output, input, exited = false;
  const deadline = now() + timeoutMs;
  const pause = () => new Promise(resolve => setTimeout(resolve, pollMs));
  const screen = () => Array.from({ length: term.rows }, (_, i) =>
    term.buffer.active.getLine(term.buffer.active.viewportY + i)?.translateToString(true) || '').join('\n');
  const wait = async predicate => {
    while (now() < deadline) {
      if (signal?.aborted) throw Object.assign(new Error('CLI canceled'), { reason: 'canceled' });
      const value = screen();
      if (gate(value)) throw Object.assign(new Error('interactive gate'), { reason: 'interaction-required' });
      if (predicate(value)) return value;
      if (exited) throw Object.assign(new Error('CLI exited'), { reason: 'cli-exited' });
      await pause();
    }
    throw Object.assign(new Error('CLI timeout'), { reason: 'timeout' });
  };
  try {
    child = pty.spawn(cliPath, [], { name: 'xterm-256color', cwd, env: { ...env, TERM: 'xterm-256color' }, cols: 160, rows: 72, useConpty: true });
    output = child.onData(data => term.write(data));
    child.onExit?.(() => { exited = true; });
    input = term.onData(data => child.write(data)); // Terminal capability replies only.
    await wait(value => /Type your|for commands|for shortcuts|Ask anything|Send a message|Message.*[Aa]gent|[❯❱>]/i.test(value));
    child.write('/usage');
    await wait(completion);
    child.write('\r'); // Enter is sent only after the CLI identifies /usage.
    let result;
    await wait(value => {
      result = parseQuotaScreen(value, now());
      return result.groups.length > 0 && /within each group/i.test(value);
    });
    return { status: 'ok', ...result, at: now(), source: SOURCE };
  } finally {
    input?.dispose(); output?.dispose();
    try { child?.kill(); } catch { /* CLI may have already exited. */ }
    term.dispose();
  }
}

function createCliQuotaReader({ appRoot, cliPath, cwd = homedir(), env = process.env, now = Date.now, dependencies } = {}) {
  let pending, cached, abort, disposed = false;
  return {
    refresh() {
      if (disposed) return Promise.resolve({ status: 'error', reason: 'canceled', source: SOURCE });
      if (cached && now() - cached.at < 30000) return Promise.resolve(cached);
      if (pending) return pending;
      abort = new AbortController();
      pending = Promise.resolve().then(async () => {
        const exe = cliPath || (process.platform === 'win32' ? join(env.LOCALAPPDATA || '', 'agy', 'bin', 'agy.exe') : 'agy');
        if (process.platform === 'win32' && !existsSync(exe) && !dependencies) return { status: 'error', reason: 'cli-not-installed', source: SOURCE };
        let modules;
        try { modules = dependencies || { pty: require(join(appRoot, 'node_modules', 'node-pty')), Terminal: require(join(appRoot, 'node_modules', '@xterm', 'headless')).Terminal }; }
        catch { return { status: 'error', reason: 'terminal-runtime-unavailable', source: SOURCE }; }
        try { cached = await readUsage({ ...modules, cliPath: exe, cwd, env, now, signal: abort.signal }); return cached; }
        catch (err) { return { status: 'error', reason: err.reason || 'cli-unavailable', source: SOURCE }; }
      }).finally(() => { pending = undefined; });
      return pending;
    },
    clear() { cached = undefined; },
    dispose() { disposed = true; cached = undefined; abort?.abort(); },
  };
}

module.exports = { createCliQuotaReader, parseQuotaScreen, readUsage };
