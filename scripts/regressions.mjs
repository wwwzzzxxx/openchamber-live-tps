import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const root = await fs.mkdtemp(path.join(os.tmpdir(), 'live-tps-regressions-'));
const dataDir = path.join(root, '.config', 'openchamber');
await fs.mkdir(path.join(dataDir, 'run'), { recursive: true });
const servers = [];
const streams = new Set();
let service;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const listen = async (handler) => {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { server, port: server.address().port, origin: `http://127.0.0.1:${server.address().port}` };
};
let leakedRequests = 0;
const sink = await listen((req, res) => {
  // Origin discovery may probe this parent-owned port without credentials.
  if (req.url === '/login' || req.url === '/events' || req.headers.cookie || req.headers.authorization) {
    leakedRequests += 1;
  }
  res.writeHead(200).end();
});
const password = 'test-password';
let cookie = 'oc_ui_session_123=test-session';
let cookieRequests = 0;
const protectedHost = await listen(async (req, res) => {
  if (req.url === '/auth/session') {
    let body = '';
    for await (const chunk of req) body += chunk;
    assert.equal(JSON.parse(body).password, password);
    res.writeHead(200, { 'Set-Cookie': `${cookie}; HttpOnly; Path=/`, 'Content-Type': 'application/json' });
    res.end('{}');
    return;
  }
  if (req.headers.cookie !== cookie) {
    res.writeHead(401).end();
    return;
  }
  cookieRequests += 1;
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.flushHeaders();
  streams.add(res);
  res.on('close', () => streams.delete(res));
});
const desktopHost = await listen((req, res) => {
  if (req.headers.authorization !== 'Bearer test-desktop-token') {
    res.writeHead(401).end();
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  res.flushHeaders();
  streams.add(res);
  res.on('close', () => streams.delete(res));
});
let loginRedirects = 0;
let streamRedirects = 0;
const redirectedLogin = await listen((req, res) => {
  if (req.url === '/auth/session') {
    loginRedirects += 1;
    res.writeHead(307, { Location: `${sink.origin}/login` }).end();
  }
  else res.writeHead(401).end();
});
const redirectedStream = await listen((req, res) => {
  if (req.url === '/auth/session') {
    res.writeHead(200, { 'Set-Cookie': `${cookie}; Path=/` }).end('{}');
  } else if (req.headers.cookie === cookie) {
    streamRedirects += 1;
    res.writeHead(302, { Location: `${sink.origin}/events` }).end();
  } else res.writeHead(401).end();
});
for (const host of [protectedHost, redirectedLogin, redirectedStream]) {
  await fs.writeFile(path.join(dataDir, 'run', `openchamber-${host.port}.json`), JSON.stringify({ uiPassword: password }));
}
await fs.writeFile(path.join(dataDir, 'settings.json'), JSON.stringify({
  desktopLocalPort: desktopHost.port, desktopLocalClientToken: 'test-desktop-token',
}));

try {
  const reservation = await listen((req, res) => res.end());
  const port = reservation.port;
  await new Promise((resolve) => reservation.server.close(resolve));
  service = spawn(process.execPath, ['service/main.js'], {
    env: {
      PATH: process.env.PATH, HOME: root, USERPROFILE: root,
      OPENCHAMBER_SERVICE_PORT: String(port), OPENCHAMBER_SERVICE_TOKEN: 'test-service-token',
      OPENCHAMBER_LIVE_TPS_STATE: path.join(root, 'state.json'),
    },
    stdio: ['ignore', 'ignore', 'inherit'],
  });
  const request = async (route, body) => {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, {
      headers: { Authorization: 'Bearer test-service-token', 'Content-Type': 'application/json' },
      ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(5_000),
    });
    assert.equal(response.status, 200);
    return response.json();
  };
  const until = async (condition) => {
    for (let i = 0; i < 80; i += 1) {
      try { if (await condition()) return; } catch {}
      await delay(100);
    }
    throw new Error('Timed out waiting for service state');
  };
  await until(async () => (await request('/health')).ok);
  const watch = (host) => request('/watch', { origin: host.origin, sessionId: 'session-a' });
  await watch(protectedHost);
  await until(async () => (await request('/rate')).connection === 'live');
  assert.ok(cookieRequests > 0);
  console.log('ok password-protected event stream');

  // Interleave two models before either settles. Each correction must land on its own model.
  await request('/watch', { origin: protectedHost.origin, sessionId: 'session-b' });
  const emit = (type, data) => {
    for (const stream of streams) stream.write(`data: ${JSON.stringify({ type, data })}\n\n`);
  };
  for (const [sessionID, modelID] of [['session-a', 'model-a'], ['session-b', 'model-b']]) {
    emit('session.execution.started', { sessionID });
    emit('session.step.started', { sessionID, modelID, assistantMessageID: sessionID });
    emit('session.text.delta', { sessionID, assistantMessageID: sessionID, delta: 'x'.repeat(400) });
  }
  await delay(200);
  for (const [sessionID, output] of [['session-a', 200], ['session-b', 50]]) {
    emit('session.step.ended', { sessionID, assistantMessageID: sessionID, tokens: { output, reasoning: 0 } });
    emit('session.execution.succeeded', { sessionID });
  }
  await until(async () => {
    const saved = JSON.parse(await fs.readFile(path.join(root, 'state.json'), 'utf8'));
    return saved.models['model-a'] === 1.3 && saved.models['model-b'] === 0.85;
  });
  console.log('ok concurrent sessions keep separate model calibration');

  cookie = 'oc_ui_session_123=refreshed-session';
  for (const stream of streams) stream.destroy();
  const beforeRefresh = cookieRequests;
  await until(async () => cookieRequests > beforeRefresh && (await request('/rate')).connection === 'live');
  console.log('ok expired session credentials are refreshed on reconnect');

  await watch(desktopHost);
  await until(async () => (await request('/rate')).connection === 'live');
  console.log('ok desktop local bearer authentication');

  for (const [host, attempted] of [[redirectedLogin, () => loginRedirects], [redirectedStream, () => streamRedirects]]) {
    await watch(host);
    await until(async () => attempted() > 0);
    await delay(200);
    assert.equal(leakedRequests, 0);
  }
  console.log('ok login and authenticated event redirects cannot leak credentials');
} finally {
  if (service && service.exitCode === null) {
    const exited = once(service, 'exit');
    service.kill();
    const timer = setTimeout(() => service.kill('SIGKILL'), 2_000);
    await exited;
    clearTimeout(timer);
  }
  for (const stream of streams) stream.destroy();
  for (const server of servers) server.closeAllConnections();
  await Promise.all(servers.filter((server) => server.listening).map((server) => new Promise((resolve) => server.close(resolve))));
  await fs.rm(root, { recursive: true, force: true });
}
