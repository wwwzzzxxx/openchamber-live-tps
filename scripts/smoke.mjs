// Smoke test: mock OpenChamber SSE stream + the built service, feed synthetic
// OpenCode 2 events, assert instant live rate, TTFT, last-turn average,
// reasoning split, and session filtering.
//
// Run: node scripts/smoke.mjs  (from the package root, after `bun run build`)
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';

const SERVICE_TOKEN = 'smoke-test-token';
const SESSION = 'ses_smoke';
const OTHER = 'ses_other';
// The service writes last turn and curve beside itself so a restarted process
// still shows numbers. Point it at a scratch file so runs cannot leak into each
// other, and so nothing lands in the repo.
const STATE_FILE = path.join(os.tmpdir(), `live-tps-smoke-state-${process.pid}.json`);
fs.rmSync(STATE_FILE, { force: true });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name} ${extra}`);
  }
};

// --- mock OpenChamber event stream -----------------------------------------
const clients = new Set();
const sseServer = http.createServer((req, res) => {
  if (req.url !== '/api/global/event') {
    res.writeHead(404).end();
    return;
  }
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });
  // A real SSE server pushes its status line before the first event (curl
  // proves the OpenChamber one does), and origin discovery identifies a server
  // by those headers. Without this the mock withholds them until emit().
  res.flushHeaders();
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
await new Promise((r) => sseServer.listen(0, '127.0.0.1', r));
const sseOrigin = `http://127.0.0.1:${sseServer.address().port}`;

const emit = (event) => {
  const frame = `data: ${JSON.stringify(event)}\n\n`;
  for (const res of clients) res.write(frame);
};
const ev = (type, data) => emit({ id: 'e', created: Date.now(), type, data });

// --- start the built service -------------------------------------------------
const svcPort = 18751;
const svc = spawn(process.execPath, ['service/main.js'], {
  env: {
    ...process.env,
    OPENCHAMBER_SERVICE_PORT: String(svcPort),
    OPENCHAMBER_SERVICE_TOKEN: SERVICE_TOKEN,
    OPENCHAMBER_LIVE_TPS_STATE: STATE_FILE,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
svc.stderr.on('data', (d) => process.stderr.write(`[service] ${d}`));
const svcFetch = (path, init) => fetch(`http://127.0.0.1:${svcPort}${path}`, {
  ...init,
  headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, ...(init?.headers ?? {}) },
});

let ready = false;
for (let i = 0; i < 50 && !ready; i++) {
  try {
    const r = await svcFetch('/health');
    ready = r.ok;
  } catch { /* not up yet */ }
  if (!ready) await sleep(100);
}
check('service becomes ready', ready);
if (!ready) {
  svc.kill();
  sseServer.close();
  process.exit(1);
}

await svcFetch('/watch', {
  method: 'POST',
  body: JSON.stringify({ origin: sseOrigin, sessionId: SESSION }),
});
await sleep(300); // let the SSE subscription establish

// --- turn 1: text + reasoning, instant rate ----------------------------------
const t0 = Date.now();
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg1' });
await sleep(400); // TTFT window: 400 ms of silence before the first token
// ~200 tok/s worth of chars: 50 chars per 250 ms chunk at ratio 0.25
for (let i = 0; i < 4; i++) {
  ev('session.text.delta', {
    sessionID: SESSION,
    assistantMessageID: 'msg1',
    ordinal: 0,
    delta: 'x'.repeat(50),
  });
  await sleep(60);
}
ev('session.reasoning.delta', {
  sessionID: SESSION,
  assistantMessageID: 'msg1',
  ordinal: 0,
  delta: 'r'.repeat(40),
});
await sleep(120);
let midRate = await (await svcFetch('/rate')).json();
check(
  'running average exists mid-turn (estimate before settle)',
  midRate.running !== null && midRate.running.tps > 0 && midRate.running.source === 'estimate',
  JSON.stringify(midRate.running),
);
let rate = await (await svcFetch('/rate')).json();
check('live rate is instant, not climbing from 0', rate.live.tps > 80, `tps=${rate.live.tps}`);
check('reasoning chars tracked separately', rate.live.reasoningChars === 40, JSON.stringify(rate.live));
check('turn TTFT observed (~400ms)', rate.turn.ttftMs !== null && rate.turn.ttftMs >= 300 && rate.turn.ttftMs < 1500, `ttft=${rate.turn.ttftMs}`);

// Other sessions must not leak in.
ev('session.text.delta', { sessionID: OTHER, assistantMessageID: 'msgX', ordinal: 0, delta: 'z'.repeat(5000) });
await sleep(150);
const rate2 = await (await svcFetch('/rate')).json();
check('other sessions ignored', rate2.live.chars < rate.live.chars + 2000, `chars=${rate2.live.chars}`);

// Settle with real token counts, then end the turn.
ev('session.step.ended', {
  sessionID: SESSION,
  assistantMessageID: 'msg1',
  tokens: { output: 90, reasoning: 10 },
});
await sleep(150); // let the service consume the settlement before polling
midRate = await (await svcFetch('/rate')).json();
check(
  'running average switches to real counts after settle',
  midRate.running !== null && midRate.running.source === 'tokens',
  JSON.stringify(midRate.running),
);
const runningBeforeEnd = midRate.running?.tps ?? NaN;
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('last turn uses real token counts', rate.lastTurn?.source === 'tokens', JSON.stringify(rate.lastTurn));
check('last turn tokens = output + reasoning', rate.lastTurn?.tokens === 100, JSON.stringify(rate.lastTurn));
check('last turn has TTFT', typeof rate.lastTurn?.ttftMs === 'number' && rate.lastTurn.ttftMs >= 300, JSON.stringify(rate.lastTurn));
check('last turn saw reasoning', rate.lastTurn?.hasReasoning === true, JSON.stringify(rate.lastTurn));
check(
  'last turn tps ≈ tokens/activeMs',
  Math.abs(rate.lastTurn.tokensPerSecond - rate.lastTurn.tokens / (rate.lastTurn.activeMs / 1000)) < 0.01,
  JSON.stringify(rate.lastTurn),
);
check(
  'headline is continuous: running average converges to the final number',
  Number.isFinite(runningBeforeEnd)
    && Math.abs(rate.lastTurn.tokensPerSecond - runningBeforeEnd) / rate.lastTurn.tokensPerSecond < 0.2,
  `running=${runningBeforeEnd} final=${rate.lastTurn.tokensPerSecond}`,
);

// --- turn 2: text only, permission wait ---------------------------------------
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg2' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg2', ordinal: 0, delta: 'y'.repeat(60) });
ev('permission.asked', { sessionID: SESSION, id: 'perm1' });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('waiting-for-permission detected', rate.waiting === 'permission', JSON.stringify(rate.waiting));
ev('permission.replied', { sessionID: SESSION, requestID: 'perm1' });
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg2', tokens: { output: 15, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('text-only turn reports no reasoning', rate.lastTurn?.hasReasoning === false, JSON.stringify(rate.lastTurn));
check('waiting cleared after reply', rate.waiting === null, JSON.stringify(rate.waiting));

// --- turn 3: hidden reasoning (long silence, small burst, big token bill) ----
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg3' });
await sleep(1200); // model "thinks" with no deltas for over a second
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg3', ordinal: 0, delta: 'q'.repeat(80) });
await sleep(80);
ev('session.step.ended', {
  sessionID: SESSION,
  assistantMessageID: 'msg3',
  tokens: { output: 20, reasoning: 480 },
});
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('hidden-reasoning turn stays tokens-based', rate.lastTurn?.source === 'tokens', JSON.stringify(rate.lastTurn));
check(
  'hidden-reasoning turn does not explode (denominator covers the wait)',
  rate.lastTurn?.tokensPerSecond < 1000 && rate.lastTurn?.activeMs >= 1000,
  JSON.stringify(rate.lastTurn),
);

// --- turn 4: small but measurable step stays tokens-based ---------------------
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg4' });
await sleep(300);
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg4', ordinal: 0, delta: 'w'.repeat(60) });
await sleep(50);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg4', tokens: { output: 15, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('measurable small step stays tokens-based', rate.lastTurn?.source === 'tokens' && rate.lastTurn?.tokens === 15, JSON.stringify(rate.lastTurn));
check('small step rate is sane', rate.lastTurn?.tokensPerSecond < 1000, JSON.stringify(rate.lastTurn));

// --- turn 5: tool call freezes the headline ----------------------------------
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg5' });
await sleep(100);
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg5', ordinal: 0, delta: 'v'.repeat(200) });
await sleep(250); // let some generation time accumulate before the tool starts
ev('session.tool.called', { sessionID: SESSION, assistantMessageID: 'msg5', id: 'tool1' });
await sleep(150);
let toolRate1 = await (await svcFetch('/rate')).json();
check('tool execution detected', toolRate1.toolActive === true, JSON.stringify({ toolActive: toolRate1.toolActive }));
await sleep(700); // tool runs ~0.7s with no deltas: denominator must stay frozen
let toolRate2 = await (await svcFetch('/rate')).json();
check(
  'headline locked while tool runs',
  toolRate1.running !== null && toolRate2.running !== null
    && Math.abs(toolRate2.running.tps - toolRate1.running.tps) / Math.max(1, toolRate1.running.tps) < 0.05,
  `before=${toolRate1.running?.tps} after=${toolRate2.running?.tps}`,
);
ev('session.tool.success', { sessionID: SESSION, assistantMessageID: 'msg5', id: 'tool1' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg5', ordinal: 1, delta: 'v'.repeat(200) });
await sleep(150);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg5', tokens: { output: 100, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check(
  'final average excludes tool time',
  rate.lastTurn?.activeMs < rate.lastTurn?.wallMs - 500,
  JSON.stringify(rate.lastTurn),
);

// --- turn 6: stale execution start must not dilute the average --------------
// Regression test for the 6.1-vs-147 bug: 1.5 s of pre-step silence (queue,
// compaction, whatever) before the step even starts. Step-scoped accounting
// must report the step's own rate, not tokens over the whole execution span.
ev('session.execution.started', { sessionID: SESSION });
await sleep(1500);
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg6' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg6', ordinal: 0, delta: 's'.repeat(200) });
await sleep(150);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg6', tokens: { output: 100, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('pre-step silence does not dilute (tokens-based)', rate.lastTurn?.source === 'tokens', JSON.stringify(rate.lastTurn));
check(
  'pre-step silence excluded from denominator',
  rate.lastTurn?.activeMs < 1000 && rate.lastTurn?.tokensPerSecond > 150,
  JSON.stringify(rate.lastTurn),
);

// --- turn 7: zero-token step contributes no time -----------------------------
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg7a' });
await sleep(700); // tool-only step, settles zero tokens: its wall must not count
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg7a', tokens: { output: 0, reasoning: 0 } });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg7b' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg7b', ordinal: 0, delta: 't'.repeat(60) });
await sleep(100);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg7b', tokens: { output: 60, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('zero-token step adds no tokens', rate.lastTurn?.tokens === 60, JSON.stringify(rate.lastTurn));
check('zero-token step adds no time', rate.lastTurn?.activeMs < 700, JSON.stringify(rate.lastTurn));

// --- turn 8: unreported reasoning time is excluded ---------------------------
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msg8' });
ev('session.reasoning.delta', { sessionID: SESSION, assistantMessageID: 'msg8', ordinal: 0, delta: 'r'.repeat(40) });
await sleep(500); // reasoning streams half a second but settles zero reasoning tokens
ev('session.reasoning.delta', { sessionID: SESSION, assistantMessageID: 'msg8', ordinal: 0, delta: 'r'.repeat(40) });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg8', ordinal: 0, delta: 't'.repeat(40) });
await sleep(300); // then a measurable text phase settles 50 output tokens
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msg8', ordinal: 1, delta: 't'.repeat(40) });
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg8', tokens: { output: 50, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('unreported reasoning still tokens-based', rate.lastTurn?.source === 'tokens' && rate.lastTurn?.tokens === 50, JSON.stringify(rate.lastTurn));
check(
  'unreported reasoning span excluded, text phase kept',
  rate.lastTurn?.activeMs >= 200 && rate.lastTurn?.activeMs < 500,
  JSON.stringify(rate.lastTurn),
);

// --- turn 9: backfilled counts with no observed start are excluded -----------
const beforeBackfill = await (await svcFetch('/rate')).json();
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msg9', tokens: { output: 4000, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check(
  'unmeasurable step never explodes the average',
  rate.lastTurn?.endedAt === beforeBackfill.lastTurn?.endedAt,
  JSON.stringify(rate.lastTurn),
);

// --- turn 10: missed terminal flushes on the next execution start ------------
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgAa' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgAa', ordinal: 0, delta: 'a'.repeat(100) });
await sleep(100);
// No terminal event (simulates a missed `execution.succeeded` during a gap),
// then a new turn begins: the leftover must settle from its own steps.
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgAb' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgAb', ordinal: 0, delta: 'b'.repeat(100) });
await sleep(100);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msgAb', tokens: { output: 60, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check(
  'post-gap turn counts only its own steps',
  rate.lastTurn?.source === 'tokens' && rate.lastTurn?.tokens === 60,
  JSON.stringify(rate.lastTurn),
);

// --- turn 11: headline freezes during silent thinking -------------------------
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgF' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgF', ordinal: 0, delta: 'f'.repeat(100) });
await sleep(150);
// Two chunks a span apart, the way a model actually streams. One chunk has no
// elapsed time to divide by, and the number that fell out of a 1 ms floor was
// the same artifact as the spike the last two cases in this file guard.
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgF', ordinal: 0, delta: 'f'.repeat(100) });
await sleep(150);
const freeze1 = await (await svcFetch('/rate')).json();
await sleep(600); // model thinks with no deltas: nothing new countable
const freeze2 = await (await svcFetch('/rate')).json();
check(
  'headline frozen while thinking (no new tokens, no new time)',
  freeze1.running !== null && freeze2.running !== null && freeze2.running.tps === freeze1.running.tps,
  `before=${freeze1.running?.tps} after=${freeze2.running?.tps}`,
);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msgF', tokens: { output: 100, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('frozen turn still settles tokens-based', rate.lastTurn?.source === 'tokens' && rate.lastTurn?.tokens === 100, JSON.stringify(rate.lastTurn));

// --- turn 12: multi-step total = sum(tokens) / sum(nets) -----------------------
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgGa' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgGa', ordinal: 0, delta: 'g'.repeat(80) });
await sleep(200);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msgGa', tokens: { output: 40, reasoning: 0 } });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgGb' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgGb', ordinal: 0, delta: 'g'.repeat(80) });
await sleep(200);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msgGb', tokens: { output: 60, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('multi-step tokens are summed', rate.lastTurn?.tokens === 100, JSON.stringify(rate.lastTurn));
check(
  'multi-step nets are summed',
  (rate.lastTurn?.source === 'tokens') && (rate.lastTurn?.activeMs ?? 0) >= 300 && (rate.lastTurn?.activeMs ?? 0) < 800,
  JSON.stringify(rate.lastTurn),
);

// --- turn 13: fallback estimate freezes without observed step starts ----------
ev('session.execution.started', { sessionID: SESSION });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgH', ordinal: 0, delta: 'h'.repeat(50) });
await sleep(150);
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgH', ordinal: 0, delta: 'h'.repeat(50) });
await sleep(300);
const fb1 = await (await svcFetch('/rate')).json();
await sleep(400); // silence with unmeasurable steps: estimate must hold too
const fb2 = await (await svcFetch('/rate')).json();
check(
  'fallback estimate frozen during silence',
  fb1.running !== null && fb2.running !== null
    && fb1.running.source === 'estimate' && fb2.running.tps === fb1.running.tps,
  `before=${JSON.stringify(fb1.running)} after=${JSON.stringify(fb2.running)}`,
);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msgH', tokens: { output: 30, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('unobserved step never becomes measured', rate.lastTurn?.source === 'estimate', JSON.stringify(rate.lastTurn));

// --- session switch: memory survives -----------------------------------------
const firstTurnTps = (await (await svcFetch('/rate')).json()).lastTurn?.tokensPerSecond;
await svcFetch('/watch', { method: 'POST', body: JSON.stringify({ origin: sseOrigin, sessionId: OTHER }) });
await sleep(200);
ev('session.execution.started', { sessionID: OTHER });
ev('session.step.started', { sessionID: OTHER, assistantMessageID: 'msgO' });
ev('session.text.delta', { sessionID: OTHER, assistantMessageID: 'msgO', ordinal: 0, delta: 'o'.repeat(100) });
await sleep(100);
ev('session.step.ended', { sessionID: OTHER, assistantMessageID: 'msgO', tokens: { output: 25, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: OTHER });
await sleep(150);
let otherRate = await (await svcFetch('/rate')).json();
check('other session has its own last turn', otherRate.lastTurn?.tokens === 25, JSON.stringify(otherRate.lastTurn));
await svcFetch('/watch', { method: 'POST', body: JSON.stringify({ origin: sseOrigin, sessionId: SESSION }) });
await sleep(200);
rate = await (await svcFetch('/rate')).json();
check('switching back restores last turn', rate.lastTurn?.tokensPerSecond === firstTurnTps, JSON.stringify(rate.lastTurn));
check('switching back restores curve', Array.isArray(rate.curve) && rate.curve.length > 0, JSON.stringify(rate.curve));

// --- two surfaces at once: neither disturbs the other ------------------------
// The status page and a second surface (another window, or a second panel) can
// ask about different sessions at the same time. Registering one used to reset
// the other's in-progress turn and drop the shared event stream, so both pages
// flipped between data and an empty section roughly once a second.
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgBoth' });
// A gap before the first character, or the span the estimate divides by is
// still under a millisecond and the number is refused by design.
await sleep(150);
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgBoth', ordinal: 0, delta: 'b'.repeat(120) });
await sleep(150);
await svcFetch('/watch', { method: 'POST', body: JSON.stringify({ origin: sseOrigin, sessionId: OTHER }) });
await sleep(150);
const mineMidTurn = await (await svcFetch(`/rate?sessionId=${SESSION}`)).json();
check(
  'a second watch leaves this session mid-turn intact',
  mineMidTurn.running !== null && mineMidTurn.turn.active === true,
  JSON.stringify({ running: mineMidTurn.running, active: mineMidTurn.turn.active }),
);
check('each page reads its own session id', mineMidTurn.sessionId === SESSION, `sessionId=${mineMidTurn.sessionId}`);
const theirsMidTurn = await (await svcFetch(`/rate?sessionId=${OTHER}`)).json();
check('the other page reads its own session', theirsMidTurn.sessionId === OTHER, `sessionId=${theirsMidTurn.sessionId}`);
const bareRate = await (await svcFetch('/rate')).json();
check('bare /rate still answers for the last watch', bareRate.sessionId === OTHER, `sessionId=${bareRate.sessionId}`);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msgBoth', tokens: { output: 40, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
await svcFetch('/watch', { method: 'POST', body: JSON.stringify({ origin: sseOrigin, sessionId: SESSION }) });
await sleep(200);

// --- turn 14: missed execution.started must not stick the turn on idle -----
// Regression for the "tools running but status shows idle/empty" report:
// the service attached after the turn began, so no `execution.started` was
// ever seen. Tool activity alone must mark the turn busy, and streamed tool
// input (the model's call arguments) must count live.
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgLate' });
await sleep(120);
ev('session.tool.input.started', { sessionID: SESSION, assistantMessageID: 'msgLate', id: 'toolLate' });
ev('session.tool.input.delta', { sessionID: SESSION, assistantMessageID: 'msgLate', id: 'toolLate', delta: '{"path":' });
await sleep(120);
ev('session.tool.input.delta', { sessionID: SESSION, assistantMessageID: 'msgLate', id: 'toolLate', delta: '"a"}' });
ev('session.tool.called', { sessionID: SESSION, assistantMessageID: 'msgLate', id: 'toolLate' });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('missed start still shows busy', rate.busy === true, JSON.stringify({ busy: rate.busy }));
check('tool execution detected without started', rate.toolActive === true, JSON.stringify({ toolActive: rate.toolActive }));
check('tool input counted live', rate.live.toolChars > 0, JSON.stringify(rate.live));
check('running exists during tool input', rate.running !== null && rate.running.tps > 0, JSON.stringify(rate.running));
ev('session.tool.success', { sessionID: SESSION, assistantMessageID: 'msgLate', id: 'toolLate' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgLate', ordinal: 0, delta: 'z'.repeat(60) });
await sleep(100);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msgLate', tokens: { output: 25, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('late-attach turn settles tokens-based', rate.lastTurn?.source === 'tokens' && rate.lastTurn?.tokens === 25, JSON.stringify(rate.lastTurn));

// --- turn 15: `session.next.*` names and callID shape are accepted ---------
ev('session.next.execution.started', { sessionID: SESSION });
ev('session.next.step.started', { sessionID: SESSION, assistantMessageID: 'msgNext' });
ev('session.next.tool.input.delta', { sessionID: SESSION, assistantMessageID: 'msgNext', callID: 'callNext', delta: '{"a":1}' });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('next-prefixed input delta counted', rate.live.toolChars > 0 && rate.busy === true, JSON.stringify({ live: rate.live, busy: rate.busy }));
ev('session.next.step.ended', { sessionID: SESSION, assistantMessageID: 'msgNext', tokens: { output: 12, reasoning: 0 } });
ev('session.next.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('next-prefixed turn settles tokens-based', rate.lastTurn?.source === 'tokens' && rate.lastTurn?.tokens === 12, JSON.stringify(rate.lastTurn));

// --- turn 16: input streaming time counts, execution time does not ---------
ev('session.execution.started', { sessionID: SESSION });
ev('session.step.started', { sessionID: SESSION, assistantMessageID: 'msgTool' });
ev('session.tool.input.started', { sessionID: SESSION, assistantMessageID: 'msgTool', id: 'tool2' });
ev('session.tool.input.delta', { sessionID: SESSION, assistantMessageID: 'msgTool', id: 'tool2', delta: 'x'.repeat(100) });
await sleep(300); // model writes the tool call: generation time, must be kept
ev('session.tool.called', { sessionID: SESSION, assistantMessageID: 'msgTool', id: 'tool2' });
await sleep(500); // tool executes with no deltas: excluded from the average
ev('session.tool.success', { sessionID: SESSION, assistantMessageID: 'msgTool', id: 'tool2' });
ev('session.text.delta', { sessionID: SESSION, assistantMessageID: 'msgTool', ordinal: 0, delta: 'x'.repeat(60) });
await sleep(100);
ev('session.step.ended', { sessionID: SESSION, assistantMessageID: 'msgTool', tokens: { output: 50, reasoning: 0 } });
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check('input-streaming turn stays tokens-based', rate.lastTurn?.source === 'tokens' && rate.lastTurn?.tokens === 50, JSON.stringify(rate.lastTurn));
check(
  'execution silence excluded but input time kept',
  (rate.lastTurn?.activeMs ?? 0) >= 200 && (rate.lastTurn?.activeMs ?? 0) < (rate.lastTurn?.wallMs ?? 0) - 300,
  JSON.stringify(rate.lastTurn),
);

// --- turn 17: the curve must not carry an implausible point ------------------
// A bucket holding a single chunk measured it over `last - first + 1` = 1 ms,
// and sparkPaths normalizes by the largest point, so one such bucket flattened
// every other point on the curve (the finished turns read 70-560 against it).
ev('session.execution.started', { sessionID: SESSION });
for (let i = 0; i < 5; i += 1) {
  ev('session.text.delta', {
    sessionID: SESSION,
    assistantMessageID: 'msgR',
    ordinal: 0,
    delta: 'r'.repeat(60),
  });
  await sleep(120);
}
const streamingRate = await (await svcFetch('/rate')).json();
check(
  'curve carries no implausible point (spark normalizes by the max)',
  Array.isArray(streamingRate.curve)
    && streamingRate.curve.length > 0
    && streamingRate.curve.every((v) => Number.isFinite(v) && v <= 5000),
  JSON.stringify(streamingRate.curve),
);
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);

// --- turn 18: the character-estimate denominator must stay a real span -------
// Late attach (no `step.started`) puts the turn on the character-estimate
// path, which reconstructs its span as (last char - execution start) minus
// finished tool and wait time. A tool that ran entirely *after* the last
// counted character is subtracted from a span that ends before it, the result
// goes negative, and `Math.max(1, ...)` turns that into 1 ms: a few hundred
// characters then read as over a hundred thousand tok/s. No poll between the
// deltas and the tool close, so the frozen-estimate cache cannot mask it.
ev('session.execution.started', { sessionID: SESSION });
for (let i = 0; i < 5; i += 1) {
  ev('session.text.delta', {
    sessionID: SESSION,
    assistantMessageID: 'msgQ',
    ordinal: 0,
    delta: 'q'.repeat(60),
  });
  await sleep(120);
}
ev('session.tool.called', { sessionID: SESSION, assistantMessageID: 'msgQ', id: 'toolQ' });
await sleep(1500); // the tool outlasts the ~600 ms of generation before it
ev('session.tool.success', { sessionID: SESSION, assistantMessageID: 'msgQ', id: 'toolQ' });
await sleep(200);
rate = await (await svcFetch('/rate')).json();
check(
  'estimate survives a tool that outlasts generation',
  rate.running === null || rate.running.tps < 1000,
  `tps=${rate.running?.tps}`,
);
ev('session.execution.succeeded', { sessionID: SESSION });
await sleep(150);
rate = await (await svcFetch('/rate')).json();
check(
  'finalized estimate stays plausible',
  rate.lastTurn === null || rate.lastTurn.tokensPerSecond < 1000,
  `tps=${rate.lastTurn?.tokensPerSecond}`,
);

// --- origin discovery: a port forward's loopback does not exist here ---------
// Reproduces the remote/SSH-tunnel failure. The page hands the service an
// origin that is refused on this machine (the forward exists only on the
// client), so the service has to find the server on its own parent's
// listening ports instead of sitting on `fetch failed`.
const dead = http.createServer();
await new Promise((resolve) => dead.listen(0, '127.0.0.1', resolve));
const deadOrigin = `http://127.0.0.1:${dead.address().port}`;
await new Promise((resolve) => dead.close(resolve));
await svcFetch('/watch', { method: 'POST', body: JSON.stringify({ origin: deadOrigin, sessionId: SESSION }) });
let rediscovered = null;
for (let i = 0; i < 30 && (!rediscovered || rediscovered.connection !== 'live'); i += 1) {
  await sleep(100);
  rediscovered = await (await svcFetch('/rate')).json();
}
check(
  'unreachable page origin falls back to origin discovery',
  rediscovered?.connection === 'live',
  JSON.stringify(rediscovered && { connection: rediscovered.connection, error: rediscovered.error, errorKind: rediscovered.errorKind }),
);
check('error kind cleared once connected', rediscovered?.errorKind === null, JSON.stringify(rediscovered?.errorKind));
ev('session.execution.started', { sessionID: SESSION });
await sleep(150);
const afterDiscovery = await (await svcFetch('/rate')).json();
check('events flow after discovery', afterDiscovery.busy === true, JSON.stringify({ busy: afterDiscovery.busy }));
ev('session.execution.succeeded', { sessionID: SESSION });

// --- persistence: a restarted service still answers --------------------------
// Closing OpenChamber kills this process. The numbers already measured are on
// disk, so the panel shows the last turn straight away instead of sitting
// empty until the next conversation finishes.
await sleep(1800); // let the debounced write land
const beforeRestart = (await (await svcFetch(`/rate?sessionId=${SESSION}`)).json()).lastTurn;
check('last turn present before restart', Boolean(beforeRestart), JSON.stringify(beforeRestart));
svc.kill();
await once(svc, 'exit');
await sleep(300);

const svc2 = spawn(process.execPath, ['service/main.js'], {
  env: {
    ...process.env,
    OPENCHAMBER_SERVICE_PORT: String(svcPort),
    OPENCHAMBER_SERVICE_TOKEN: SERVICE_TOKEN,
    OPENCHAMBER_LIVE_TPS_STATE: STATE_FILE,
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
svc2.stderr.on('data', (d) => process.stderr.write(`[service2] ${d}`));
const svc2Fetch = (p, init) => fetch(`http://127.0.0.1:${svcPort}${p}`, {
  ...init,
  headers: { Authorization: `Bearer ${SERVICE_TOKEN}`, ...(init?.headers ?? {}) },
});
let ready2 = false;
for (let i = 0; i < 50 && !ready2; i += 1) {
  try {
    ready2 = (await svc2Fetch('/health')).ok;
  } catch { /* not up yet */ }
  if (!ready2) await sleep(100);
}
check('service comes back after restart', ready2);

const cold = ready2 ? await (await svc2Fetch(`/rate?sessionId=${SESSION}`)).json() : null;
check(
  'restart: reported unwatched until a page asks again',
  cold !== null && cold.sessionId === null,
  `sessionId=${cold?.sessionId}`,
);
check(
  'restart: last turn restored from disk',
  cold?.lastTurn?.tokensPerSecond === beforeRestart?.tokensPerSecond && cold?.lastTurn != null,
  JSON.stringify(cold?.lastTurn),
);
check(
  'restart: curve restored from disk',
  Array.isArray(cold?.curve) && cold.curve.length > 0,
  JSON.stringify(cold?.curve),
);
await svc2Fetch('/watch', { method: 'POST', body: JSON.stringify({ origin: sseOrigin, sessionId: SESSION }) });
await sleep(300);
const warm = await (await svc2Fetch(`/rate?sessionId=${SESSION}`)).json();
check('restart: watching again marks it live', warm.sessionId === SESSION, `sessionId=${warm.sessionId}`);
svc2.kill();

console.log(failures === 0 ? '\nALL SMOKE TESTS PASSED' : `\n${failures} FAILURES`);
svc.kill();
sseServer.close();
fs.rmSync(STATE_FILE, { force: true });
process.exit(failures === 0 ? 0 : 1);
