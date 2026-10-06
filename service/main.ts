// Live TPS service for the `live-tps` OpenChamber extension.
//
// Runs as the extension's local process (manifest `contributes.service`) on
// 127.0.0.1, reachable only through the host proxy. It subscribes to the
// OpenChamber event stream (`GET /api/global/event`, the same SSE the UI reads)
// and derives an instant generation rate for one watched session.
//
// Differences from a naive rolling average: the live rate divides the buffered
// characters by the span they actually cover (up to the window), so the number
// is correct ~200 ms after streaming starts instead of climbing from 0 while
// the window fills. Text and reasoning deltas are counted separately so the
// panel can show the reasoning share and say so when a model reports none.
//
// The stream carries the OpenCode 2 wire events: `session.text.delta` and
// `session.reasoning.delta` fragments, per-step token settlements
// (`session.step.ended`), and execution status (`session.execution.*`).
//
// The status page hands it the OpenChamber origin and the session to watch via
// `POST /watch`, then polls `GET /rate`. The service never reaches the browser
// and the page never dials this process directly.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { tokensFromChars } from '../shared/tokens';
import { localAuthHeaders } from './auth';

const execFileAsync = promisify(execFile);

const port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
const token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';
if (!Number.isInteger(port) || port <= 0 || !token) {
  console.error('OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required');
  process.exit(1);
}

/**
 * Rolling measurement window. The live rate covers "about the last second":
 * characters older than this fall out, and the divisor is the span the
 * remaining samples actually cover, never more than this.
 */
const WINDOW_MS = 1_000;
/** Hard cap on retained delta samples; one second of chunks fits far below this. */
const SAMPLE_LIMIT = 5_000;
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 15_000;
/** A candidate origin that accepts the connection but never answers is written off here. */
const PROBE_TIMEOUT_MS = 2_000;
/** Origin discovery is a handful of dials against the parent process; keep it off the hot retry path. */
const DISCOVERY_INTERVAL_MS = 5_000;

// Characters are converted to tokens with the heuristic ported from
// opencode-tps-meter (see shared/tokens.ts): ceil(chars / 4). It is an
// approximation and is meant to be — provider-reported counts replace it
// whenever they arrive.
//
// Until they do, the correction below is what keeps the live number honest:
// the `calibrated live rate` from opencode-tps-meter v2, learned per model.
// A model whose real ratio departs from chars/4 is corrected by a factor here
// rather than by picking a different divisor, so the estimate converges on the
// provider's own count after a step or two.
const CALIBRATION_WEIGHT = 0.3;
const MIN_CALIBRATION_FACTOR = 0.25;
const MAX_CALIBRATION_FACTOR = 4;
/** Learned correction per model id; `*` covers a stream that never names one. */
let calibration = new Map<string, number>();
/** Model behind the turn currently streaming, used when a step names none. */
let currentModel = '*';

const calibrationFactor = (): number => calibration.get(currentModel) ?? 1;

/** Tokens for a streamed character total, corrected toward the model's real ratio. */
const estimateTokens = (chars: number): number =>
  Math.round(tokensFromChars(chars) * calibrationFactor());

const calibrate = (model: string, chars: number, generated: number): void => {
  if (!Number.isFinite(chars) || chars <= 0) return;
  if (!Number.isFinite(generated) || generated <= 0) return;
  const heuristic = tokensFromChars(chars);
  if (heuristic <= 0) return;
  const ratio = generated / heuristic;
  const factor = Math.min(MAX_CALIBRATION_FACTOR, Math.max(MIN_CALIBRATION_FACTOR, ratio));
  const previous = calibration.get(model) ?? 1;
  calibration.set(model, previous + (factor - previous) * CALIBRATION_WEIGHT);
};
/**
 * A gap between streamed characters longer than this is a pause, not
 * generation: tool execution, a retry, or the agent waiting for the user. That
 * time is excluded from the turn's average. Streamed chunks normally arrive in
 * tens of milliseconds, so the separation is wide.
 */
const MAX_STREAM_GAP_MS = 1_000;

type ConnectionState = 'idle' | 'connecting' | 'live' | 'error';

/** What kind of failure `lastError` describes, so the panel can word it. */
type ErrorKind = 'network' | 'http' | 'closed';

type Sample = { at: number; chars: number; kind: 'text' | 'reasoning' | 'tool' };

type WatchConfig = {
  origin: string;
  sessionId: string | null;
};

/** The finished turn's average rate, shown after the session goes idle. */
type TurnResult = {
  /** Average tokens per second over the turn's generation time. */
  tokensPerSecond: number;
  /** `tokens` when a settled step reported real counts, otherwise a character estimate. */
  source: 'tokens' | 'estimate';
  tokens: number;
  /** Denominator of the average: summed measurable step nets (step spans minus in-step tool time minus unreported-reasoning spans). */
  activeMs: number;
  /** First streamed character to turn end, for reference. */
  wallMs: number;
  /** Execution start to first streamed character; null when never observed. */
  ttftMs: number | null;
  /** Whether any reasoning (deltas or settled tokens) was seen this turn. */
  hasReasoning: boolean;
  endedAt: number;
};

type WaitingKind = 'permission' | 'question';

/** A session's durable numbers, as written to disk and read back on startup. */
type TurnPoint = { tps: number; at: number };
type SessionMemory = {
  lastTurn: TurnResult | null;
  turns: TurnPoint[];
};
/** Finished-turn curve points kept per session. */
const TURNS_CAP = 30;
/** Sessions remembered; oldest evicted past this. */
const SESSIONS_CAP = 20;
/** Live buckets drawn for the current window. */
const CURVE_BUCKETS = 12;
/** How long a change waits before it is written, so a burst of events coalesces. */
const PERSIST_DEBOUNCE_MS = 1_500;
/** On-disk schema version; a mismatch discards the file instead of guessing. */
const PERSIST_VERSION = 1;

// Collection-valued state is `let` rather than `const`: `enterSession` swaps the
// reference to the one belonging to the session being processed, so mutations
// land in that session's own record. See `SessionState` below.
let samples: Sample[] = [];
/** Characters seen per part id, used to diff `session.text.ended` / `session.reasoning.ended` snapshots. */
let partChars = new Map<string, number>();
/** Parts already counted through streaming deltas, never diffed again. */
let deltaParts = new Set<string>();
/** Tool-input fragments already counted through input deltas, never diffed again. */
let deltaToolCalls = new Set<string>();
/** Characters seen per assistant message id. */
let messageChars = new Map<string, number>();

let watch: WatchConfig | null = null;
let connection: ConnectionState = 'idle';
let lastError: string | null = null;
let lastErrorKind: ErrorKind | null = null;
/**
 * The origin the stream is actually attached to when it is not the one the
 * status page handed us.
 *
 * The page reports the URL *it* was served from, which is a port forward
 * whenever the desktop reaches a remote instance over SSH: `127.0.0.1:<tunnel>`
 * exists on the client, not here. This process is spawned by the server that
 * serves that page, so it runs beside the real listener and can dial it
 * directly. One service process talks to one server, so this sticks until the
 * page's origin changes.
 */
let serverOrigin: string | null = null;
/** Throttle for the port scan behind `discoverServerOrigin`. */
let lastDiscoveryAt = 0;
let lastEventAt = 0;
/** Every parsed event on the stream, watched session or not, for diagnosis. */
let eventsSeen = 0;
let busy = false;
let controller: AbortController | null = null;
let retryTimer: NodeJS.Timeout | null = null;
let retryDelay = RETRY_BASE_MS;

// The turn in progress. A turn spans `session.execution.started` until
// `session.execution.succeeded` / `failed`, but its average is built per
// assistant step (mirroring the native turn stats): total settled tokens over
// the steps' own durations minus tool execution inside each step. Only spans
// that produced countable tokens count — a step whose start was never
// observed, whose duration is unmeasurable, or that settled zero tokens is
// excluded; a settled step that streamed reasoning but reported zero
// reasoning tokens excludes its reasoning span. Whatever is left
// unmeasurable falls back to a character estimate, never to real counts over
// guessed time.
let turnExecAt: number | null = null;
let turnStartedAt: number | null = null;
let turnLastCharAt: number | null = null;
let turnChars = 0;
let turnReasoningChars = 0;
let turnActiveMs = 0;
let turnWaitMs = 0;
let waitStartAt: number | null = null;
/** Tool calls in flight (plus shell executions): generation is paused while non-empty. */
let activeToolIds = new Set<string>();
let turnToolMs = 0;
let toolStartAt: number | null = null;

/**
 * One assistant step (`assistantMessageID`) of the current turn. Durations
 * use local arrival times; a step whose `step.started` was missed is marked
 * `startObserved: false` and excluded from measured averages.
 */
type StepRecord = {
  id: string;
  startAt: number;
  startObserved: boolean;
  endAt: number | null;
  settled: boolean;
  output: number;
  reasoning: number;
  firstCharAt: number | null;
  chars: number;
  /** Arrival of the latest counted delta; open steps freeze their span here. */
  lastDeltaAt: number | null;
  reasoningChars: number;
  firstReasoningAt: number | null;
  lastReasoningAt: number | null;
  /** Closed tool intervals within this step; overlapping calls merge by counter. */
  toolSpans: Array<[number, number]>;
  toolOpen: number;
  toolSince: number | null;
};
let steps = new Map<string, StepRecord>();
/** Step ids seen in this turn, in arrival order. */
let turnStepOrder: string[] = [];
/** In-flight tool key -> step id it belongs to (`''` when unattributable). */
let pendingToolStep = new Map<string, string>();
/** Frozen-estimate cache: recomputed only when new characters arrive. */
let fbChars = -1;
let fbTps = NaN;
let lastTurn: TurnResult | null = null;
// Pending permission and question requests for the watched session. OpenCode
// keeps the session `busy` while an agent waits for the user; these sets are
// what distinguishes generation from waiting.
let pendingPermissions = new Set<string>();
let pendingQuestions = new Set<string>();

const waitingKind = (): WaitingKind | null => (
  pendingPermissions.size > 0 ? 'permission' : pendingQuestions.size > 0 ? 'question' : null
);

const clearTurn = (): void => {
  turnExecAt = null;
  turnStartedAt = null;
  turnLastCharAt = null;
  turnChars = 0;
  turnReasoningChars = 0;
  turnActiveMs = 0;
  turnWaitMs = 0;
  waitStartAt = null;
  turnToolMs = 0;
  toolStartAt = null;
  fbChars = -1;
  fbTps = NaN;
  for (const id of turnStepOrder) steps.delete(id);
  turnStepOrder = [];
};

/** Finished-turn curve of the watched session, oldest first. */
let turns: TurnPoint[] = [];

/**
 * Everything the measurement keeps for one session.
 *
 * The service reads one global event stream that carries every session at once,
 * and more than one status page can be asking about a different session at the
 * same time — two windows, or a window with a second surface open. These fields
 * used to live in module-level variables, so the second caller reset the first
 * one's in-progress turn and dropped the shared SSE connection on every watch.
 * They live in a per-session record now; the module-level variables are only
 * the register `enterSession` loads the active record into, which is why the
 * rest of this file did not have to change.
 */
type SessionState = {
  sessionId: string;
  currentModel: string;
  /** Last time this record was touched; drives the tracked-session cap. */
  lastSeenAt: number;
  samples: Sample[];
  partChars: Map<string, number>;
  deltaParts: Set<string>;
  deltaToolCalls: Set<string>;
  messageChars: Map<string, number>;
  busy: boolean;
  turnExecAt: number | null;
  turnStartedAt: number | null;
  turnLastCharAt: number | null;
  turnChars: number;
  turnReasoningChars: number;
  turnActiveMs: number;
  turnWaitMs: number;
  waitStartAt: number | null;
  activeToolIds: Set<string>;
  turnToolMs: number;
  toolStartAt: number | null;
  steps: Map<string, StepRecord>;
  turnStepOrder: string[];
  pendingToolStep: Map<string, string>;
  fbChars: number;
  fbTps: number;
  lastTurn: TurnResult | null;
  turns: TurnPoint[];
  pendingPermissions: Set<string>;
  pendingQuestions: Set<string>;
};

const sessionStates = new Map<string, SessionState>();
/**
 * Sessions a page has asked about **in this process**. Kept apart from
 * `sessionStates`, which also holds records restored from disk: `/rate` reports
 * `sessionId` from this set, so a page polls until it has watched again and
 * the stream gets started after a restart.
 */
const watched = new Set<string>();
/** How many sessions keep a record at once; the least recently touched goes. */
const TRACKED_CAP = SESSIONS_CAP;

const createSessionState = (sessionId: string): SessionState => ({
  sessionId,
  currentModel: '*',
  lastSeenAt: Date.now(),
  samples: [],
  partChars: new Map(),
  deltaParts: new Set(),
  deltaToolCalls: new Set(),
  messageChars: new Map(),
  busy: false,
  turnExecAt: null,
  turnStartedAt: null,
  turnLastCharAt: null,
  turnChars: 0,
  turnReasoningChars: 0,
  turnActiveMs: 0,
  turnWaitMs: 0,
  waitStartAt: null,
  activeToolIds: new Set(),
  turnToolMs: 0,
  toolStartAt: null,
  steps: new Map(),
  turnStepOrder: [],
  pendingToolStep: new Map(),
  fbChars: -1,
  fbTps: NaN,
  lastTurn: null,
  turns: [],
  pendingPermissions: new Set(),
  pendingQuestions: new Set(),
});

/** The record the module-level variables currently mirror. */
let activeSession: SessionState = createSessionState('');
/** Session mirrored by the module-level variables, or null outside a session. */
let activeSessionId: string | null = null;
let inSession = false;

const trimSessionStates = (): void => {
  while (sessionStates.size > TRACKED_CAP) {
    let oldestKey: string | null = null;
    let oldestAt = Infinity;
    for (const [key, value] of sessionStates) {
      if (key === activeSessionId || key === watch?.sessionId) continue;
      if (value.lastSeenAt < oldestAt) {
        oldestAt = value.lastSeenAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null) break;
    sessionStates.delete(oldestKey);
  }
};

const trackSession = (sessionId: string): SessionState => {
  const existing = sessionStates.get(sessionId);
  if (existing) {
    existing.lastSeenAt = Date.now();
    return existing;
  }
  const created = createSessionState(sessionId);
  sessionStates.set(sessionId, created);
  trimSessionStates();
  return created;
};

/**
 * Load `sessionId`'s record into the module-level variables. Everything read
 * and written between `enterSession` and `leaveSession` belongs to that
 * session. The two never nest: the stream delivers one event at a time and
 * `/rate` answers without awaiting, so there is no `await` to interleave them.
 */
const enterSession = (sessionId: string): void => {
  if (inSession) throw new Error('enterSession called while already inside a session');
  const state = trackSession(sessionId);
  activeSession = state;
  activeSessionId = sessionId;
  inSession = true;
  currentModel = state.currentModel;
  samples = state.samples;
  partChars = state.partChars;
  deltaParts = state.deltaParts;
  deltaToolCalls = state.deltaToolCalls;
  messageChars = state.messageChars;
  busy = state.busy;
  turnExecAt = state.turnExecAt;
  turnStartedAt = state.turnStartedAt;
  turnLastCharAt = state.turnLastCharAt;
  turnChars = state.turnChars;
  turnReasoningChars = state.turnReasoningChars;
  turnActiveMs = state.turnActiveMs;
  turnWaitMs = state.turnWaitMs;
  waitStartAt = state.waitStartAt;
  activeToolIds = state.activeToolIds;
  turnToolMs = state.turnToolMs;
  toolStartAt = state.toolStartAt;
  steps = state.steps;
  turnStepOrder = state.turnStepOrder;
  pendingToolStep = state.pendingToolStep;
  fbChars = state.fbChars;
  fbTps = state.fbTps;
  lastTurn = state.lastTurn;
  turns = state.turns;
  pendingPermissions = state.pendingPermissions;
  pendingQuestions = state.pendingQuestions;
};

/** Copy the register back into the record it was loaded from. */
const leaveSession = (): void => {
  if (!inSession) return;
  const state = activeSession;
  state.currentModel = currentModel;
  state.lastSeenAt = Date.now();
  state.samples = samples;
  state.partChars = partChars;
  state.deltaParts = deltaParts;
  state.deltaToolCalls = deltaToolCalls;
  state.messageChars = messageChars;
  state.busy = busy;
  state.turnExecAt = turnExecAt;
  state.turnStartedAt = turnStartedAt;
  state.turnLastCharAt = turnLastCharAt;
  state.turnChars = turnChars;
  state.turnReasoningChars = turnReasoningChars;
  state.turnActiveMs = turnActiveMs;
  state.turnWaitMs = turnWaitMs;
  state.waitStartAt = waitStartAt;
  state.activeToolIds = activeToolIds;
  state.turnToolMs = turnToolMs;
  state.toolStartAt = toolStartAt;
  state.steps = steps;
  state.turnStepOrder = turnStepOrder;
  state.pendingToolStep = pendingToolStep;
  state.fbChars = fbChars;
  state.fbTps = fbTps;
  state.lastTurn = lastTurn;
  state.turns = turns;
  state.pendingPermissions = pendingPermissions;
  state.pendingQuestions = pendingQuestions;
  inSession = false;
  activeSessionId = null;
};

/**
 * Where the durable numbers live.
 *
 * Beside the service itself so a git-installed extension keeps them across a
 * restart without writing into anything tracked (the file is gitignored), with
 * `OPENCHAMBER_LIVE_TPS_STATE` overriding it — the smoke test points that at a
 * scratch path so runs cannot leak into each other. A directory the process
 * cannot write falls back to the temp dir instead of failing startup.
 */
const statePaths = (): string[] => {
  const override = process.env.OPENCHAMBER_LIVE_TPS_STATE;
  if (override) return [override];
  const entry = process.argv[1];
  const beside = entry ? path.dirname(entry) : process.cwd();
  return [path.join(beside, '.live-tps-state.json'), path.join(os.tmpdir(), 'openchamber-live-tps-state.json')];
};

const memoryOf = (state: SessionState): SessionMemory => ({
  lastTurn: state.lastTurn,
  turns: state.turns.slice(-TURNS_CAP),
});

/** Read a state file's raw session entries; anything unreadable is just empty. */
const readSessions = (file: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { version?: unknown; sessions?: unknown };
    if (!parsed || parsed.version !== PERSIST_VERSION || !parsed.sessions) return {};
    const out: Record<string, unknown> = {};
    for (const [id, raw] of Object.entries(parsed.sessions as Record<string, unknown>)) {
      if (id && raw && typeof raw === 'object') out[id] = raw;
    }
    return out;
  } catch {
    return {};
  }
};

/** Learned per-model corrections stored beside the sessions. */
const readModels = (file: string): Record<string, number> => {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as { models?: unknown };
    const out: Record<string, number> = {};
    const models = parsed && typeof parsed.models === 'object' ? parsed.models : null;
    if (models) {
      for (const [key, value] of Object.entries(models as Record<string, unknown>)) {
        if (key && typeof value === 'number' && Number.isFinite(value)) out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
};

/** Restore durable numbers so a restarted service answers immediately. */
const readPersisted = (): void => {
  for (const file of statePaths()) {
    const sessions = readSessions(file);
    if (Object.keys(sessions).length === 0) continue;
    for (const [model, factor] of Object.entries(readModels(file))) {
      calibration.set(model, factor as number);
    }
    for (const [id, raw] of Object.entries(sessions)) {
      const memory = raw as Partial<SessionMemory>;
      const state = createSessionState(id);
      state.lastTurn = memory.lastTurn ?? null;
      state.turns = Array.isArray(memory.turns) ? memory.turns.slice(-TURNS_CAP) : [];
      sessionStates.set(id, state);
    }
    return;
  }
};

let persistTimer: NodeJS.Timeout | null = null;
let persistDirty = false;

const writePersisted = (): void => {
  const own: Record<string, unknown> = {};
  for (const [id, state] of sessionStates) own[id] = memoryOf(state);
  for (const file of statePaths()) {
    try {
      // Two OpenChamber servers can share one workspace, so two services share
      // this directory. Overlay our sessions on whatever is already there
      // instead of clobbering the other instance's history.
      const foreign = Object.entries(readSessions(file)).filter(([id]) => own[id] === undefined);
      const sessions: Record<string, unknown> = { ...own };
      for (const [id, memory] of foreign.slice(0, Math.max(0, SESSIONS_CAP - Object.keys(own).length))) {
        sessions[id] = memory;
      }
      const payload = JSON.stringify({
        version: PERSIST_VERSION,
        savedAt: Date.now(),
        sessions,
        models: { ...readModels(file), ...Object.fromEntries(calibration) },
      });
      const tmp = `${file}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, payload, 'utf8');
      fs.renameSync(tmp, file);
      return;
    } catch {
      // Read-only extension folder: try the next path, and if none works the
      // numbers simply start fresh next time. Losing history is better than
      // losing the service.
    }
  }
};

const flushPersist = (): void => {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!persistDirty) return;
  persistDirty = false;
  writePersisted();
};

/** Coalesce writes: a turn's worth of events must not become disk traffic. */
const schedulePersist = (): void => {
  persistDirty = true;
  if (persistTimer) return;
  persistTimer = setTimeout(flushPersist, PERSIST_DEBOUNCE_MS);
  persistTimer.unref?.();
};

/**
 * Drop everything still in flight once the stream is back.
 *
 * A turn's closing events were sent while we were disconnected, so they are
 * gone for good: leaving `busy` or an open step behind would freeze the panel
 * on "generating" forever. Finished work — `lastTurn`, `turns` — is untouched,
 * which is the part worth keeping. This replaces the reset that a watch change
 * used to perform as a side effect.
 */
const resetInFlight = (): void => {
  if (inSession) return;
  for (const id of [...sessionStates.keys()]) {
    enterSession(id);
    clearTurn();
    busy = false;
    activeToolIds.clear();
    pendingToolStep.clear();
    pendingPermissions.clear();
    pendingQuestions.clear();
    waitStartAt = null;
    toolStartAt = null;
    leaveSession();
  }
};

const turnTtftMs = (): number | null => (
  turnExecAt !== null && turnStartedAt !== null
    ? Math.max(0, turnStartedAt - turnExecAt)
    : null
);

/** Mean first-character delay of the current turn's observed steps, else the execution-based fallback. */
const liveTtftMs = (): number | null => {
  const ttfts: number[] = [];
  for (const id of turnStepOrder) {
    const step = steps.get(id);
    if (step && step.startObserved && step.firstCharAt !== null) {
      ttfts.push(Math.max(0, step.firstCharAt - step.startAt));
    }
  }
  if (ttfts.length > 0) return ttfts.reduce((a, b) => a + b, 0) / ttfts.length;
  return turnTtftMs();
};

/** Accumulate time spent waiting for the user (permission/question) this turn. */
const noteWaiting = (now: number): void => {
  if (waitingKind() !== null) {
    if (waitStartAt === null) waitStartAt = now;
  } else if (waitStartAt !== null) {
    turnWaitMs += now - waitStartAt;
    waitStartAt = null;
  }
};

/** Whether a tool (or shell) call is currently executing for the watched session. */
const toolActive = (): boolean => activeToolIds.size > 0;

/** Accumulate tool-execution time this turn. Open while a tool runs. */
const noteTools = (now: number): void => {
  if (toolActive()) {
    if (toolStartAt === null) toolStartAt = now;
  } else if (toolStartAt !== null) {
    turnToolMs += now - toolStartAt;
    toolStartAt = null;
  }
};

/** Get or create this turn's record for an assistant message. */
const stepFor = (messageID: string, now: number): StepRecord => {
  let step = steps.get(messageID);
  if (!step) {
    step = {
      id: messageID,
      startAt: now,
      startObserved: false,
      endAt: null,
      settled: false,
      output: 0,
      reasoning: 0,
      firstCharAt: null,
      chars: 0,
      lastDeltaAt: null,
      reasoningChars: 0,
      firstReasoningAt: null,
      lastReasoningAt: null,
      toolSpans: [],
      toolOpen: 0,
      toolSince: null,
    };
    steps.set(messageID, step);
    turnStepOrder.push(messageID);
    if (steps.size > 500) {
      const oldest = steps.keys().next();
      if (!oldest.done) steps.delete(oldest.value);
    }
  }
  return step;
};

/** Latest turn step still open, if any. */
const latestOpenStepId = (): string | null => {
  for (let i = turnStepOrder.length - 1; i >= 0; i -= 1) {
    if (steps.get(turnStepOrder[i])?.endAt === null) return turnStepOrder[i];
  }
  return null;
};

const closeStepTool = (step: StepRecord, now: number): void => {
  if (step.toolSince !== null) {
    step.toolSpans.push([step.toolSince, Math.max(step.toolSince, now)]);
    step.toolSince = null;
  }
  step.toolOpen = 0;
};

/** Tool time of a step inside [fromMs, toMs]: closed spans overlapped, plus the open call capped at toMs. */
const stepToolWithinMs = (step: StepRecord, fromMs: number, toMs: number): number => {
  let total = 0;
  for (const [from, to] of step.toolSpans) {
    total += Math.max(0, Math.min(to, toMs) - Math.max(from, fromMs));
  }
  if (step.toolOpen > 0 && step.toolSince !== null) {
    total += Math.max(0, toMs - Math.max(step.toolSince, fromMs));
  }
  return total;
};

/**
 * Reasoning span excluded from a step: the model streamed reasoning but the
 * settled counts report none, so that time produced no countable tokens.
 * Only applies to settled steps; an open step's reasoning may still settle.
 */
const stepReasoningExclMs = (step: StepRecord): number => {
  if (!step.settled || step.reasoning !== 0 || step.reasoningChars === 0) return 0;
  if (step.firstReasoningAt === null || step.lastReasoningAt === null) return 0;
  return Math.max(0, step.lastReasoningAt - step.firstReasoningAt);
};

/**
 * No provider streams anywhere near this fast; a rate above it means the
 * measured window is broken (backfilled burst, truncated start), not that the
 * model was quick. Same guard the native stats use.
 */
const MAX_PLAUSIBLE_TOKENS_PER_SECOND = 5_000;

/**
 * tok/s for `tokens` over `ms`, or null when the window cannot carry a
 * number: a span under a millisecond is a clamp artifact rather than elapsed
 * time, and a rate over the ceiling is a broken window rather than a fast
 * model. Every derived rate goes through here.
 */
const plausibleRate = (tokens: number, ms: number): number | null => {
  if (!(ms >= 1)) return null;
  const tps = tokens / (ms / 1000);
  return tps > MAX_PLAUSIBLE_TOKENS_PER_SECOND ? null : tps;
};

type StepContribution = { tokens: number; netMs: number; real: boolean; ttftMs: number | null };

/**
 * One step's share of the turn average, or null when the step carries no
 * measurable signal: start never observed, net duration unmeasurable,
 * nothing countable settled, or an implausible rate from a truncated window.
 */
const contributeStep = (step: StepRecord): StepContribution | null => {
  if (!step.startObserved) return null;
  // An open step ends at its last counted activity, not at "now": silence
  // (a model thinking with no deltas) extends no denominator, so the number
  // holds instead of sagging. Tool time past that point is excluded the same
  // way. Settled steps keep their settle timestamp, matching server timing.
  const endRef = step.endAt ?? step.lastDeltaAt ?? step.startAt;
  const netMs = Math.max(0, endRef - step.startAt)
    - stepToolWithinMs(step, step.startAt, endRef)
    - stepReasoningExclMs(step);
  if (!(netMs >= 1)) return null;
  let tokens: number;
  let real: boolean;
  if (step.settled && step.output + step.reasoning > 0) {
    tokens = step.output + step.reasoning;
    real = true;
  } else if (!step.settled && step.chars > 0) {
    tokens = estimateTokens(step.chars);
    real = false;
  } else {
    return null;
  }
  if (tokens / (netMs / 1000) > MAX_PLAUSIBLE_TOKENS_PER_SECOND) return null;
  return {
    tokens,
    netMs,
    real,
    ttftMs: step.firstCharAt !== null ? Math.max(0, step.firstCharAt - step.startAt) : null,
  };
};

const sumSteps = (): {
  tokens: number;
  netMs: number;
  real: boolean;
  ttftMs: number | null;
} | null => {
  let tokens = 0;
  let netMs = 0;
  let real = false;
  const ttfts: number[] = [];
  for (const id of turnStepOrder) {
    const step = steps.get(id);
    if (!step) continue;
    const part = contributeStep(step);
    if (!part) continue;
    tokens += part.tokens;
    netMs += part.netMs;
    real = real || part.real;
    if (part.ttftMs !== null) ttfts.push(part.ttftMs);
  }
  if (!(netMs >= 1) || !(tokens > 0)) return null;
  return {
    tokens,
    netMs,
    real,
    ttftMs: ttfts.length > 0 ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null,
  };
};

/**
 * The running turn average, built the same way as the finalized one: summed
 * step tokens over summed step nets, so the headline converges to the final
 * number instead of jumping at turn end. Open steps contribute character
 * estimates frozen at their last counted activity — silence extends nothing.
 * Null when nothing measurable yet.
 */
const computeRunning = (): { tps: number; source: 'tokens' | 'estimate' } | null => {
  const sum = sumSteps();
  if (sum) return { tps: sum.tokens / (sum.netMs / 1000), source: sum.real ? 'tokens' : 'estimate' };
  if (turnStartedAt === null || turnChars === 0) return null;
  // No measurable step (typically a late attach): estimate frozen at the last
  // counted character. Recomputed only when new characters arrive, so the
  // number holds instead of sagging while the model thinks.
  if (turnChars === fbChars && Number.isFinite(fbTps)) {
    return { tps: fbTps, source: 'estimate' };
  }
  const ref = turnLastCharAt ?? turnStartedAt;
  const frozenWait = turnWaitMs + (waitStartAt !== null ? Math.max(0, ref - waitStartAt) : 0);
  const frozenTool = turnToolMs + (toolStartAt !== null ? Math.max(0, ref - toolStartAt) : 0);
  const reconstructed = turnExecAt === null
    ? ref - turnStartedAt
    : (ref - turnExecAt) - frozenWait - frozenTool;
  // A tool or a wait that finished *after* the last counted character is
  // subtracted from a span that ends before it, which leaves a negative
  // number; flooring that at 1 ms turns a few hundred characters into over a
  // hundred thousand tok/s. The accumulated streaming gaps already skip waits
  // and tool runs, so they are the honest denominator when the reconstruction
  // will not hold.
  const elapsedMs = reconstructed >= 1 ? reconstructed : turnActiveMs;
  const tps = plausibleRate(estimateTokens(turnChars), elapsedMs);
  if (tps === null) {
    // Nothing defensible to freeze: leave the cache empty rather than a number
    // that only looks like a measurement.
    fbTps = NaN;
    return null;
  }
  fbChars = turnChars;
  fbTps = tps;
  return { tps, source: 'estimate' };
};

const finalizeTurn = (now: number): void => {
  noteWaiting(now);
  noteTools(now);
  const wallMs = turnStartedAt !== null ? Math.max(1, now - turnStartedAt) : 1;
  const sum = sumSteps();
  if (sum) {
    lastTurn = {
      tokensPerSecond: sum.tokens / (sum.netMs / 1000),
      source: sum.real ? 'tokens' : 'estimate',
      tokens: sum.tokens,
      activeMs: Math.round(sum.netMs),
      wallMs,
      ttftMs: sum.ttftMs,
      hasReasoning: turnReasoningChars > 0 || [...steps.values()].some((s) => s.reasoning > 0),
      endedAt: now,
    };
    turns.push({ tps: lastTurn.tokensPerSecond, at: now });
    if (turns.length > TURNS_CAP) turns.splice(0, turns.length - TURNS_CAP);
    schedulePersist();
    clearTurn();
    return;
  }
  if (turnStartedAt === null || turnLastCharAt === null || turnChars === 0) {
    clearTurn();
    return;
  }
  // Nothing measurable per step: fall back to a self-consistent character
  // estimate, never real counts over guessed time.
  const activeMs = Math.max(
    1,
    turnActiveMs > 0 ? Math.round(turnActiveMs) : Math.min(wallMs, MAX_STREAM_GAP_MS),
  );
  const tps = plausibleRate(estimateTokens(turnChars), activeMs);
  if (tps === null) {
    // The window cannot carry a number: keep the previous turn's average
    // rather than publishing one built on a clamped span.
    clearTurn();
    return;
  }
  lastTurn = {
    tokensPerSecond: tps,
    source: 'estimate',
    tokens: estimateTokens(turnChars),
    activeMs,
    wallMs,
    ttftMs: turnTtftMs(),
    hasReasoning: turnReasoningChars > 0,
    endedAt: now,
  };
  turns.push({ tps: lastTurn.tokensPerSecond, at: now });
  if (turns.length > TURNS_CAP) turns.splice(0, turns.length - TURNS_CAP);
  schedulePersist();
  clearTurn();
};

const pruneSamples = (now: number): void => {
  let expired = 0;
  while (expired < samples.length && now - samples[expired].at > WINDOW_MS) {
    expired += 1;
  }
  if (expired > 0) samples.splice(0, expired);
};

const recordChars = (messageID: string, partID: string, kind: Sample['kind'], chars: number, now: number): void => {
  if (chars <= 0) return;
  // Any streamed model output proves the turn is alive, even when the
  // `execution.started` event was missed (late watch attach).
  busy = true;
  samples.push({ at: now, chars, kind });
  if (samples.length > SAMPLE_LIMIT) samples.splice(0, samples.length - SAMPLE_LIMIT);
  partChars.set(partID, (partChars.get(partID) ?? 0) + chars);
  messageChars.set(messageID, (messageChars.get(messageID) ?? 0) + chars);
  lastEventAt = now;

  if (turnStartedAt === null) {
    turnStartedAt = now;
    // Time to the first character counts only when it looks like generation
    // rather than a pause before the model call.
    if (turnExecAt !== null && now - turnExecAt <= MAX_STREAM_GAP_MS) {
      turnActiveMs += now - turnExecAt;
    }
  } else if (turnLastCharAt !== null && waitingKind() === null) {
    // Streaming gap, so it is generation time. A wait for the user is never
    // generation even when the user answers within the gap threshold.
    const gap = now - turnLastCharAt;
    if (gap <= MAX_STREAM_GAP_MS) turnActiveMs += gap;
  }

  turnLastCharAt = now;
  turnChars += chars;
  if (kind === 'reasoning') turnReasoningChars += chars;
  if (messageID) {
    const step = stepFor(messageID, now);
    step.chars += chars;
    step.lastDeltaAt = now;
    if (step.firstCharAt === null) step.firstCharAt = now;
    if (kind === 'reasoning') {
      step.reasoningChars += chars;
      if (step.firstReasoningAt === null) step.firstReasoningAt = now;
      step.lastReasoningAt = now;
    }
  }
};

/**
 * True when `sessionID` is the session the module-level variables mirror.
 * `handleEvent` enters that session before dispatching, so this stays a plain
 * equality check and the twenty-odd call sites inside the switch never change.
 */
const isWatchedSession = (sessionID: unknown): boolean => (
  typeof sessionID === 'string' && activeSessionId !== null && sessionID === activeSessionId
);

const readString = (value: unknown): string => (typeof value === 'string' ? value : '');

const readNumber = (value: unknown): number => (
  typeof value === 'number' && Number.isFinite(value) ? value : 0
);

const readRecord = (value: unknown): Record<string, unknown> | null => (
  value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
);

/** Stable part identity for OpenCode 2 text and reasoning fragments. */
const fragmentPartID = (messageID: string, kind: 'text' | 'reasoning', ordinal: unknown): string => {
  if (!messageID) return '';
  const index = typeof ordinal === 'number' && Number.isInteger(ordinal) && ordinal >= 0 ? ordinal : 0;
  return `${messageID}:${kind}:${index}`;
};

/** Strip the OpenCode 2 `next` generation marker: `session.next.X` and `session.X` are the same event. */
const normType = (type: string): string => type.replace('.next.', '.');

/**
 * A watched-session event that proves the turn is alive. Covers late watch
 * attaches that missed `session.execution.started`: the turn is marked busy
 * instead of staying idle for its whole duration.
 */
const markActive = (now: number): void => {
  if (turnExecAt === null) turnExecAt = now;
  busy = true;
  lastEventAt = now;
};

/** Stable tool-call identity across OpenChamber/OpenCode payload shapes. */
const readToolCallID = (payload: Record<string, unknown>): string => (
  readString(payload.callID) || readString(payload.id) || readString(payload.toolCallID)
);

/** Stable part identity for streamed tool-input fragments. */
const toolPartID = (messageID: string, callID: string): string => `${messageID}:tool:${callID || 'input'}`;

/**
 * Settles a step with its provider-reported token counts. Always recorded —
 * even before any character streamed — so early tool-only steps count; the
 * average decides per step whether its time was measurable. A retried step
 * keeps its first timing and latest counts.
 */
const settleStep = (messageID: string, output: number, reasoning: number, now: number): void => {
  const generated = output + reasoning;
  if (!messageID || generated <= 0) return;
  calibrate(currentModel, messageChars.get(messageID) ?? 0, generated);
  const step = stepFor(messageID, now);
  step.output = output;
  step.reasoning = reasoning;
  step.settled = true;
  if (step.endAt === null) step.endAt = now;
  closeStepTool(step, now);
};

type RawEvent = { type?: unknown; data?: unknown; properties?: unknown };

/** Session an event belongs to: `sessionID` in `data` (2.x) / `properties` (1.x), or under `form`. */
const eventSessionID = (event: RawEvent): string | null => {
  const payload = readRecord(event.data) ?? readRecord(event.properties);
  if (!payload) return null;
  const direct = readString(payload.sessionID);
  if (direct) return direct;
  const form = readRecord(payload.form);
  return form ? readString(form.sessionID) : '';
};

/**
 * Route an event into its own session's record.
 *
 * The stream carries every session at once and the pages watching different
 * sessions must not disturb each other, so the session is entered for the
 * duration of the dispatch and left afterwards. Only sessions a page asked
 * about are tracked, which bounds the map by the pages actually open.
 */
const handleEvent = (event: RawEvent, now: number): void => {
  const sessionId = eventSessionID(event);
  if (!sessionId || !sessionStates.has(sessionId)) return;
  enterSession(sessionId);
  try {
    dispatchEvent(event, now);
  } finally {
    leaveSession();
  }
};

const dispatchEvent = (event: RawEvent, now: number): void => {
  const type = normType(readString(event.type));
  if (!type) return;
  // OpenCode 2 carries fields in `data`; the 1.x shapes used `properties`.
  const payload = readRecord(event.data) ?? readRecord(event.properties);
  if (!payload) return;

  // --- streamed output (OpenCode 2) ---------------------------------------

  if (type === 'session.text.delta' || type === 'session.reasoning.delta') {
    if (!isWatchedSession(payload.sessionID)) return;
    const messageID = readString(payload.assistantMessageID);
    const delta = readString(payload.delta);
    const kind = type === 'session.reasoning.delta' ? 'reasoning' : 'text';
    const partID = fragmentPartID(messageID, kind, payload.ordinal);
    if (!partID || delta.length === 0) return;
    deltaParts.add(partID);
    recordChars(messageID, partID, kind, delta.length, now);
    return;
  }

  // The replayable full-value boundary of a fragment. It stands in for a
  // service that attached after the deltas went by; a part counted through
  // deltas is never diffed again.
  if (type === 'session.text.ended' || type === 'session.reasoning.ended') {
    if (!isWatchedSession(payload.sessionID)) return;
    const messageID = readString(payload.assistantMessageID);
    const kind = type === 'session.reasoning.ended' ? 'reasoning' : 'text';
    const partID = fragmentPartID(messageID, kind, payload.ordinal);
    if (!partID) return;
    if (deltaParts.has(partID)) return;
    const text = readString(payload.text);
    const previous = partChars.get(partID) ?? 0;
    if (text.length <= previous) return;
    recordChars(messageID, partID, kind, text.length - previous, now);
    return;
  }

  // Tool execution is not generation: while a tool (or shell) call runs, the
  // headline denominator freezes so the number locks instead of sliding.
  // Each call is also attributed to its step so the finished average can cut
  // tool time per step.
  //
  // Streaming tool *input* is the opposite: those deltas are the model
  // writing the tool-call arguments, i.e. real output tokens counted live
  // like text. The execution clock therefore starts at `session.tool.called`,
  // not at `session.tool.input.started`.
  if (type === 'session.tool.input.started') {
    if (!isWatchedSession(payload.sessionID)) return;
    markActive(now);
    const mid = readString(payload.assistantMessageID);
    if (mid) stepFor(mid, now);
    return;
  }

  if (type === 'session.tool.input.delta') {
    if (!isWatchedSession(payload.sessionID)) return;
    const messageID = readString(payload.assistantMessageID);
    const delta = readString(payload.delta);
    if (delta.length === 0) return;
    markActive(now);
    const partID = toolPartID(messageID, readToolCallID(payload));
    deltaToolCalls.add(partID);
    recordChars(messageID, partID, 'tool', delta.length, now);
    return;
  }

  // The replayable full-value boundary of a tool-input fragment. It stands
  // in for a service that attached after the deltas went by; an input
  // counted through deltas is never diffed again. Tool *results* are never
  // counted here — only the model's input arguments.
  if (type === 'session.tool.input.ended') {
    if (!isWatchedSession(payload.sessionID)) return;
    const messageID = readString(payload.assistantMessageID);
    const partID = toolPartID(messageID, readToolCallID(payload));
    if (deltaToolCalls.has(partID)) return;
    const text = readString(payload.text) || readString(payload.input);
    const previous = partChars.get(partID) ?? 0;
    if (text.length <= previous) return;
    markActive(now);
    recordChars(messageID, partID, 'tool', text.length - previous, now);
    return;
  }

  if (type === 'session.tool.called') {
    if (!isWatchedSession(payload.sessionID)) return;
    markActive(now);
    const id = readToolCallID(payload) || readString(payload.assistantMessageID);
    if (id) {
      activeToolIds.add(`tool:${id}`);
      if (toolStartAt === null && turnExecAt !== null) toolStartAt = now;
      const mid = readString(payload.assistantMessageID);
      const target = mid ? stepFor(mid, now) : (latestOpenStepId() ? steps.get(latestOpenStepId()!) ?? null : null);
      pendingToolStep.set(`tool:${id}`, target ? target.id : '');
      if (target) {
        target.toolOpen += 1;
        if (target.toolSince === null) target.toolSince = now;
      }
    }
    lastEventAt = now;
    return;
  }

  if (type === 'session.tool.success' || type === 'session.tool.failed') {
    if (!isWatchedSession(payload.sessionID)) return;
    markActive(now);
    const id = readToolCallID(payload) || readString(payload.assistantMessageID);
    if (id) activeToolIds.delete(`tool:${id}`);
    if (id) {
      const stepId = pendingToolStep.get(`tool:${id}`);
      pendingToolStep.delete(`tool:${id}`);
      const target = stepId ? steps.get(stepId) : undefined;
      if (target) {
        target.toolOpen = Math.max(0, target.toolOpen - 1);
        if (target.toolOpen === 0) closeStepTool(target, now);
      }
    }
    noteTools(now);
    lastEventAt = now;
    return;
  }

  if (type === 'session.shell.started') {
    if (!isWatchedSession(payload.sessionID)) return;
    markActive(now);
    const key = `shell:${readString(payload.id) || String(eventsSeen)}`;
    activeToolIds.add(key);
    if (toolStartAt === null && turnExecAt !== null) toolStartAt = now;
    const openId = latestOpenStepId();
    const target = openId ? steps.get(openId) ?? null : null;
    pendingToolStep.set(key, target ? target.id : '');
    if (target) {
      target.toolOpen += 1;
      if (target.toolSince === null) target.toolSince = now;
    }
    lastEventAt = now;
    return;
  }

  if (type === 'session.shell.ended') {
    if (!isWatchedSession(payload.sessionID)) return;
    markActive(now);
    const id = readString(payload.id);
    const closeKey = (key: string): void => {
      activeToolIds.delete(key);
      const stepId = pendingToolStep.get(key);
      pendingToolStep.delete(key);
      const target = stepId ? steps.get(stepId) : undefined;
      if (target) {
        target.toolOpen = Math.max(0, target.toolOpen - 1);
        if (target.toolOpen === 0) closeStepTool(target, now);
      }
    };
    if (id) closeKey(`shell:${id}`);
    else activeToolIds.forEach((key) => { if (key.startsWith('shell:')) closeKey(key); });
    noteTools(now);
    lastEventAt = now;
    return;
  }

  // `session.tool.input.delta` and the other tool progress events only confirm
  // a tracked call is still running.

  // --- assistant steps and their real token counts (OpenCode 2) -------------

  if (type === 'session.step.started') {
    if (!isWatchedSession(payload.sessionID)) return;
    markActive(now);
    const messageID = readString(payload.assistantMessageID);
    if (!messageID) return;
    // v2 names the model on the step; remember it so the correction is learned
    // per model rather than per session.
    const model = readString(payload.modelID) || readString(payload.model);
    if (model) currentModel = model;
    const existing = steps.get(messageID);
    if (existing && (existing.settled || existing.endAt !== null)) {
      // A retried step reuses its message id: time the new attempt fresh.
      steps.delete(messageID);
      turnStepOrder = turnStepOrder.filter((id) => id !== messageID);
    }
    stepFor(messageID, now).startObserved = true;
    lastEventAt = now;
    return;
  }

  if (type === 'session.step.ended' || type === 'session.step.failed') {
    if (!isWatchedSession(payload.sessionID)) return;
    markActive(now);
    const tokens = readRecord(payload.tokens);
    if (!tokens) return;
    settleStep(
      readString(payload.assistantMessageID),
      readNumber(tokens.output),
      readNumber(tokens.reasoning),
      now,
    );
    lastEventAt = now;
    return;
  }

  // --- live status (OpenCode 2) -------------------------------------------

  if (type === 'session.execution.started') {
    if (!isWatchedSession(payload.sessionID)) return;
    if (turnStepOrder.length > 0 || turnChars > 0) {
      // A previous turn never saw its terminal event (missed during a stream
      // gap): settle it from its own steps — step durations are
      // self-contained, so no idle time leaks in — then start fresh.
      finalizeTurn(now);
    }
    // Mark where the turn began so time to first token can be judged.
    if (turnExecAt === null) turnExecAt = now;
    busy = true;
    lastEventAt = now;
    return;
  }

  if (type === 'session.execution.succeeded' || type === 'session.execution.failed') {
    if (!isWatchedSession(payload.sessionID)) return;
    busy = false;
    lastEventAt = now;
    finalizeTurn(now);
    return;
  }

  if (type === 'session.execution.interrupted') {
    if (!isWatchedSession(payload.sessionID)) return;
    lastEventAt = now;
    // A shutdown is not the end of the turn: OpenCode keeps the execution
    // claim and resumes the same turn after restart, so the session stays busy
    // until the real terminal outcome arrives.
    if (readString(payload.reason) === 'shutdown') return;
    busy = false;
    finalizeTurn(now);
    return;
  }

  // --- requests to the user -----------------------------------------------

  if (type === 'permission.asked' || type === 'permission.v2.asked') {
    if (!isWatchedSession(payload.sessionID)) return;
    const requestId = readString(payload.id);
    if (requestId) pendingPermissions.add(requestId);
    lastEventAt = now;
    return;
  }

  if (type === 'permission.replied' || type === 'permission.v2.replied') {
    if (!isWatchedSession(payload.sessionID)) return;
    const requestId = readString(payload.requestID);
    if (requestId) pendingPermissions.delete(requestId);
    lastEventAt = now;
    return;
  }

  // OpenCode 2 models the question tool as a form.
  if (type === 'form.created') {
    const form = readRecord(payload.form);
    if (!form || !isWatchedSession(form.sessionID)) return;
    const requestId = readString(form.id);
    if (requestId) pendingQuestions.add(requestId);
    lastEventAt = now;
    return;
  }

  if (type === 'form.replied' || type === 'form.cancelled') {
    if (!isWatchedSession(payload.sessionID)) return;
    const requestId = readString(payload.id);
    if (requestId) pendingQuestions.delete(requestId);
    lastEventAt = now;
    return;
  }

  if (type === 'question.asked' || type === 'question.v2.asked') {
    if (!isWatchedSession(payload.sessionID)) return;
    const requestId = readString(payload.id);
    if (requestId) pendingQuestions.add(requestId);
    lastEventAt = now;
    return;
  }

  if (type === 'question.replied' || type === 'question.rejected' || type === 'question.v2.replied' || type === 'question.v2.rejected') {
    if (!isWatchedSession(payload.sessionID)) return;
    const requestId = readString(payload.requestID);
    if (requestId) pendingQuestions.delete(requestId);
    lastEventAt = now;
    return;
  }

  // OpenCode 2 declares `session.status` and `session.idle` but its own status
  // comes from the execution events above; a server that still emits them is
  // handled here for completeness.
  if (type === 'session.status') {
    if (!isWatchedSession(payload.sessionID)) return;
    const status = readRecord(payload.status);
    const nextBusy = status?.type === 'busy' || status?.type === 'retry';
    if (busy && !nextBusy) finalizeTurn(now);
    if (nextBusy && turnExecAt === null) turnExecAt = now;
    busy = nextBusy;
    lastEventAt = now;
    return;
  }

  if (type === 'session.idle') {
    if (!isWatchedSession(payload.sessionID)) return;
    busy = false;
    lastEventAt = now;
    finalizeTurn(now);
  }
};

const handleSseChunk = (chunk: string): void => {
  const data: string[] = [];
  for (const line of chunk.split('\n')) {
    if (!line.startsWith('data:')) continue;
    data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data.join('\n'));
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== 'object') return;
  // OpenCode 2 frames are the event itself; a proxy that wraps them as
  // `{ payload, directory, eventId }` is unwrapped here.
  const envelope = parsed as { payload?: unknown };
  const event = (envelope.payload && typeof envelope.payload === 'object' ? envelope.payload : parsed) as RawEvent;
  eventsSeen += 1;
  handleEvent(event, Date.now());
};

type ListenEndpoint = { host: string; port: number };

/** `127.0.0.1:57123`, `[::1]:57123`, `*:37389` -> `{ host, port }`. */
const parseEndpoint = (value: string): ListenEndpoint | null => {
  const bracketed = /^\[([^\]]*)\]:(\d+)$/.exec(value);
  if (bracketed) return { host: bracketed[1], port: Number(bracketed[2]) };
  const plain = /^([^:]+):(\d+)$/.exec(value);
  if (plain) return { host: plain[1], port: Number(plain[2]) };
  return null;
};

/** Build a loopback origin; wildcard binds are dialled over `127.0.0.1`. */
const toOrigin = (scheme: string, host: string, port: number): string => {
  const dial = host === '' || host === '*' || host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host;
  return `${scheme}://${dial.includes(':') ? `[${dial}]` : dial}:${port}`;
};

/** stdout of a helper binary; anything unusable reads as "no endpoints". */
const runFile = async (file: string, args: string[]): Promise<string> => {
  const { stdout } = await execFileAsync(file, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true,
  });
  return String(stdout);
};

/** Windows: `netstat -ano`, one socket per line with the owning PID last. */
const windowsListenEndpoints = async (pid: number): Promise<ListenEndpoint[]> => {
  const out = await runFile('netstat', ['-ano']);
  const found: ListenEndpoint[] = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== 'TCP') continue;
    if (Number(cols[4]) !== pid) continue;
    // A listener reports a wildcard peer. The state word is localized on some
    // Windows builds, so the peer is the primary test and the state a fallback.
    const listening = cols[2] === '0.0.0.0:0' || cols[2] === '[::]:0' || cols[2] === '*:*' || cols[3] === 'LISTENING';
    if (!listening) continue;
    const endpoint = parseEndpoint(cols[1]);
    if (endpoint) found.push(endpoint);
  }
  return found;
};

/** Linux: `ss -ltnp`, whose last column carries `pid=<n>` for our own sockets. */
const ssListenEndpoints = async (pid: number): Promise<ListenEndpoint[]> => {
  const out = await runFile('ss', ['-ltnp']);
  const found: ListenEndpoint[] = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6 || cols[0] !== 'LISTEN') continue;
    if (!new RegExp(`\\bpid=${pid}\\b`).test(cols.slice(5).join(' '))) continue;
    const endpoint = parseEndpoint(cols[3]);
    if (endpoint) found.push(endpoint);
  }
  return found;
};

/** macOS: `lsof`, where the NAME column reads `127.0.0.1:37389 (LISTEN)`. */
const lsofListenEndpoints = async (pid: number): Promise<ListenEndpoint[]> => {
  const out = await runFile('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)]);
  const found: ListenEndpoint[] = [];
  for (const line of out.split(/\r?\n/)) {
    const match = /\bTCP\s+(\S+)/.exec(line);
    if (!match) continue;
    const endpoint = parseEndpoint(match[1]);
    if (endpoint) found.push(endpoint);
  }
  return found;
};

/**
 * Ports the parent process listens on. The parent *is* the OpenChamber server
 * that spawned this service, so its listeners are the only ones worth dialling:
 * that keeps the scan inside our own process tree instead of the whole machine.
 */
const parentListenEndpoints = async (): Promise<ListenEndpoint[]> => {
  const pid = process.ppid;
  if (!Number.isInteger(pid) || pid <= 1) return [];
  if (process.platform === 'win32') {
    try {
      return await windowsListenEndpoints(pid);
    } catch {
      return [];
    }
  }
  try {
    return await ssListenEndpoints(pid);
  } catch {
    // `ss` belongs to iproute2 and is absent on macOS, which ships `lsof`.
  }
  try {
    return await lsofListenEndpoints(pid);
  } catch {
    return [];
  }
};

/**
 * What an origin answers on `/api/global/event`: `stream` when it is the event
 * stream, `refused` when the endpoint exists but rejects us (a 401/403 still
 * identifies the server, and a real stream error beats a dead connection),
 * `null` when it is not OpenChamber at all.
 */
const probeEventStream = async (origin: string, signal: AbortSignal): Promise<'stream' | 'refused' | null> => {
  try {
    const response = await fetch(new URL('/api/global/event', origin), {
      headers: { Accept: 'text/event-stream' },
      signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
      redirect: 'manual',
    });
    const body = response.body;
    if (body) void body.cancel().catch(() => undefined);
    if (response.status === 401 || response.status === 403) return 'refused';
    if (response.ok && (response.headers.get('content-type') ?? '').includes('text/event-stream')) return 'stream';
    return null;
  } catch {
    return null;
  }
};

/**
 * Find the server on this machine, for when the page's origin is a port
 * forward: its loopback exists only on the client, so the dial dies with
 * `fetch failed` while the real listener is one process away.
 */
const discoverServerOrigin = async (signal: AbortSignal): Promise<string | null> => {
  const now = Date.now();
  if (now - lastDiscoveryAt < DISCOVERY_INTERVAL_MS) return null;
  lastDiscoveryAt = now;
  let endpoints: ListenEndpoint[];
  try {
    endpoints = await parentListenEndpoints();
  } catch {
    return null;
  }
  let refused: string | null = null;
  for (const { host, port: candidate } of endpoints) {
    if (signal.aborted) return null;
    for (const scheme of ['http', 'https']) {
      const origin = toOrigin(scheme, host, candidate);
      const probe = await probeEventStream(origin, signal);
      if (probe === 'stream') {
        console.log(`[live-tps] event stream origin is ${origin}; the page's origin was unreachable here`);
        return origin;
      }
      if (probe === 'refused' && refused === null) refused = origin;
    }
  }
  return refused;
};

const scheduleReconnect = (message: string, kind: ErrorKind): void => {
  lastError = message;
  lastErrorKind = kind;
  connection = 'error';
  if (!watch || retryTimer) return;
  const delay = retryDelay;
  retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    beginStream();
  }, delay);
};

const startStream = async (tried: ReadonlySet<string> = new Set()): Promise<void> => {
  const current = watch;
  if (!current) return;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  controller?.abort();
  const local = new AbortController();
  controller = local;
  connection = 'connecting';
  lastError = null;
  lastErrorKind = null;

  // The page's origin is right whenever this process runs beside the server
  // that serves it, and stops being right behind a port forward. A previously
  // discovered origin goes first so a reconnect skips the known-dead dial.
  const seen = new Set(tried);
  const candidates = [serverOrigin, current.origin].filter(
    (origin): origin is string => origin !== null && origin.length > 0 && !seen.has(origin),
  );

  for (const origin of candidates) {
    seen.add(origin);
    let response: Response;
    try {
      // The global stream is not directory scoped. `/api/event` silently carries
      // only the server's default directory, which is why an open project would
      // never see its own session events there.
      response = await fetch(new URL('/api/global/event', origin), {
        headers: { Accept: 'text/event-stream' },
        signal: local.signal,
        redirect: 'manual',
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        const endpoints = await parentListenEndpoints();
        const headers = await localAuthHeaders(origin, new Set(endpoints.map((endpoint) => endpoint.port)), local.signal);
        if (local.signal.aborted) return;
        if (Object.keys(headers).length > 0) {
          response = await fetch(new URL('/api/global/event', origin), {
            headers: { Accept: 'text/event-stream', ...headers },
            signal: local.signal,
            redirect: 'manual',
          });
        }
      }
    } catch (error) {
      if (local.signal.aborted) return;
      lastError = error instanceof Error ? error.message : String(error);
      lastErrorKind = 'network';
      continue;
    }
    if (!response.ok || !response.body) {
      lastError = `Event stream answered HTTP ${response.status}`;
      lastErrorKind = 'http';
      await response.body?.cancel();
      continue;
    }
    connection = 'live';
    retryDelay = RETRY_BASE_MS;
    lastEventAt = Date.now();
    eventsSeen = 0;
    resetInFlight();

    try {
      const decoder = new TextDecoder();
      const reader = response.body.getReader();
      let buffer = '';
      while (!local.signal.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf('\n\n');
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          handleSseChunk(chunk);
          boundary = buffer.indexOf('\n\n');
        }
      }
      if (!local.signal.aborted) scheduleReconnect('Event stream closed', 'closed');
    } catch (error) {
      // A watch switch or shutdown aborts the reader; that is not a failure.
      if (local.signal.aborted) return;
      scheduleReconnect(error instanceof Error ? error.message : String(error), 'network');
    }
    return;
  }

  if (local.signal.aborted) return;
  // Nothing we know about is dialable from here: ask the machine, not the page.
  const discovered = await discoverServerOrigin(local.signal);
  if (local.signal.aborted) return;
  if (discovered && !seen.has(discovered)) {
    serverOrigin = discovered;
    await startStream(seen);
    return;
  }
  scheduleReconnect(lastError ?? 'Event stream unreachable', lastErrorKind ?? 'network');
};

/**
 * The only entry point: a rejection here would take the process down and leave
 * the panel with nothing to poll, so it lands in the same state the panel
 * already knows how to render.
 */
const beginStream = (): void => {
  void startStream().catch((error: unknown) => {
    scheduleReconnect(error instanceof Error ? error.message : String(error), 'network');
  });
};

const stopStream = (): void => {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  controller?.abort();
  controller = null;
  connection = 'idle';
};

const computeLive = (now: number): {
  tps: number;
  spanMs: number;
  chars: number;
  textChars: number;
  reasoningChars: number;
  toolChars: number;
} => {
  pruneSamples(now);
  if (samples.length === 0) {
    return { tps: 0, spanMs: 0, chars: 0, textChars: 0, reasoningChars: 0, toolChars: 0 };
  }
  // Divide by the span the samples actually cover, so the number is correct
  // as soon as streaming starts instead of climbing while the window fills.
  const spanMs = Math.max(1, Math.min(WINDOW_MS, now - samples[0].at));
  let chars = 0;
  let textChars = 0;
  let reasoningChars = 0;
  let toolChars = 0;
  for (const sample of samples) {
    chars += sample.chars;
    if (sample.kind === 'reasoning') reasoningChars += sample.chars;
    else if (sample.kind === 'tool') toolChars += sample.chars;
    else textChars += sample.chars;
  }
  return {
    // Not the headline, but a published field: a window whose samples all
    // landed in the same millisecond would otherwise report the same broken
    // rate the estimate path used to.
    tps: Math.min(estimateTokens(chars) / (spanMs / 1000), MAX_PLAUSIBLE_TOKENS_PER_SECOND),
    spanMs,
    chars,
    textChars,
    reasoningChars,
    toolChars,
  };
};

/** Live curve: per-bucket rates over the window, oldest first. */
const liveBuckets = (now: number): number[] => {
  pruneSamples(now);
  if (samples.length === 0) return [];
  const width = WINDOW_MS / CURVE_BUCKETS;
  const oldest = now - WINDOW_MS;
  const out: number[] = [];
  for (let b = 0; b < CURVE_BUCKETS; b += 1) {
    const from = oldest + b * width;
    const to = from + width;
    let chars = 0;
    for (const sample of samples) {
      if (sample.at < from || sample.at >= to) continue;
      chars += sample.chars;
    }
    if (chars === 0) {
      out.push(0);
      continue;
    }
    // A bucket is a fixed slice of the window, so its rate is what it holds
    // across its own width. Measuring the span the samples covered read a
    // bucket holding one chunk as that chunk over 1 ms, and sparkPaths
    // normalizes by the largest point, so a single such bucket flattened every
    // other point on the curve.
    out.push(Math.min(estimateTokens(chars) / (width / 1000), MAX_PLAUSIBLE_TOKENS_PER_SECOND));
  }
  // Trim leading silence so a fresh turn starts drawing immediately.
  let lead = 0;
  while (lead < out.length && out[lead] <= 0) lead += 1;
  return out.slice(lead);
};

/**
 * The drawn curve, oldest first: finished turns while idle, recent turns plus
 * the live window while streaming. Owned by the service so it survives iframe
 * remounts and session switches.
 */
const computeCurve = (now: number): number[] => {
  const past = turns.slice(-16).map((t) => t.tps);
  if (!busy || waitingKind() !== null) return past;
  const live = liveBuckets(now).filter((v) => v > 0);
  if (live.length === 0) return past;
  return [...past.slice(-8), ...live].slice(-(CURVE_BUCKETS * 2));
};

const isHttpOrigin = (value: string): boolean => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === 'http:' || parsed.protocol === 'https:')
      && parsed.username === ''
      && parsed.password === '';
  } catch {
    return false;
  }
};

/**
 * Record what a page asked to watch.
 *
 * Registering a session never touches the measurement: its record either
 * already exists or starts empty, and nothing belonging to another session is
 * reset or dropped. Only a change of origin restarts the stream — the endpoint
 * is the server's global one, so swapping sessions needs no reconnect, and
 * reconnecting on every watch is what used to tear down a connection another
 * page was relying on.
 */
const applyWatch = (next: WatchConfig): boolean => {
  const originChanged = watch === null || watch.origin !== next.origin;
  // A new page origin is a new host: whatever we learned about the old one's
  // loopback says nothing about this one.
  if (originChanged) serverOrigin = null;
  watch = next;
  if (next.sessionId) {
    watched.add(next.sessionId);
    trackSession(next.sessionId);
  }
  if (!originChanged) return false;
  retryDelay = RETRY_BASE_MS;
  stopStream();
  beginStream();
  return true;
};

const json = (res: http.ServerResponse, status: number, body: unknown): void => {
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(body));
};

const readJsonBody = (req: http.IncomingMessage): Promise<unknown> => new Promise((resolve, reject) => {
  let body = '';
  req.on('data', (chunk: Buffer) => {
    body += chunk;
    if (body.length > 64_000) {
      reject(new Error('Request body too large'));
      req.destroy();
    }
  });
  req.on('end', () => {
    if (!body.trim()) {
      resolve(null);
      return;
    }
    try {
      resolve(JSON.parse(body));
    } catch {
      reject(new Error('Request body is not valid JSON'));
    }
  });
  req.on('error', reject);
});

const server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: 'unauthorized' });
    return;
  }

  const url = new URL(req.url ?? '/', 'http://127.0.0.1');

  if (url.pathname === '/health') {
    json(res, 200, { ok: true, pid: process.pid });
    return;
  }

  if (url.pathname === '/watch' && req.method === 'POST') {
    void readJsonBody(req).then((raw) => {
      const body = (raw && typeof raw === 'object' ? raw : {}) as { origin?: unknown; sessionId?: unknown };
      const origin = readString(body.origin);
      if (!isHttpOrigin(origin)) {
        json(res, 400, { error: 'origin must be an http(s) origin from the OpenChamber server' });
        return;
      }
      const sessionId = typeof body.sessionId === 'string' && body.sessionId.trim() ? body.sessionId : null;
      // `changed` still means "you were not already set up for this": a new
      // session counts, an origin switch counts, a repeat does not. It no
      // longer implies the stream was rebuilt — only an origin change does.
      const fresh = sessionId !== null && !watched.has(sessionId);
      const changed = applyWatch({ origin, sessionId }) || fresh;
      json(res, 200, { ok: true, changed, connection, sessionId });
    }).catch((error: unknown) => {
      json(res, 400, { error: error instanceof Error ? error.message : 'Invalid request' });
    });
    return;
  }

  if (url.pathname === '/rate') {
    const now = Date.now();
    // A page names its own session so two pages watching different sessions
    // each read their own record. Without the parameter the most recent watch
    // answers, which is what a one-page install has always seen.
    const requested = readString(url.searchParams.get('sessionId')) || watch?.sessionId || null;
    if (requested !== null) enterSession(requested);
    let body: Record<string, unknown>;
    try {
      body = {
        connection,
        error: lastError,
        errorKind: lastErrorKind,
        // Nothing has watched this session in this process, so say so and the
        // page re-asserts — that is how a service that just came back up gets
        // its stream started again. The numbers are still answered from disk,
        // so the panel shows last turn straight away instead of going blank.
        sessionId: requested !== null && watched.has(requested) ? requested : null,
        busy,
        waiting: waitingKind(),
        toolActive: toolActive(),
        live: computeLive(now),
        running: turnStartedAt !== null ? computeRunning() : null,
        curve: computeCurve(now),
        turn: {
          active: turnStartedAt !== null,
          ttftMs: liveTtftMs(),
        },
        lastTurn,
        eventsSeen,
      };
    } finally {
      if (requested !== null) leaveSession();
    }
    json(res, 200, body);
    return;
  }

  json(res, 404, { error: 'not-found' });
});

readPersisted();
server.listen(port, '127.0.0.1');

const shutdown = (): void => {
  flushPersist();
  stopStream();
  server.close(() => process.exit(0));
};
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
