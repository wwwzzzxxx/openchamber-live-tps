/**
 * The daily-token ledger behind Live TPS.
 *
 * Usage arrives on the same OpenChamber event stream the TPS side listens to:
 * `session.step.ended` / `session.step.failed` settle with the provider's
 * `tokens` and `cost` after every model call, so the day is kept current
 * without polling an API. This module owns the aggregate, its history
 * catch-up, and its persistence; it knows nothing about HTTP or the host.
 *
 * History is read only when it must be:
 * - the first run of a day (or a state file from an older schema) reads that
 *   day once;
 * - every later start, and every stream reconnect, reads only messages newer
 *   than each session's saved cursor;
 * - nothing scans on a timer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { dayKeyLocal, dayStartLocal } from '../shared/day';
import type { DayModelRow, DayPayload, DaySessionRow, DayTotals } from '../shared/day';

/** Safety caps so a pathological account cannot keep one catch-up running forever. */
const MAX_SESSION_PAGES = 40;
const MAX_MESSAGE_PAGES = 80;
/** Concurrent session reads; each answer is a 100-message page on loopback. */
const PARALLEL_SESSIONS = 4;
const REQUEST_TIMEOUT_MS = 15_000;
/** Coalesce a burst of changes into one push; the host allows 30/s. */
const EMIT_DEBOUNCE_MS = 120;
/** Coalesce state writes so a busy turn is not disk traffic. */
const PERSIST_DEBOUNCE_MS = 1_000;

type RawEvent = { type?: unknown; data?: unknown; properties?: unknown; created?: unknown };

type SessionInfo = { id: string; title: string; updated: number };

type SessionAgg = {
  title: string;
  updated: number;
  total: number;
  output: number;
  messages: number;
  /** Newest message id this session has been read through; new messages are above it. */
  headId: string | null;
  /** Last model seen in the session, used when a step start was missed. */
  modelKey: string | null;
};

type Contribution = {
  sessionId: string;
  modelKey: string;
  hour: number;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  cost: number;
};

type StateV2 = {
  version: 2;
  day: string;
  dayStart: number;
  updatedAt: number;
  totals: DayTotals;
  hours: number[];
  models: Record<string, DayModelRow>;
  sessions: Record<string, SessionAgg>;
  /** One entry per counted assistant message, so a re-settled step replaces its old value. */
  contributions: Record<string, Contribution>;
};

export type DayLedgerDeps = {
  /** File this ledger persists to. */
  statePath: () => string;
  /** The OpenChamber server to read history from, when known. */
  origin: () => string | null;
  /** Request headers for that server. */
  headers: () => Record<string, string>;
  /** Push a snapshot to the extension's frames. */
  emit: (payload: DayPayload) => void;
};

export type DayLedger = {
  /** Feed one stream event. Every session counts, watched or not. */
  observe: (type: string, event: RawEvent, now: number) => void;
  /** Read whatever today's state does not know yet. */
  catchUp: (options: { full: boolean }) => Promise<void>;
  /** Current snapshot for a frame that just mounted. */
  snapshot: (now: number) => DayPayload;
  /** Forget today's state and read it once more. */
  rebuild: () => void;
  /** Write the debounced state now. */
  flush: () => void;
};

const zero = (): DayTotals => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  cost: 0,
  messages: 0,
});

const num = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

const record = (v: unknown): Record<string, unknown> | null =>
  v !== null && typeof v === 'object' && !Array.isArray(v) ? v as Record<string, unknown> : null;

const readString = (value: unknown): string => (typeof value === 'string' ? value : '');

const modelKeyFrom = (providerId: unknown, modelId: unknown): string | null => {
  const id = typeof modelId === 'string' && modelId ? modelId : '';
  if (!id) return null;
  const provider = typeof providerId === 'string' && providerId ? providerId : 'unknown';
  return `${provider}/${id}`;
};

const modelKeyOf = (message: Record<string, unknown>): string | null => {
  const model = record(message.model);
  return modelKeyFrom(model?.providerID, model?.id);
};

export const createDayLedger = (deps: DayLedgerDeps): DayLedger => {
  let state: StateV2 | null = null;
  let partial = false;
  let lastError: string | null = null;
  let syncing: Promise<void> | null = null;
  let reconcileQueued = false;
  /** Whether the saved day has had its catch-up; repeated calls do not re-run it. */
  let caughtUp = false;
  let persistTimer: NodeJS.Timeout | null = null;
  let emitTimer: NodeJS.Timeout | null = null;
  let lastEmitAt = 0;
  const messageModels = new Map<string, string>();
  const MESSAGE_MODEL_CAP = 2_000;

  const blankState = (now: number): StateV2 => ({
    version: 2,
    day: dayKeyLocal(now),
    dayStart: dayStartLocal(now),
    updatedAt: now,
    totals: zero(),
    hours: new Array<number>(24).fill(0),
    models: {},
    sessions: {},
    contributions: {},
  });

  const readPersisted = (now: number): StateV2 | null => {
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(deps.statePath(), 'utf8'));
      const rec = record(raw);
      const payload = record(rec?.payload);
      if (rec?.version !== 2 || !payload) return null;
      const saved = payload as unknown as StateV2;
      if (saved.day !== dayKeyLocal(now) || saved.dayStart !== dayStartLocal(now)) return null;
      if (!saved.totals || !Array.isArray(saved.hours) || !saved.models || !saved.sessions || !saved.contributions) {
        return null;
      }
      return saved;
    } catch {
      return null;
    }
  };

  const writePersisted = (): void => {
    if (!state) return;
    const file = deps.statePath();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 2, payload: state }));
      fs.renameSync(tmp, file);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {
        // Nothing to clean up.
      }
    }
  };

  const schedulePersist = (): void => {
    if (persistTimer) return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      writePersisted();
    }, PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
  };

  const flush = (): void => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    writePersisted();
  };

  const ensureState = (now: number): { state: StateV2; fresh: boolean } => {
    let fresh = false;
    if (!state || state.day !== dayKeyLocal(now) || state.dayStart !== dayStartLocal(now)) {
      state = blankState(now);
      fresh = true;
      partial = false;
      caughtUp = false;
    }
    return { state, fresh };
  };

  const ensureSession = (s: StateV2, id: string, title: string, updated: number): SessionAgg => {
    let row = s.sessions[id];
    if (!row) {
      row = { title: title || id, updated, total: 0, output: 0, messages: 0, headId: null, modelKey: null };
      s.sessions[id] = row;
    } else {
      if (title) row.title = title;
      if (updated > row.updated) row.updated = updated;
    }
    return row;
  };

  /** Add a contribution to every aggregate it touches. */
  const addContribution = (s: StateV2, contribution: Contribution): void => {
    s.totals.input += contribution.input;
    s.totals.output += contribution.output;
    s.totals.reasoning += contribution.reasoning;
    s.totals.cacheRead += contribution.cacheRead;
    s.totals.cacheWrite += contribution.cacheWrite;
    s.totals.total += contribution.total;
    s.totals.cost += contribution.cost;
    s.totals.messages += 1;

    s.hours[contribution.hour] += contribution.total;

    const session = s.sessions[contribution.sessionId];
    if (session) {
      session.total += contribution.total;
      session.output += contribution.output;
      session.messages += 1;
    }

    let model = s.models[contribution.modelKey];
    if (!model) {
      const slash = contribution.modelKey.indexOf('/');
      model = {
        key: contribution.modelKey,
        provider: slash >= 0 ? contribution.modelKey.slice(0, slash) : 'unknown',
        model: slash >= 0 ? contribution.modelKey.slice(slash + 1) : contribution.modelKey,
        total: 0,
        output: 0,
        messages: 0,
      };
      s.models[contribution.modelKey] = model;
    }
    model.total += contribution.total;
    model.output += contribution.output;
    model.messages += 1;
  };

  /** Take one contribution back out, so a re-settled message replaces its old value. */
  const removeContribution = (s: StateV2, contribution: Contribution): void => {
    s.totals.input = Math.max(0, s.totals.input - contribution.input);
    s.totals.output = Math.max(0, s.totals.output - contribution.output);
    s.totals.reasoning = Math.max(0, s.totals.reasoning - contribution.reasoning);
    s.totals.cacheRead = Math.max(0, s.totals.cacheRead - contribution.cacheRead);
    s.totals.cacheWrite = Math.max(0, s.totals.cacheWrite - contribution.cacheWrite);
    s.totals.total = Math.max(0, s.totals.total - contribution.total);
    s.totals.cost = Math.max(0, s.totals.cost - contribution.cost);
    s.totals.messages = Math.max(0, s.totals.messages - 1);

    s.hours[contribution.hour] = Math.max(0, s.hours[contribution.hour] - contribution.total);

    const session = s.sessions[contribution.sessionId];
    if (session) {
      session.total = Math.max(0, session.total - contribution.total);
      session.output = Math.max(0, session.output - contribution.output);
      session.messages = Math.max(0, session.messages - 1);
    }

    const model = s.models[contribution.modelKey];
    if (model) {
      model.total = Math.max(0, model.total - contribution.total);
      model.output = Math.max(0, model.output - contribution.output);
      model.messages = Math.max(0, model.messages - 1);
      if (model.messages === 0) delete s.models[contribution.modelKey];
    }
  };

  const contributionOf = (
    sessionId: string,
    tokens: Record<string, unknown>,
    cost: number,
    at: number,
    dayStart: number,
    modelKey: string,
  ): Contribution | null => {
    const input = num(tokens.input);
    const output = num(tokens.output);
    const reasoning = num(tokens.reasoning);
    const cache = record(tokens.cache);
    const cacheRead = num(cache?.read);
    const cacheWrite = num(cache?.write);
    const total = input + output + reasoning + cacheRead + cacheWrite;
    if (total <= 0) return null;
    const hour = Math.min(23, Math.max(0, Math.floor((at - dayStart) / 3_600_000)));
    return { sessionId, modelKey, hour, input, output, reasoning, cacheRead, cacheWrite, total, cost };
  };

  /**
   * Count one assistant message. A message that was already counted (a
   * re-settled retry, or a catch-up overlapping a stream event) replaces its
   * earlier value instead of adding a second time.
   */
  const applyMessage = (
    s: StateV2,
    messageId: string,
    sessionId: string,
    tokens: Record<string, unknown>,
    cost: number,
    at: number,
    modelKey: string,
  ): boolean => {
    const contribution = contributionOf(sessionId, tokens, cost, at, s.dayStart, modelKey);
    if (!contribution) return false;
    const previous = s.contributions[messageId];
    if (previous) removeContribution(s, previous);
    s.contributions[messageId] = contribution;
    addContribution(s, contribution);
    return true;
  };

  const payloadOf = (now: number): DayPayload => {
    const current = state;
    const fresh = !!current && current.day === dayKeyLocal(now) && current.dayStart === dayStartLocal(now);
    if (!current || !fresh) {
      return {
        ok: false,
        day: dayKeyLocal(now),
        dayStart: dayStartLocal(now),
        updatedAt: now,
        refreshing: syncing !== null,
        stale: true,
        error: lastError,
        today: zero(),
        hours: new Array<number>(24).fill(0),
        models: [],
        sessions: [],
        scan: { sessions: 0, messages: 0, partial: false },
      };
    }
    const models = Object.values(current.models).sort((a, b) => b.total - a.total).slice(0, 8);
    const sessions: DaySessionRow[] = Object.entries(current.sessions)
      .filter(([, row]) => row.messages > 0)
      .map(([id, row]) => ({
        id,
        title: row.title || id,
        total: row.total,
        output: row.output,
        messages: row.messages,
      }))
      .sort((a, b) => b.total - a.total)
      .slice(0, 8);
    return {
      ok: true,
      day: current.day,
      dayStart: current.dayStart,
      updatedAt: current.updatedAt,
      refreshing: syncing !== null,
      stale: false,
      error: lastError,
      today: { ...current.totals },
      hours: [...current.hours],
      models,
      sessions,
      scan: {
        sessions: Object.keys(current.sessions).length,
        messages: current.totals.messages,
        partial,
      },
    };
  };

  /** Push the current snapshot to every mounted frame; coalesced for bursts. */
  const scheduleEmit = (): void => {
    if (emitTimer) return;
    const wait = lastEmitAt === 0 ? 0 : Math.max(0, EMIT_DEBOUNCE_MS - (Date.now() - lastEmitAt));
    emitTimer = setTimeout(() => {
      emitTimer = null;
      lastEmitAt = Date.now();
      deps.emit(payloadOf(Date.now()));
    }, wait);
    emitTimer.unref?.();
  };

  // --- history catch-up: the only time history is read -------------------------

  const requestJson = async (origin: string, pathAndQuery: string): Promise<Record<string, unknown>> => {
    const response = await fetch(new URL(pathAndQuery, origin), {
      headers: deps.headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} for ${pathAndQuery}`);
    const body: unknown = await response.json();
    const rec = record(body);
    if (!rec) throw new Error(`Bad JSON from ${pathAndQuery}`);
    return rec;
  };

  /**
   * Sessions the API reports as updated since local midnight.
   *
   * The list is newest-first; a page whose oldest entry is already yesterday
   * means no later page can hold a session active today, so the walk stops there.
   */
  const listActiveSessions = async (origin: string, dayStart: number): Promise<SessionInfo[]> => {
    const out: SessionInfo[] = [];
    let cursor: string | null = null;
    for (let page = 0; page < MAX_SESSION_PAGES; page += 1) {
      const query = `/api/session?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
      const answer = await requestJson(origin, query);
      const data = Array.isArray(answer.data) ? answer.data : [];
      let oldest = Number.POSITIVE_INFINITY;
      for (const raw of data) {
        const session = record(raw);
        if (!session) continue;
        const id = typeof session.id === 'string' ? session.id : '';
        if (!id) continue;
        const updated = num(record(session.time)?.updated) || num(record(session.time)?.created);
        if (updated < oldest) oldest = updated;
        if (updated < dayStart) continue;
        out.push({
          id,
          title: typeof session.title === 'string' ? session.title : id,
          updated,
        });
      }
      const cursorValue = record(answer.cursor)?.next;
      cursor = typeof cursorValue === 'string' && cursorValue ? cursorValue : null;
      if (!cursor || data.length === 0 || oldest < dayStart) break;
    }
    return out;
  };

  const messagePage = async (
    origin: string,
    sessionId: string,
    cursor: string | null,
  ): Promise<{ data: Record<string, unknown>[]; next: string | null }> => {
    const query = `/api/session/${encodeURIComponent(sessionId)}/message?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
    const answer = await requestJson(origin, query);
    const data = (Array.isArray(answer.data) ? answer.data : [])
      .filter((raw): raw is Record<string, unknown> => record(raw) !== null);
    const nextValue = record(answer.cursor)?.next;
    return {
      data,
      next: typeof nextValue === 'string' && nextValue ? nextValue : null,
    };
  };

  /**
   * Read one session forward from its cursor. With no cursor (a new session,
   * or the first run of the day) this walks back to local midnight; otherwise
   * it stops at the newest message the state already knows, so only messages
   * that arrived while the stream was down are read.
   */
  const syncSession = async (
    origin: string,
    session: SessionAgg,
    sessionId: string,
    s: StateV2,
  ): Promise<void> => {
    const headId = session.headId;
    let newestModel: string | null = null;
    let cursor: string | null = null;
    for (let page = 0; page < MAX_MESSAGE_PAGES; page += 1) {
      const answer = await messagePage(origin, sessionId, cursor);
      let stop = false;
      let oldest = Number.POSITIVE_INFINITY;
      for (const message of answer.data) {
        const id = typeof message.id === 'string' ? message.id : '';
        if (headId && id === headId) {
          stop = true;
          break;
        }
        const time = record(message.time);
        const created = num(time?.created);
        if (created < oldest) oldest = created;
        if (message.type !== 'assistant') continue;
        const at = num(time?.completed) || created;
        if (at < s.dayStart) continue;
        const tokens = record(message.tokens);
        if (!tokens) continue;
        const modelKey = modelKeyOf(message) ?? session.modelKey ?? 'unknown/unknown';
        if (newestModel === null) newestModel = modelKey;
        applyMessage(s, id, sessionId, tokens, num(message.cost), at, modelKey);
      }
      if (page === 0 && answer.data.length > 0) {
        // Move the cursor to the newest message that is settled. A streaming
        // assistant message must stay above the cursor so a missed
        // `step.ended` is still readable on the next catch-up; the cursor
        // therefore falls to the message below the first unsettled assistant.
        let candidate: string | null = null;
        let settled = true;
        for (let i = 0; i < answer.data.length; i += 1) {
          const message = answer.data[i];
          const completed = num(record(message.time)?.completed);
          if (message.type === 'assistant' && completed <= 0) {
            settled = false;
            const below = answer.data[i + 1];
            candidate = below && typeof below.id === 'string' ? below.id : null;
            break;
          }
        }
        if (settled) {
          const top = answer.data[0];
          candidate = top && typeof top.id === 'string' ? top.id : null;
        }
        if (candidate) session.headId = candidate;
      }
      if (stop || answer.next === null || answer.data.length === 0 || oldest < s.dayStart) break;
      cursor = answer.next;
    }
    // The newest message wins: falling back to the oldest would label a mid-step
    // stream event with a model the session stopped using.
    if (newestModel !== null) session.modelKey = newestModel;
  };

  /**
   * Bring the saved state up to date with the server. `full` is true only when
   * there is no usable history for today; otherwise each session is read from
   * its cursor.
   */
  const reconcile = (origin: string, { full }: { full: boolean }): Promise<void> => {
    if (syncing) {
      reconcileQueued = true;
      return syncing;
    }
    syncing = (async () => {
      const now = Date.now();
      const { state: current, fresh } = ensureState(now);
      const mustReadAll = full || fresh;
      const sessions = await listActiveSessions(origin, current.dayStart);
      let failed = false;

      const queue = sessions.slice();
      const worker = async (): Promise<void> => {
        while (queue.length > 0) {
          const session = queue.shift();
          if (!session) return;
          const previousUpdated = current.sessions[session.id]?.updated ?? 0;
          const row = ensureSession(current, session.id, session.title, session.updated);
          const needsRead = mustReadAll
            || row.headId === null
            || session.updated > previousUpdated
            // A partial earlier catch-up leaves a session half-read; read it again.
            || partial;
          if (!needsRead) continue;
          try {
            await syncSession(origin, row, session.id, current);
            row.updated = session.updated;
          } catch {
            failed = true;
          }
        }
      };
      const workers = Math.min(PARALLEL_SESSIONS, Math.max(1, sessions.length));
      await Promise.all(Array.from({ length: workers }, () => worker()));

      if (failed) {
        partial = true;
        lastError = 'some sessions could not be read';
      } else {
        partial = false;
        lastError = null;
        caughtUp = true;
      }
      current.updatedAt = Date.now();
      // A catch-up is rare (start, reconnect, day change): write it through now
      // so a restart immediately after has the cursor. Per-step changes stay
      // debounced.
      flush();
      scheduleEmit();
    })()
      .catch((error: unknown) => {
        caughtUp = false;
        partial = true;
        lastError = error instanceof Error ? error.message : 'unable to read usage';
        scheduleEmit();
      })
      .finally(() => {
        syncing = null;
        if (reconcileQueued) {
          reconcileQueued = false;
          const origin = deps.origin();
          if (origin) void reconcile(origin, { full: false });
        }
      });
    return syncing;
  };

  const rememberModel = (messageId: string, key: string): void => {
    if (!messageId || !key) return;
    messageModels.set(messageId, key);
    while (messageModels.size > MESSAGE_MODEL_CAP) {
      const oldest = messageModels.keys().next();
      if (oldest.done) break;
      messageModels.delete(oldest.value);
    }
  };

  // --- stream events ------------------------------------------------------------

  const observe = (type: string, event: RawEvent, now: number): void => {
    const payload = record(event.data) ?? record(event.properties);
    if (!payload) return;
    const sessionId = readString(payload.sessionID);
    if (!sessionId) return;

    if (type === 'session.created' || type === 'session.updated') {
      const info = record(payload.info);
      if (!info) return;
      const id = readString(info.id) || sessionId;
      const { state: current } = ensureState(now);
      ensureSession(current, id, readString(info.title), num(record(info.time)?.updated) || now);
      current.updatedAt = now;
      schedulePersist();
      scheduleEmit();
      return;
    }

    if (type === 'session.deleted') {
      const { state: current } = ensureState(now);
      const row = current.sessions[sessionId];
      if (!row) return;
      delete current.sessions[sessionId];
      for (const [messageId, contribution] of Object.entries(current.contributions)) {
        if (contribution.sessionId !== sessionId) continue;
        removeContribution(current, contribution);
        delete current.contributions[messageId];
      }
      current.updatedAt = now;
      schedulePersist();
      scheduleEmit();
      return;
    }

    if (type === 'session.step.started') {
      const messageId = readString(payload.assistantMessageID);
      if (!messageId) return;
      const model = record(payload.model);
      const key = modelKeyFrom(
        readString(payload.providerID) || readString(model?.providerID),
        readString(payload.modelID) || readString(model?.id) || readString(model?.modelID),
      );
      if (key) rememberModel(messageId, key);
      return;
    }

    if (type === 'session.step.ended' || type === 'session.step.failed') {
      const messageId = readString(payload.assistantMessageID);
      const tokens = record(payload.tokens);
      if (!messageId || !tokens) return;
      const { state: current } = ensureState(now);
      const at = num(event.created) || now;
      if (at < current.dayStart) return;
      const session = ensureSession(current, sessionId, '', at);
      const modelKey = messageModels.get(messageId)
        ?? session.modelKey
        ?? current.contributions[messageId]?.modelKey
        ?? 'unknown/unknown';
      session.modelKey = modelKey;
      const added = applyMessage(current, messageId, sessionId, tokens, num(payload.cost), at, modelKey);
      if (!added) return;
      if (!session.headId) session.headId = messageId;
      current.updatedAt = now;
      lastError = null;
      schedulePersist();
      scheduleEmit();
    }
  };

  const catchUp = (options: { full: boolean }): Promise<void> => {
    const origin = deps.origin();
    if (!origin) return Promise.resolve();
    return reconcile(origin, { full: options.full });
  };

  const rebuild = (): void => {
    state = null;
    caughtUp = false;
    partial = false;
    lastError = null;
    void catchUp({ full: true });
  };

  // Restore today's file once, then let the first catch-up decide whether
  // history is read fully or only from the saved cursors.
  const restored = readPersisted(Date.now());
  if (restored) {
    state = restored;
    caughtUp = false;
  }

  return {
    observe,
    catchUp,
    snapshot: (now: number) => payloadOf(now),
    rebuild,
    flush,
  };
};
