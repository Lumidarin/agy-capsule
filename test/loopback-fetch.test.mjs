import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { isBadPort, loopbackFetch } from '../agy-capsule/sidecars/agy_capsule/loopback_fetch.mjs';
import { connectionFailed } from '../agy-capsule/sidecars/agy_capsule/ls_watchdog.mjs';

const BLOCKED = 4045;
const listen = (handler, port = BLOCKED) => new Promise((resolve, reject) => {
  const server = createServer(handler);
  server.once('error', reject);
  server.listen(port, '127.0.0.1', () => resolve(server));
});

test('bad-port list covers the Fetch standard ports we have seen in the wild', () => {
  for (const port of [4045, 6000, 5060, 6667, 10080, '1720']) assert.equal(isBadPort(port), true, String(port));
  for (const port of [80, 4041, 5351, 9222, 65535, '']) assert.equal(isBadPort(port), false, String(port));
});

test('plain fetch cannot reach a blocked port but loopbackFetch can (POST, headers, body, JSON)', async t => {
  let server;
  try { server = await listen((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ method: req.method, csrf: req.headers['x-codeium-csrf-token'], body }));
    });
  }); } catch (error) { return t.skip('port ' + BLOCKED + ' unavailable: ' + error.code); }
  t.after(() => server.close());
  const url = `http://localhost:${BLOCKED}/x`;
  await assert.rejects(fetch(url), error => error.cause?.message === 'bad port');
  const res = await loopbackFetch(url, { method: 'POST', headers: { 'x-codeium-csrf-token': 'tok' }, body: '{}', redirect: 'error', signal: AbortSignal.timeout(3000) });
  assert.equal(res.ok, true);
  assert.deepEqual(await res.json(), { method: 'POST', csrf: 'tok', body: '{}' });
});

test('loopbackFetch keeps the fetch error shapes the watchdog relies on', async t => {
  let mode = 'redirect', server;
  try { server = await listen((req, res) => {
    if (mode === 'redirect') { res.statusCode = 302; res.setHeader('Location', 'http://example.invalid/'); }
    else if (mode === 'empty') res.statusCode = 204;
    else return; // hang until the timeout
    res.end();
  }); } catch (error) { return t.skip('port ' + BLOCKED + ' unavailable: ' + error.code); }
  const url = `http://127.0.0.1:${BLOCKED}/`;
  await assert.rejects(loopbackFetch(url, { method: 'HEAD', redirect: 'error' }), error => error.cause?.message === 'unexpected redirect');
  mode = 'empty';
  assert.equal((await loopbackFetch(url, { method: 'HEAD' })).status, 204);
  mode = 'hang';
  await assert.rejects(loopbackFetch(url, { signal: AbortSignal.timeout(100) }), error => error.name === 'TimeoutError' && connectionFailed(error));
  await new Promise(resolve => server.close(resolve));
  await assert.rejects(loopbackFetch(url, { method: 'HEAD' }), error => error instanceof TypeError && connectionFailed(error));
});

test('ports outside the blocklist still go through the global fetch', async t => {
  const calls = [];
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push([url, init.redirect]); return new Response(null, { status: 200 }); });
  assert.equal((await loopbackFetch('http://127.0.0.1:5351/x', { redirect: 'error' })).status, 200);
  assert.deepEqual(calls, [['http://127.0.0.1:5351/x', 'error']]);
});
