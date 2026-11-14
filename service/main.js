// service/main.ts
import http from "node:http";
import fs3 from "node:fs";
import os from "node:os";
import path2 from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
// node_modules/@openchamber/sdk/dist/scrollbar-style.js
var GUEST_SCROLLING_ATTRIBUTE = "data-oc-scrolling";
var GUEST_SCROLLBAR_CSS = `
:root {
  /* Quiet at rest like the app's own thumbs; hover gives a clear grab target. */
  --oc-scrollbar-thumb: color-mix(in srgb, var(--oc-muted, currentColor) 18%, transparent);
  --oc-scrollbar-thumb-hover: color-mix(in srgb, var(--oc-muted, currentColor) 36%, transparent);
  scrollbar-gutter: stable;
}
* {
  scrollbar-width: thin;
  scrollbar-color: transparent transparent;
}
:hover, [${GUEST_SCROLLING_ATTRIBUTE}] {
  scrollbar-color: var(--oc-scrollbar-thumb) transparent;
}
/* Chromium's standard scrollbar properties otherwise override its pseudo-elements. */
@supports selector(::-webkit-scrollbar) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-width: auto; scrollbar-color: auto; }
  ::-webkit-scrollbar { width: 6px; height: 6px; background: transparent; }
  ::-webkit-scrollbar-track { background: transparent; }
  ::-webkit-scrollbar-thumb {
    background: transparent;
    border-radius: 999px;
    min-width: 24px;
    min-height: 24px;
  }
  :hover::-webkit-scrollbar-thumb, [${GUEST_SCROLLING_ATTRIBUTE}]::-webkit-scrollbar-thumb { background: var(--oc-scrollbar-thumb); }
  ::-webkit-scrollbar-thumb:hover { background: var(--oc-scrollbar-thumb-hover); }
  ::-webkit-scrollbar-corner { background: transparent; }
  ::-webkit-scrollbar-button { display: none; width: 0; height: 0; }
}
@media (forced-colors: active) {
  *, :hover, [${GUEST_SCROLLING_ATTRIBUTE}] { scrollbar-color: auto; }
  ::-webkit-scrollbar-thumb, ::-webkit-scrollbar-thumb:hover { background: CanvasText; }
}
`;
function installGuestScrollbarActivity(doc) {
  const root = doc.documentElement;
  if (root.hasAttribute("data-oc-scrollbar-activity"))
    return;
  root.setAttribute("data-oc-scrollbar-activity", "");
  const timers = new WeakMap;
  doc.addEventListener("scroll", (event) => {
    const target = event.target === doc ? root : event.target;
    if (!(target instanceof Element))
      return;
    if (!target.hasAttribute("data-oc-scrolling"))
      target.setAttribute("data-oc-scrolling", "");
    const pending = timers.get(target);
    if (pending !== undefined)
      clearTimeout(pending);
    timers.set(target, setTimeout(() => {
      timers.delete(target);
      target.removeAttribute("data-oc-scrolling");
    }, 1000));
  }, { capture: true, passive: true });
}
var GUEST_SCROLLBAR_SCRIPT = `(${installGuestScrollbarActivity.toString()})(document);`;
// node_modules/@openchamber/sdk/dist/manifest.js
var TRACKER_URL_TOKENS = ["{id}", "{segment}", "{segments+}"];
var TRACKER_URL_TOKEN_SET = new Set(TRACKER_URL_TOKENS);
// node_modules/@openchamber/sdk/dist/session-events.js
var GUEST_SESSION_EVENT_TYPES = [
  "turn-finished",
  "turn-failed",
  "permission-asked",
  "question-asked",
  "turn-started",
  "session-created",
  "session-archived",
  "session-deleted"
];
var SESSION_EVENTS_IDLE_MS = 10 * 60000;
var EVENT_TYPES = new Set(GUEST_SESSION_EVENT_TYPES);
// node_modules/@openchamber/sdk/dist/service-host.js
var SERVICE_HOST_PATH = "/service/call";
var OPENCHAMBER_HOST_CALLBACK_URL_ENV = "OPENCHAMBER_HOST_CALLBACK_URL";
var SERVICE_HOST_TIMEOUT_MS = 30000;
var SERVICE_SCHEDULE_IDLE_MS = 10 * 60000;
var MENTIONS_IDLE_MS = 10 * 60000;
class ServiceHostError extends Error {
  code;
  status;
  constructor(message, code, status) {
    super(message);
    this.name = "ServiceHostError";
    this.code = code;
    this.status = status;
  }
}
var createServiceHost = ({ env }) => {
  const call = async (method, input) => {
    const base = env[OPENCHAMBER_HOST_CALLBACK_URL_ENV];
    const token = env.OPENCHAMBER_SERVICE_TOKEN;
    if (!base || !token)
      throw new ServiceHostError("This service was not started by OpenChamber.", "HOST_UNAVAILABLE", 0);
    let response;
    try {
      response = await fetch(`${base.replace(/\/+$/, "")}${SERVICE_HOST_PATH}`, {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        body: JSON.stringify({ method, input }),
        signal: AbortSignal.timeout(SERVICE_HOST_TIMEOUT_MS)
      });
    } catch {
      throw new ServiceHostError("OpenChamber did not answer.", "HOST_UNAVAILABLE", 0);
    }
    const body = await response.json().catch(() => null);
    if (response.ok && body?.result !== undefined)
      return body.result;
    throw new ServiceHostError(body?.error?.message ?? `OpenChamber answered HTTP ${response.status}.`, body?.error?.code ?? "HOST_UNAVAILABLE", response.status);
  };
  return {
    sessions: {
      start: (input) => call("sessions.start", input),
      send: (sessionId, prompt) => call("sessions.send", { sessionId, prompt }),
      retry: (sessionId) => call("sessions.retry", { sessionId }),
      status: (sessionId) => call("sessions.status", { sessionId }),
      lastReply: (sessionId) => call("sessions.lastReply", { sessionId }),
      stop: (sessionId) => call("sessions.stop", { sessionId }),
      answerPermission: (sessionId, requestId, answer) => call("sessions.answerPermission", { sessionId, requestId, ...answer }),
      answerForm: (sessionId, formId, values, message) => call("sessions.answerForm", { sessionId, formId, values, ...message === undefined ? {} : { message } })
    },
    setInstructions: (directory, text) => call("instructions.set", { directory, text }),
    emit: (topic, data) => call("panels.emit", { topic, data }),
    readSettings: () => call("settings.read", {}).then(({ settings }) => settings),
    needsConfiguration: (message) => call("status.set", { needsConfiguration: message })
  };
};
// node_modules/@openchamber/sdk/dist/file-editor.js
var patternExpressions = new Map;
// node_modules/@openchamber/sdk/dist/contract.js
var GUEST_FILE_STAT_KINDS = ["file", "directory", "other", "missing"];
var GUEST_GENERATE_LATE_KEEP_MS = 60 * 60000;
var HOST_REQUEST_ERROR_CODES = [
  "HOST_UNAVAILABLE",
  "HOST_TIMEOUT",
  "HOST_REJECTED",
  "DISCONNECTED",
  "DISABLED",
  "BAD_PATH",
  "NO_INTEGRATION",
  "NO_SERVICE",
  "SERVICE_FAILED",
  "REQUEST_FAILED",
  "RESPONSE_TOO_LARGE",
  "NO_SESSION",
  "SESSION_BUSY",
  "NOT_GRANTED",
  "NO_DIRECTORY",
  "NOT_FOUND",
  "FILE_TOO_LARGE",
  "DENIED",
  "NO_MODEL",
  "MODEL_FAILED",
  "UNSUPPORTED"
];
var SERVICE_STATUS_VALUES = ["stopped", "starting", "ready", "failed"];
var hostRequestErrorCodeSet = new Set(HOST_REQUEST_ERROR_CODES);
var serviceStatusSet = new Set(SERVICE_STATUS_VALUES);
var fileStatKindSet = new Set(GUEST_FILE_STAT_KINDS);
var HOST_PUSH_TYPES = new Set([
  "workspace",
  "shells",
  "ready",
  "directory",
  "session",
  "connection",
  "settings",
  "session-lifecycle",
  "item",
  "resolve",
  "action",
  "service-event",
  "status-control-event",
  "popover-closed",
  "file-open",
  "file-snapshot",
  "file-saved",
  "generate-late"
]);
// node_modules/@openchamber/sdk/dist/service-providers.js
var BROWSER_CONTROL_ACTIONS = [
  "browser.open",
  "browser.snapshot",
  "browser.click",
  "browser.type",
  "browser.select",
  "browser.scroll",
  "browser.back",
  "browser.forward",
  "browser.inspect",
  "browser.capture",
  "browser.resize",
  "browser.close"
];
var BROWSER_PROVIDER_IDLE_MS = 10 * 60000;
var CONTROL_ACTIONS = new Set(BROWSER_CONTROL_ACTIONS);
var SOURCE_CONTROL_PROVIDER_IDLE_MS = 10 * 60000;
var NOTIFICATIONS_PROVIDER_IDLE_MS = 10 * 60000;
var TRACKER_PROVIDER_IDLE_MS = 10 * 60000;
var QUOTA_PROVIDER_IDLE_MS = 10 * 60000;
// node_modules/@openchamber/sdk/dist/service-surface.js
var SURFACE_CONTROLLERS = ["none", "agent", "user"];
var CONTROLLERS = new Set(SURFACE_CONTROLLERS);
// shared/tokens.ts
var CHARS_DIV_4 = 4;
var CHARS_DIV_3 = 3;
var tokensFromChars = (chars, algorithm = "heuristic") => {
  if (!Number.isFinite(chars) || chars <= 0)
    return 0;
  return Math.ceil(chars / (algorithm === "code" ? CHARS_DIV_3 : CHARS_DIV_4));
};

// service/day-ledger.ts
import fs from "node:fs";

// shared/day.ts
var dayKeyLocal = (ts) => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
};
var dayStartLocal = (ts) => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

// service/day-ledger.ts
var MAX_SESSION_PAGES = 40;
var MAX_MESSAGE_PAGES = 80;
var PARALLEL_SESSIONS = 4;
var REQUEST_TIMEOUT_MS = 15000;
var EMIT_DEBOUNCE_MS = 120;
var PERSIST_DEBOUNCE_MS = 1000;
var zero = () => ({
  input: 0,
  output: 0,
  reasoning: 0,
  cacheRead: 0,
  cacheWrite: 0,
  total: 0,
  cost: 0,
  messages: 0
});
var num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : 0;
};
var record = (v) => v !== null && typeof v === "object" && !Array.isArray(v) ? v : null;
var readString = (value) => typeof value === "string" ? value : "";
var modelKeyFrom = (providerId, modelId) => {
  const id = typeof modelId === "string" && modelId ? modelId : "";
  if (!id)
    return null;
  const provider = typeof providerId === "string" && providerId ? providerId : "unknown";
  return `${provider}/${id}`;
};
var modelKeyOf = (message) => {
  const model = record(message.model);
  return modelKeyFrom(model?.providerID, model?.id);
};
var createDayLedger = (deps) => {
  let state = null;
  let partial = false;
  let lastError = null;
  let syncing = null;
  let reconcileQueued = false;
  let caughtUp = false;
  let persistTimer = null;
  let emitTimer = null;
  let lastEmitAt = 0;
  const messageModels = new Map;
  const MESSAGE_MODEL_CAP = 2000;
  const blankState = (now) => ({
    version: 2,
    day: dayKeyLocal(now),
    dayStart: dayStartLocal(now),
    updatedAt: now,
    totals: zero(),
    hours: new Array(24).fill(0),
    models: {},
    sessions: {},
    contributions: {}
  });
  const readPersisted = (now) => {
    try {
      const raw = JSON.parse(fs.readFileSync(deps.statePath(), "utf8"));
      const rec = record(raw);
      const payload = record(rec?.payload);
      if (rec?.version !== 2 || !payload)
        return null;
      const saved = payload;
      if (saved.day !== dayKeyLocal(now) || saved.dayStart !== dayStartLocal(now))
        return null;
      if (!saved.totals || !Array.isArray(saved.hours) || !saved.models || !saved.sessions || !saved.contributions) {
        return null;
      }
      return saved;
    } catch {
      return null;
    }
  };
  const writePersisted = () => {
    if (!state)
      return;
    const file = deps.statePath();
    const tmp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(tmp, JSON.stringify({ version: 2, payload: state }));
      fs.renameSync(tmp, file);
    } catch {
      try {
        fs.unlinkSync(tmp);
      } catch {}
    }
  };
  const schedulePersist = () => {
    if (persistTimer)
      return;
    persistTimer = setTimeout(() => {
      persistTimer = null;
      writePersisted();
    }, PERSIST_DEBOUNCE_MS);
    persistTimer.unref?.();
  };
  const flush = () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    writePersisted();
  };
  const ensureState = (now) => {
    let fresh = false;
    if (!state || state.day !== dayKeyLocal(now) || state.dayStart !== dayStartLocal(now)) {
      state = blankState(now);
      fresh = true;
      partial = false;
      caughtUp = false;
    }
    return { state, fresh };
  };
  const ensureSession = (s, id, title, updated) => {
    let row = s.sessions[id];
    if (!row) {
      row = { title: title || id, updated, total: 0, output: 0, messages: 0, headId: null, modelKey: null };
      s.sessions[id] = row;
    } else {
      if (title)
        row.title = title;
      if (updated > row.updated)
        row.updated = updated;
    }
    return row;
  };
  const addContribution = (s, contribution) => {
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
      const slash = contribution.modelKey.indexOf("/");
      model = {
        key: contribution.modelKey,
        provider: slash >= 0 ? contribution.modelKey.slice(0, slash) : "unknown",
        model: slash >= 0 ? contribution.modelKey.slice(slash + 1) : contribution.modelKey,
        total: 0,
        output: 0,
        messages: 0
      };
      s.models[contribution.modelKey] = model;
    }
    model.total += contribution.total;
    model.output += contribution.output;
    model.messages += 1;
  };
  const removeContribution = (s, contribution) => {
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
      if (model.messages === 0)
        delete s.models[contribution.modelKey];
    }
  };
  const contributionOf = (sessionId, tokens, cost, at, dayStart, modelKey) => {
    const input = num(tokens.input);
    const output = num(tokens.output);
    const reasoning = num(tokens.reasoning);
    const cache = record(tokens.cache);
    const cacheRead = num(cache?.read);
    const cacheWrite = num(cache?.write);
    const total = input + output + reasoning + cacheRead + cacheWrite;
    if (total <= 0)
      return null;
    const hour = Math.min(23, Math.max(0, Math.floor((at - dayStart) / 3600000)));
    return { sessionId, modelKey, hour, input, output, reasoning, cacheRead, cacheWrite, total, cost };
  };
  const applyMessage = (s, messageId, sessionId, tokens, cost, at, modelKey) => {
    const contribution = contributionOf(sessionId, tokens, cost, at, s.dayStart, modelKey);
    if (!contribution)
      return false;
    const previous = s.contributions[messageId];
    if (previous)
      removeContribution(s, previous);
    s.contributions[messageId] = contribution;
    addContribution(s, contribution);
    return true;
  };
  const payloadOf = (now) => {
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
        hours: new Array(24).fill(0),
        models: [],
        sessions: [],
        scan: { sessions: 0, messages: 0, partial: false }
      };
    }
    const models = Object.values(current.models).sort((a, b) => b.total - a.total).slice(0, 8);
    const sessions = Object.entries(current.sessions).filter(([, row]) => row.messages > 0).map(([id, row]) => ({
      id,
      title: row.title || id,
      total: row.total,
      output: row.output,
      messages: row.messages
    })).sort((a, b) => b.total - a.total).slice(0, 8);
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
        partial
      }
    };
  };
  const scheduleEmit = () => {
    if (emitTimer)
      return;
    const wait = lastEmitAt === 0 ? 0 : Math.max(0, EMIT_DEBOUNCE_MS - (Date.now() - lastEmitAt));
    emitTimer = setTimeout(() => {
      emitTimer = null;
      lastEmitAt = Date.now();
      deps.emit(payloadOf(Date.now()));
    }, wait);
    emitTimer.unref?.();
  };
  const requestJson = async (origin, pathAndQuery) => {
    const response = await fetch(new URL(pathAndQuery, origin), {
      headers: deps.headers(),
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
    });
    if (!response.ok)
      throw new Error(`HTTP ${response.status} for ${pathAndQuery}`);
    const body = await response.json();
    const rec = record(body);
    if (!rec)
      throw new Error(`Bad JSON from ${pathAndQuery}`);
    return rec;
  };
  const listActiveSessions = async (origin, dayStart) => {
    const out = [];
    let cursor = null;
    for (let page = 0;page < MAX_SESSION_PAGES; page += 1) {
      const query = `/api/session?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const answer = await requestJson(origin, query);
      const data = Array.isArray(answer.data) ? answer.data : [];
      let oldest = Number.POSITIVE_INFINITY;
      for (const raw of data) {
        const session = record(raw);
        if (!session)
          continue;
        const id = typeof session.id === "string" ? session.id : "";
        if (!id)
          continue;
        const updated = num(record(session.time)?.updated) || num(record(session.time)?.created);
        if (updated < oldest)
          oldest = updated;
        if (updated < dayStart)
          continue;
        out.push({
          id,
          title: typeof session.title === "string" ? session.title : id,
          updated
        });
      }
      const cursorValue = record(answer.cursor)?.next;
      cursor = typeof cursorValue === "string" && cursorValue ? cursorValue : null;
      if (!cursor || data.length === 0 || oldest < dayStart)
        break;
    }
    return out;
  };
  const messagePage = async (origin, sessionId, cursor) => {
    const query = `/api/session/${encodeURIComponent(sessionId)}/message?limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
    const answer = await requestJson(origin, query);
    const data = (Array.isArray(answer.data) ? answer.data : []).filter((raw) => record(raw) !== null);
    const nextValue = record(answer.cursor)?.next;
    return {
      data,
      next: typeof nextValue === "string" && nextValue ? nextValue : null
    };
  };
  const syncSession = async (origin, session, sessionId, s) => {
    const headId = session.headId;
    let newestModel = null;
    let cursor = null;
    for (let page = 0;page < MAX_MESSAGE_PAGES; page += 1) {
      const answer = await messagePage(origin, sessionId, cursor);
      let stop = false;
      let oldest = Number.POSITIVE_INFINITY;
      for (const message of answer.data) {
        const id = typeof message.id === "string" ? message.id : "";
        if (headId && id === headId) {
          stop = true;
          break;
        }
        const time = record(message.time);
        const created = num(time?.created);
        if (created < oldest)
          oldest = created;
        if (message.type !== "assistant")
          continue;
        const at = num(time?.completed) || created;
        if (at < s.dayStart)
          continue;
        const tokens = record(message.tokens);
        if (!tokens)
          continue;
        const modelKey = modelKeyOf(message) ?? session.modelKey ?? "unknown/unknown";
        if (newestModel === null)
          newestModel = modelKey;
        applyMessage(s, id, sessionId, tokens, num(message.cost), at, modelKey);
      }
      if (page === 0 && answer.data.length > 0) {
        let candidate = null;
        let settled = true;
        for (let i = 0;i < answer.data.length; i += 1) {
          const message = answer.data[i];
          const completed = num(record(message.time)?.completed);
          if (message.type === "assistant" && completed <= 0) {
            settled = false;
            const below = answer.data[i + 1];
            candidate = below && typeof below.id === "string" ? below.id : null;
            break;
          }
        }
        if (settled) {
          const top = answer.data[0];
          candidate = top && typeof top.id === "string" ? top.id : null;
        }
        if (candidate)
          session.headId = candidate;
      }
      if (stop || answer.next === null || answer.data.length === 0 || oldest < s.dayStart)
        break;
      cursor = answer.next;
    }
    if (newestModel !== null)
      session.modelKey = newestModel;
  };
  const reconcile = (origin, { full }) => {
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
      const worker = async () => {
        while (queue.length > 0) {
          const session = queue.shift();
          if (!session)
            return;
          const previousUpdated = current.sessions[session.id]?.updated ?? 0;
          const row = ensureSession(current, session.id, session.title, session.updated);
          const needsRead = mustReadAll || row.headId === null || session.updated > previousUpdated || partial;
          if (!needsRead)
            continue;
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
        lastError = "some sessions could not be read";
      } else {
        partial = false;
        lastError = null;
        caughtUp = true;
      }
      current.updatedAt = Date.now();
      flush();
      scheduleEmit();
    })().catch((error) => {
      caughtUp = false;
      partial = true;
      lastError = error instanceof Error ? error.message : "unable to read usage";
      scheduleEmit();
    }).finally(() => {
      syncing = null;
      if (reconcileQueued) {
        reconcileQueued = false;
        const origin = deps.origin();
        if (origin)
          reconcile(origin, { full: false });
      }
    });
    return syncing;
  };
  const rememberModel = (messageId, key) => {
    if (!messageId || !key)
      return;
    messageModels.set(messageId, key);
    while (messageModels.size > MESSAGE_MODEL_CAP) {
      const oldest = messageModels.keys().next();
      if (oldest.done)
        break;
      messageModels.delete(oldest.value);
    }
  };
  const observe = (type, event, now) => {
    const payload = record(event.data) ?? record(event.properties);
    if (!payload)
      return;
    const sessionId = readString(payload.sessionID);
    if (!sessionId)
      return;
    if (type === "session.created" || type === "session.updated") {
      const info = record(payload.info);
      if (!info)
        return;
      const id = readString(info.id) || sessionId;
      const { state: current } = ensureState(now);
      ensureSession(current, id, readString(info.title), num(record(info.time)?.updated) || now);
      current.updatedAt = now;
      schedulePersist();
      scheduleEmit();
      return;
    }
    if (type === "session.deleted") {
      const { state: current } = ensureState(now);
      const row = current.sessions[sessionId];
      if (!row)
        return;
      delete current.sessions[sessionId];
      for (const [messageId, contribution] of Object.entries(current.contributions)) {
        if (contribution.sessionId !== sessionId)
          continue;
        removeContribution(current, contribution);
        delete current.contributions[messageId];
      }
      current.updatedAt = now;
      schedulePersist();
      scheduleEmit();
      return;
    }
    if (type === "session.step.started") {
      const messageId = readString(payload.assistantMessageID);
      if (!messageId)
        return;
      const model = record(payload.model);
      const key = modelKeyFrom(readString(payload.providerID) || readString(model?.providerID), readString(payload.modelID) || readString(model?.id) || readString(model?.modelID));
      if (key)
        rememberModel(messageId, key);
      return;
    }
    if (type === "session.step.ended" || type === "session.step.failed") {
      const messageId = readString(payload.assistantMessageID);
      const tokens = record(payload.tokens);
      if (!messageId || !tokens)
        return;
      const { state: current } = ensureState(now);
      const at = num(event.created) || now;
      if (at < current.dayStart)
        return;
      const session = ensureSession(current, sessionId, "", at);
      const modelKey = messageModels.get(messageId) ?? session.modelKey ?? current.contributions[messageId]?.modelKey ?? "unknown/unknown";
      session.modelKey = modelKey;
      const added = applyMessage(current, messageId, sessionId, tokens, num(payload.cost), at, modelKey);
      if (!added)
        return;
      if (!session.headId)
        session.headId = messageId;
      current.updatedAt = now;
      lastError = null;
      schedulePersist();
      scheduleEmit();
    }
  };
  const catchUp = (options) => {
    const origin = deps.origin();
    if (!origin)
      return Promise.resolve();
    return reconcile(origin, { full: options.full });
  };
  const rebuild = () => {
    state = null;
    caughtUp = false;
    partial = false;
    lastError = null;
    catchUp({ full: true });
  };
  const restored = readPersisted(Date.now());
  if (restored) {
    state = restored;
    caughtUp = false;
  }
  return {
    observe,
    catchUp,
    snapshot: (now) => payloadOf(now),
    rebuild,
    flush
  };
};

// service/auth.ts
import fs2 from "node:fs/promises";
import path from "node:path";
var isLoopbackHost = (hostname) => hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1" || hostname === "[::1]";
var readRecord = async (file) => {
  try {
    const value = JSON.parse(await fs2.readFile(file, "utf8"));
    return value !== null && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};
var passwordAuthHeaders = async (origin, dataDir, parentPorts, signal) => {
  let url;
  try {
    url = new URL(origin);
  } catch {
    return {};
  }
  if (!isLoopbackHost(url.hostname))
    return {};
  const port = Number(url.port || (url.protocol === "https:" ? 443 : 80));
  if (!Number.isInteger(port) || port <= 0)
    return {};
  const instance = await readRecord(path.join(dataDir, "run", `openchamber-${port}.json`));
  if (!parentPorts.has(port) && Object.keys(instance).length === 0)
    return {};
  let password = process.env.OPENCHAMBER_LIVE_TPS_UI_PASSWORD?.trim() ?? "";
  if (!password) {
    const value = instance.uiPassword;
    if (typeof value === "string")
      password = value;
  }
  if (!password)
    return {};
  try {
    const response = await fetch(new URL("/auth/session", url), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ password }),
      signal: AbortSignal.any([signal, AbortSignal.timeout(2000)]),
      redirect: "manual"
    });
    const cookie = response.headers.get("set-cookie")?.match(/(?:^|,\s*)(oc_ui_session(?:_\d+)?=[^;]+)/)?.[1];
    await response.body?.cancel();
    if (response.ok && cookie)
      return { Cookie: cookie };
  } catch {}
  return {};
};

// service/main.ts
var execFileAsync = promisify(execFile);
var dataDir = () => {
  const override = process.env.OPENCHAMBER_DATA_DIR;
  if (override && override.trim())
    return path2.resolve(override.trim());
  return path2.join(os.homedir(), ".config", "openchamber");
};
var readClientToken = () => {
  const override = process.env.OPENCHAMBER_LIVE_TPS_CLIENT_TOKEN;
  if (override && override.trim())
    return override.trim();
  try {
    const raw = JSON.parse(fs3.readFileSync(path2.join(dataDir(), "settings.json"), "utf8"));
    const value = raw?.desktopLocalClientToken;
    if (typeof value === "string" && value.trim())
      return value.trim();
  } catch {}
  return "";
};
var serverHeaders = () => {
  const token = readClientToken();
  return token ? { Authorization: `Bearer ${token}` } : {};
};
var desktopOrigin = () => {
  try {
    const raw = JSON.parse(fs3.readFileSync(path2.join(dataDir(), "settings.json"), "utf8"));
    const port = Number(raw?.desktopLocalPort);
    if (!Number.isInteger(port) || port <= 0 || port > 65535)
      return null;
    return `http://127.0.0.1:${port}`;
  } catch {
    return null;
  }
};
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!Number.isInteger(port) || port <= 0 || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var WINDOW_MS = 1000;
var CURVE_WINDOW_MS = 30000;
var CURVE_BUCKETS = 24;
var SAMPLE_LIMIT = 20000;
var RETRY_BASE_MS = 1000;
var RETRY_MAX_MS = 15000;
var PROBE_TIMEOUT_MS = 2000;
var DISCOVERY_INTERVAL_MS = 5000;
var CALIBRATION_WEIGHT = 0.3;
var MIN_CALIBRATION_FACTOR = 0.25;
var MAX_CALIBRATION_FACTOR = 4;
var calibration = new Map;
var currentModel = "*";
var calibrationFactor = () => calibration.get(currentModel) ?? 1;
var estimateTokens = (chars) => Math.round(tokensFromChars(chars) * calibrationFactor());
var calibrate = (model, chars, generated) => {
  if (!Number.isFinite(chars) || chars <= 0)
    return;
  if (!Number.isFinite(generated) || generated <= 0)
    return;
  const heuristic = tokensFromChars(chars);
  if (heuristic <= 0)
    return;
  const ratio = generated / heuristic;
  const factor = Math.min(MAX_CALIBRATION_FACTOR, Math.max(MIN_CALIBRATION_FACTOR, ratio));
  const previous = calibration.get(model) ?? 1;
  calibration.set(model, previous + (factor - previous) * CALIBRATION_WEIGHT);
};
var MAX_STREAM_GAP_MS = 1000;
var TURNS_CAP = 100;
var SESSIONS_CAP = 20;
var PERSIST_DEBOUNCE_MS2 = 1500;
var PERSIST_VERSION = 1;
var cacheRate = (hit, miss) => hit + miss > 0 ? hit / (hit + miss) * 100 : null;
function emptyCache() {
  return {
    startedAt: null,
    steps: 0,
    sessions: new Set,
    hit: 0,
    miss: 0,
    write: 0,
    input: 0,
    output: 0,
    reasoning: 0,
    cost: 0,
    last: null,
    prevHitRate: null,
    turnBase: null
  };
}
var stepUsageFrom = (tokens, cost) => {
  const block = readRecord2(tokens.cache);
  return {
    input: readNumber(tokens.input),
    cacheRead: block ? readNumber(block.read) : 0,
    cacheWrite: block ? readNumber(block.write) : 0,
    output: readNumber(tokens.output),
    reasoning: readNumber(tokens.reasoning),
    cost,
    hasCache: block !== null
  };
};
var foldCacheStep = (agg, sessionId, messageID, usage, now) => {
  const last = agg.last;
  const retrying = last !== null && last.sessionId === sessionId && last.messageID === messageID;
  if (retrying && last) {
    agg.hit -= last.hit;
    agg.miss -= last.miss;
    agg.input -= last.input;
    agg.write -= last.write;
    agg.output -= last.output;
    agg.reasoning -= last.reasoning;
    agg.steps = Math.max(0, agg.steps - 1);
  }
  if (agg.startedAt === null)
    agg.startedAt = now;
  agg.sessions.add(sessionId);
  agg.steps += 1;
  agg.output += usage.output;
  agg.reasoning += usage.reasoning;
  agg.cost += usage.cost;
  if (!usage.hasCache) {
    return;
  }
  const hit = usage.cacheRead;
  const miss = usage.input + usage.cacheWrite;
  agg.hit += hit;
  agg.miss += miss;
  agg.write += usage.cacheWrite;
  agg.input += usage.input;
  const previous = retrying ? agg.prevHitRate : last?.hitRate ?? null;
  const hitRate = cacheRate(hit, miss);
  agg.last = {
    at: now,
    sessionId,
    messageID,
    hit,
    miss,
    hitRate,
    delta: hitRate !== null && previous !== null ? hitRate - previous : null,
    output: usage.output,
    reasoning: usage.reasoning,
    input: usage.input,
    write: usage.cacheWrite
  };
  agg.prevHitRate = previous;
};
var recordCacheStep = (sessionId, messageID, usage, now) => {
  if (!sessionId)
    return;
  for (const root of watchedRootsFor(sessionId)) {
    const state = sessionStates.get(root);
    if (state)
      foldCacheStep(state.cache, sessionId, messageID, usage, now);
  }
};
var watchedRootsFor = (sessionId) => {
  const roots = [];
  const seen = new Set;
  let cursor = sessionId;
  while (cursor && !seen.has(cursor)) {
    seen.add(cursor);
    if (watched.has(cursor) || cursor === watch?.sessionId || activeRoots.has(cursor))
      roots.push(cursor);
    cursor = sessionParents.get(cursor);
  }
  return roots;
};
var cacheWire = (agg) => agg.steps === 0 ? null : {
  startedAt: agg.startedAt,
  steps: agg.steps,
  sessions: agg.sessions.size,
  hit: agg.hit,
  miss: agg.miss,
  hitRate: cacheRate(agg.hit, agg.miss),
  write: agg.write,
  input: agg.input,
  output: agg.output,
  reasoning: agg.reasoning,
  cost: agg.cost,
  last: agg.last,
  prevHitRate: agg.prevHitRate
};
var cacheMemory = (agg) => ({
  ...agg,
  sessions: [...agg.sessions].slice(-60)
});
var restoreCache = (raw) => {
  const rec = readRecord2(raw);
  if (!rec)
    return emptyCache();
  const agg = emptyCache();
  agg.startedAt = typeof rec.startedAt === "number" && Number.isFinite(rec.startedAt) ? rec.startedAt : null;
  agg.steps = readNumber(rec.steps);
  const sessions = Array.isArray(rec.sessions) ? rec.sessions : [];
  for (const id of sessions.slice(-60))
    if (typeof id === "string" && id)
      agg.sessions.add(id);
  agg.hit = readNumber(rec.hit);
  agg.miss = readNumber(rec.miss);
  agg.write = readNumber(rec.write);
  agg.input = readNumber(rec.input);
  agg.output = readNumber(rec.output);
  agg.reasoning = readNumber(rec.reasoning);
  agg.cost = readNumber(rec.cost);
  const last = readRecord2(rec.last);
  if (last && typeof last.sessionId === "string") {
    agg.last = {
      at: readNumber(last.at),
      sessionId: last.sessionId,
      messageID: readString2(last.messageID),
      hit: readNumber(last.hit),
      miss: readNumber(last.miss),
      hitRate: typeof last.hitRate === "number" && Number.isFinite(last.hitRate) ? last.hitRate : null,
      delta: typeof last.delta === "number" && Number.isFinite(last.delta) ? last.delta : null,
      output: readNumber(last.output),
      reasoning: readNumber(last.reasoning),
      input: readNumber(last.input),
      write: readNumber(last.write)
    };
  }
  agg.prevHitRate = typeof rec.prevHitRate === "number" && Number.isFinite(rec.prevHitRate) ? rec.prevHitRate : null;
  const base = readRecord2(rec.turnBase);
  if (base) {
    agg.turnBase = {
      hit: readNumber(base.hit),
      miss: readNumber(base.miss),
      steps: readNumber(base.steps),
      output: readNumber(base.output)
    };
  }
  return agg;
};
var samples = [];
var partChars = new Map;
var deltaParts = new Set;
var deltaToolCalls = new Set;
var messageChars = new Map;
var watch = null;
var connection = "idle";
var lastError = null;
var lastErrorKind = null;
var serverOrigin = null;
var lastDiscoveryAt = 0;
var lastEventAt = 0;
var eventsSeen = 0;
var busy = false;
var controller = null;
var retryTimer = null;
var retryDelay = RETRY_BASE_MS;
var dayStatePath = () => {
  const override = process.env.OPENCHAMBER_LIVE_TPS_DAY_STATE;
  if (override)
    return override;
  const tpsOverride = process.env.OPENCHAMBER_LIVE_TPS_STATE;
  if (tpsOverride)
    return `${tpsOverride}.day.json`;
  const entry = process.argv[1];
  const beside = entry ? path2.dirname(entry) : process.cwd();
  return path2.join(beside, ".live-tps-day.json");
};
var dayOrigin = () => serverOrigin ?? watch?.origin ?? desktopOrigin();
var serviceHost = createServiceHost({ env: process.env });
var optionDefaults = { cache: false, day: false, detail: false };
var optionsPath = () => {
  const override = process.env.OPENCHAMBER_LIVE_TPS_OPTIONS;
  if (override)
    return override;
  const tpsOverride = process.env.OPENCHAMBER_LIVE_TPS_STATE;
  if (tpsOverride)
    return `${tpsOverride}.options.json`;
  const entry = process.argv[1];
  const beside = entry ? path2.dirname(entry) : process.cwd();
  return path2.join(beside, ".live-tps-options.json");
};
var readOptions = () => {
  try {
    const raw = JSON.parse(fs3.readFileSync(optionsPath(), "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw))
      return { ...optionDefaults };
    const saved = raw;
    return {
      cache: saved.cache === true,
      day: saved.day === true,
      detail: saved.detail === true
    };
  } catch {
    return { ...optionDefaults };
  }
};
var writeOptions = (next) => {
  const file = optionsPath();
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    fs3.writeFileSync(tmp, JSON.stringify(next));
    fs3.renameSync(tmp, file);
  } catch {
    try {
      fs3.unlinkSync(tmp);
    } catch {}
  }
};
var options = readOptions();
var emitOptions = () => {
  serviceHost.emit("options", options).catch(() => {
    return;
  });
};
var day = createDayLedger({
  statePath: dayStatePath,
  origin: dayOrigin,
  headers: serverHeaders,
  emit: (payload) => {
    if (!options.day)
      return;
    serviceHost.emit("day", payload).catch(() => {
      return;
    });
  }
});
var catchUpIfDay = () => {
  if (options.day)
    day.catchUp({ full: false });
};
var turnExecAt = null;
var turnStartedAt = null;
var turnLastCharAt = null;
var turnChars = 0;
var turnReasoningChars = 0;
var turnActiveMs = 0;
var turnWaitMs = 0;
var waitStartAt = null;
var activeToolIds = new Set;
var turnToolMs = 0;
var toolStartAt = null;
var steps = new Map;
var turnStepOrder = [];
var pendingToolStep = new Map;
var fbChars = -1;
var fbTps = NaN;
var lastTurn = null;
var cache = emptyCache();
var pendingPermissions = new Set;
var pendingQuestions = new Set;
var waitingKind = () => pendingPermissions.size > 0 ? "permission" : pendingQuestions.size > 0 ? "question" : null;
var clearTurn = () => {
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
  for (const id of turnStepOrder)
    steps.delete(id);
  turnStepOrder = [];
};
var turns = [];
var sessionStates = new Map;
var watched = new Set;
var sessionParents = new Map;
var BACKGROUND_ROOT_CAP = 8;
var activeRoots = new Map;
var lookedUp = new Set;
var deferredEvents = new Map;
var TRACKED_CAP = SESSIONS_CAP;
var createSessionState = (sessionId) => ({
  sessionId,
  currentModel: "*",
  lastSeenAt: Date.now(),
  samples: [],
  partChars: new Map,
  deltaParts: new Set,
  deltaToolCalls: new Set,
  messageChars: new Map,
  busy: false,
  turnExecAt: null,
  turnStartedAt: null,
  turnLastCharAt: null,
  turnChars: 0,
  turnReasoningChars: 0,
  turnActiveMs: 0,
  turnWaitMs: 0,
  waitStartAt: null,
  activeToolIds: new Set,
  turnToolMs: 0,
  toolStartAt: null,
  steps: new Map,
  turnStepOrder: [],
  pendingToolStep: new Map,
  fbChars: -1,
  fbTps: NaN,
  lastTurn: null,
  turns: [],
  cache: emptyCache(),
  pendingPermissions: new Set,
  pendingQuestions: new Set
});
var activeSession = createSessionState("");
var activeSessionId = null;
var inSession = false;
var trimSessionStates = () => {
  while (sessionStates.size > TRACKED_CAP) {
    let oldestKey = null;
    let oldestAt = Infinity;
    for (const [key, value] of sessionStates) {
      if (key === activeSessionId || watched.has(key) || key === watch?.sessionId)
        continue;
      if (activeRoots.has(key))
        continue;
      if (value.lastSeenAt < oldestAt) {
        oldestAt = value.lastSeenAt;
        oldestKey = key;
      }
    }
    if (oldestKey === null)
      break;
    sessionStates.delete(oldestKey);
  }
};
var trackSession = (sessionId) => {
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
var loadState = (state) => {
  if (inSession)
    throw new Error("loadState called while already inside a session");
  activeSession = state;
  activeSessionId = state.sessionId || null;
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
  cache = state.cache;
  pendingPermissions = state.pendingPermissions;
  pendingQuestions = state.pendingQuestions;
};
var enterSession = (sessionId) => {
  if (inSession)
    throw new Error("enterSession called while already inside a session");
  loadState(trackSession(sessionId));
};
var leaveSession = () => {
  if (!inSession)
    return;
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
  state.cache = cache;
  state.pendingPermissions = pendingPermissions;
  state.pendingQuestions = pendingQuestions;
  inSession = false;
  activeSessionId = null;
};
var blankSession = createSessionState("");
var statePaths = () => {
  const override = process.env.OPENCHAMBER_LIVE_TPS_STATE;
  if (override)
    return [override];
  const entry = process.argv[1];
  const beside = entry ? path2.dirname(entry) : process.cwd();
  return [path2.join(beside, ".live-tps-state.json"), path2.join(os.tmpdir(), "openchamber-live-tps-state.json")];
};
var memoryOf = (state) => ({
  lastTurn: state.lastTurn,
  turns: state.turns.slice(-TURNS_CAP),
  cache: cacheMemory(state.cache)
});
var readSessions = (file) => {
  try {
    const parsed = JSON.parse(fs3.readFileSync(file, "utf8"));
    if (!parsed || parsed.version !== PERSIST_VERSION || !parsed.sessions)
      return {};
    const out = {};
    for (const [id, raw] of Object.entries(parsed.sessions)) {
      if (id && raw && typeof raw === "object")
        out[id] = raw;
    }
    return out;
  } catch {
    return {};
  }
};
var readModels = (file) => {
  try {
    const parsed = JSON.parse(fs3.readFileSync(file, "utf8"));
    const out = {};
    const models = parsed && typeof parsed.models === "object" ? parsed.models : null;
    if (models) {
      for (const [key, value] of Object.entries(models)) {
        if (key && typeof value === "number" && Number.isFinite(value))
          out[key] = value;
      }
    }
    return out;
  } catch {
    return {};
  }
};
var readPersisted = () => {
  for (const file of statePaths()) {
    const sessions = readSessions(file);
    if (Object.keys(sessions).length === 0)
      continue;
    for (const [model, factor] of Object.entries(readModels(file))) {
      calibration.set(model, factor);
    }
    for (const [id, raw] of Object.entries(sessions)) {
      const memory = raw;
      const state = createSessionState(id);
      state.lastTurn = memory.lastTurn ?? null;
      state.turns = Array.isArray(memory.turns) ? memory.turns.slice(-TURNS_CAP) : [];
      state.cache = restoreCache(memory.cache);
      sessionStates.set(id, state);
    }
    return;
  }
};
var persistTimer = null;
var persistDirty = false;
var writePersisted = () => {
  const own = {};
  for (const [id, state] of sessionStates)
    own[id] = memoryOf(state);
  for (const file of statePaths()) {
    try {
      const foreign = Object.entries(readSessions(file)).filter(([id]) => own[id] === undefined);
      const sessions = { ...own };
      for (const [id, memory] of foreign.slice(0, Math.max(0, SESSIONS_CAP - Object.keys(own).length))) {
        sessions[id] = memory;
      }
      const payload = JSON.stringify({
        version: PERSIST_VERSION,
        savedAt: Date.now(),
        sessions,
        models: { ...readModels(file), ...Object.fromEntries(calibration) }
      });
      const tmp = `${file}.${process.pid}.tmp`;
      fs3.writeFileSync(tmp, payload, "utf8");
      fs3.renameSync(tmp, file);
      return;
    } catch {}
  }
};
var flushPersist = () => {
  if (persistTimer) {
    clearTimeout(persistTimer);
    persistTimer = null;
  }
  if (!persistDirty)
    return;
  persistDirty = false;
  writePersisted();
};
var schedulePersist = () => {
  persistDirty = true;
  if (persistTimer)
    return;
  persistTimer = setTimeout(flushPersist, PERSIST_DEBOUNCE_MS2);
  persistTimer.unref?.();
};
var resetInFlight = () => {
  if (inSession)
    return;
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
var turnTtftMs = () => turnExecAt !== null && turnStartedAt !== null ? Math.max(0, turnStartedAt - turnExecAt) : null;
var liveTtftMs = () => {
  const ttfts = [];
  for (const id of turnStepOrder) {
    const step = steps.get(id);
    if (step && step.startObserved && step.firstCharAt !== null) {
      ttfts.push(Math.max(0, step.firstCharAt - step.startAt));
    }
  }
  if (ttfts.length > 0)
    return ttfts.reduce((a, b) => a + b, 0) / ttfts.length;
  return turnTtftMs();
};
var noteWaiting = (now) => {
  if (waitingKind() !== null) {
    if (waitStartAt === null)
      waitStartAt = now;
  } else if (waitStartAt !== null) {
    turnWaitMs += now - waitStartAt;
    waitStartAt = null;
  }
};
var toolActive = () => activeToolIds.size > 0;
var noteTools = (now) => {
  if (toolActive()) {
    if (toolStartAt === null)
      toolStartAt = now;
  } else if (toolStartAt !== null) {
    turnToolMs += now - toolStartAt;
    toolStartAt = null;
  }
};
var stepFor = (messageID, now) => {
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
      sawReasoning: false,
      toolSpans: [],
      toolOpen: 0,
      toolSince: null
    };
    steps.set(messageID, step);
    turnStepOrder.push(messageID);
    if (steps.size > 500) {
      const oldest = steps.keys().next();
      if (!oldest.done)
        steps.delete(oldest.value);
    }
  }
  return step;
};
var latestOpenStepId = () => {
  for (let i = turnStepOrder.length - 1;i >= 0; i -= 1) {
    if (steps.get(turnStepOrder[i])?.endAt === null)
      return turnStepOrder[i];
  }
  return null;
};
var closeStepTool = (step, now) => {
  if (step.toolSince !== null) {
    step.toolSpans.push([step.toolSince, Math.max(step.toolSince, now)]);
    step.toolSince = null;
  }
  step.toolOpen = 0;
};
var stepToolWithinMs = (step, fromMs, toMs) => {
  let total = 0;
  for (const [from, to] of step.toolSpans) {
    total += Math.max(0, Math.min(to, toMs) - Math.max(from, fromMs));
  }
  if (step.toolOpen > 0 && step.toolSince !== null) {
    total += Math.max(0, toMs - Math.max(step.toolSince, fromMs));
  }
  return total;
};
var stepReasoningExclMs = (_step) => 0;
var MAX_PLAUSIBLE_TOKENS_PER_SECOND = 5000;
var plausibleRate = (tokens, ms) => {
  if (!(ms >= 1))
    return null;
  const tps = tokens / (ms / 1000);
  return tps > MAX_PLAUSIBLE_TOKENS_PER_SECOND ? null : tps;
};
var generationStart = (step) => {
  if (step.firstCharAt === null)
    return step.startAt;
  if (step.reasoning > 0 && !step.sawReasoning)
    return step.startAt;
  return step.firstCharAt;
};
var contributeStep = (step) => {
  if (!step.startObserved)
    return null;
  const genStart = generationStart(step);
  const endRef = step.endAt ?? step.lastDeltaAt ?? step.startAt;
  const netMs = Math.max(0, endRef - genStart) - stepToolWithinMs(step, genStart, endRef) - stepReasoningExclMs(step);
  if (!(netMs >= 1))
    return null;
  let tokens;
  let real;
  if (step.settled && step.output + step.reasoning > 0) {
    tokens = step.output + step.reasoning;
    real = true;
  } else if (!step.settled && step.chars > 0) {
    tokens = estimateTokens(step.chars);
    real = false;
  } else {
    return null;
  }
  if (tokens / (netMs / 1000) > MAX_PLAUSIBLE_TOKENS_PER_SECOND)
    return null;
  return {
    tokens,
    netMs,
    real,
    ttftMs: step.firstCharAt !== null ? Math.max(0, step.firstCharAt - step.startAt) : null
  };
};
var sumSteps = () => {
  let tokens = 0;
  let netMs = 0;
  let real = false;
  const ttfts = [];
  for (const id of turnStepOrder) {
    const step = steps.get(id);
    if (!step)
      continue;
    const part = contributeStep(step);
    if (!part)
      continue;
    tokens += part.tokens;
    netMs += part.netMs;
    real = real || part.real;
    if (part.ttftMs !== null)
      ttfts.push(part.ttftMs);
  }
  if (!(netMs >= 1) || !(tokens > 0))
    return null;
  return {
    tokens,
    netMs,
    real,
    ttftMs: ttfts.length > 0 ? ttfts.reduce((a, b) => a + b, 0) / ttfts.length : null
  };
};
var computeRunning = () => {
  const sum = sumSteps();
  if (sum)
    return { tps: sum.tokens / (sum.netMs / 1000), source: sum.real ? "tokens" : "estimate" };
  if (turnStartedAt === null || turnChars === 0)
    return null;
  if (turnChars === fbChars && Number.isFinite(fbTps)) {
    return { tps: fbTps, source: "estimate" };
  }
  const ref = turnLastCharAt ?? turnStartedAt;
  const frozenWait = turnWaitMs + (waitStartAt !== null ? Math.max(0, ref - waitStartAt) : 0);
  const frozenTool = turnToolMs + (toolStartAt !== null ? Math.max(0, ref - toolStartAt) : 0);
  const reconstructed = turnExecAt === null ? ref - turnStartedAt : ref - turnExecAt - frozenWait - frozenTool;
  const elapsedMs = reconstructed >= 1 ? reconstructed : turnActiveMs;
  const tps = plausibleRate(estimateTokens(turnChars), elapsedMs);
  if (tps === null) {
    fbTps = NaN;
    return null;
  }
  fbChars = turnChars;
  fbTps = tps;
  return { tps, source: "estimate" };
};
var snapshotTurnCache = () => {
  const agg = cache;
  if (agg.steps === 0)
    return null;
  const base = agg.turnBase ?? { hit: 0, miss: 0, steps: 0, output: 0 };
  const hit = Math.max(0, agg.hit - base.hit);
  const miss = Math.max(0, agg.miss - base.miss);
  const steps = Math.max(0, agg.steps - base.steps);
  const output = Math.max(0, agg.output - base.output);
  agg.turnBase = { hit: agg.hit, miss: agg.miss, steps: agg.steps, output: agg.output };
  if (steps === 0 || hit + miss === 0)
    return null;
  return { hit, miss, steps, output, hitRate: cacheRate(hit, miss) };
};
var finalizeTurn = (now) => {
  noteWaiting(now);
  noteTools(now);
  const wallMs = turnStartedAt !== null ? Math.max(1, now - turnStartedAt) : 1;
  const sum = sumSteps();
  if (sum) {
    const turnCache = snapshotTurnCache();
    lastTurn = {
      tokensPerSecond: sum.tokens / (sum.netMs / 1000),
      source: sum.real ? "tokens" : "estimate",
      tokens: sum.tokens,
      activeMs: Math.round(sum.netMs),
      wallMs,
      ttftMs: sum.ttftMs,
      hasReasoning: turnReasoningChars > 0 || [...steps.values()].some((s) => s.reasoning > 0),
      endedAt: now,
      cache: turnCache
    };
    turns.push({ tps: lastTurn.tokensPerSecond, at: now, cache: turnCache });
    if (turns.length > TURNS_CAP)
      turns.splice(0, turns.length - TURNS_CAP);
    schedulePersist();
    clearTurn();
    return;
  }
  if (turnStartedAt === null || turnLastCharAt === null || turnChars === 0) {
    clearTurn();
    return;
  }
  const activeMs = Math.max(1, turnActiveMs > 0 ? Math.round(turnActiveMs) : Math.min(wallMs, MAX_STREAM_GAP_MS));
  const tps = plausibleRate(estimateTokens(turnChars), activeMs);
  if (tps === null) {
    clearTurn();
    return;
  }
  const turnCache = snapshotTurnCache();
  lastTurn = {
    tokensPerSecond: tps,
    source: "estimate",
    tokens: estimateTokens(turnChars),
    activeMs,
    wallMs,
    ttftMs: turnTtftMs(),
    hasReasoning: turnReasoningChars > 0,
    endedAt: now,
    cache: turnCache
  };
  turns.push({ tps: lastTurn.tokensPerSecond, at: now, cache: turnCache });
  if (turns.length > TURNS_CAP)
    turns.splice(0, turns.length - TURNS_CAP);
  schedulePersist();
  clearTurn();
};
var pruneSamples = (cutoff) => {
  let expired = 0;
  while (expired < samples.length && samples[expired].at < cutoff) {
    expired += 1;
  }
  if (expired > 0)
    samples.splice(0, expired);
};
var recordChars = (messageID, partID, kind, chars, now) => {
  if (chars <= 0)
    return;
  busy = true;
  samples.push({ at: now, chars, kind });
  if (samples.length > SAMPLE_LIMIT)
    samples.splice(0, samples.length - SAMPLE_LIMIT);
  partChars.set(partID, (partChars.get(partID) ?? 0) + chars);
  messageChars.set(messageID, (messageChars.get(messageID) ?? 0) + chars);
  lastEventAt = now;
  if (turnStartedAt === null) {
    turnStartedAt = now;
    if (turnExecAt !== null && now - turnExecAt <= MAX_STREAM_GAP_MS) {
      turnActiveMs += now - turnExecAt;
    }
  } else if (turnLastCharAt !== null && waitingKind() === null) {
    const gap = now - turnLastCharAt;
    if (gap <= MAX_STREAM_GAP_MS)
      turnActiveMs += gap;
  }
  turnLastCharAt = now;
  turnChars += chars;
  if (kind === "reasoning")
    turnReasoningChars += chars;
  if (messageID) {
    const step = stepFor(messageID, now);
    step.chars += chars;
    step.lastDeltaAt = now;
    if (step.firstCharAt === null)
      step.firstCharAt = now;
    if (kind === "reasoning")
      step.sawReasoning = true;
  }
};
var isWatchedSession = (sessionID) => typeof sessionID === "string" && activeSessionId !== null && sessionID === activeSessionId;
var readString2 = (value) => typeof value === "string" ? value : "";
var readNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
var readRecord2 = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
var fragmentPartID = (messageID, kind, ordinal) => {
  if (!messageID)
    return "";
  const index = typeof ordinal === "number" && Number.isInteger(ordinal) && ordinal >= 0 ? ordinal : 0;
  return `${messageID}:${kind}:${index}`;
};
var normType = (type) => type.replace(".next.", ".");
var markActive = (now) => {
  if (turnExecAt === null)
    turnExecAt = now;
  busy = true;
  lastEventAt = now;
};
var readToolCallID = (payload) => readString2(payload.callID) || readString2(payload.id) || readString2(payload.toolCallID);
var toolPartID = (messageID, callID) => `${messageID}:tool:${callID || "input"}`;
var settleStep = (messageID, output, reasoning, now) => {
  const generated = output + reasoning;
  if (!messageID || generated <= 0)
    return;
  calibrate(currentModel, messageChars.get(messageID) ?? 0, generated);
  const step = stepFor(messageID, now);
  step.output = output;
  step.reasoning = reasoning;
  step.settled = true;
  if (step.endAt === null)
    step.endAt = now;
  closeStepTool(step, now);
};
var eventSessionID = (event) => {
  const payload = readRecord2(event.data) ?? readRecord2(event.properties);
  if (!payload)
    return null;
  const direct = readString2(payload.sessionID);
  if (direct)
    return direct;
  const form = readRecord2(payload.form);
  return form ? readString2(form.sessionID) : "";
};
var handleEvent = (event, now) => {
  const sessionId = eventSessionID(event);
  const type = normType(readString2(event.type));
  if (options.day)
    day.observe(type, event, now);
  if (sessionId && type === "session.created") {
    const data = readRecord2(event.data) ?? readRecord2(event.properties);
    const parentID = data ? readString2(data.parentID) : "";
    if (parentID)
      sessionParents.set(sessionId, parentID);
    else {
      sessionParents.delete(sessionId);
      noteBackgroundRoot(sessionId, now);
    }
    if (watchedRootsFor(sessionId).length > 0)
      trackSession(sessionId);
  }
  if (!sessionId || !sessionStates.has(sessionId)) {
    if (sessionId && (type === "session.step.ended" || type === "session.step.failed")) {
      holdForLookup(sessionId, event);
    }
    return;
  }
  if (sessionId && !sessionParents.has(sessionId) && watchedRootsFor(sessionId).length === 0 && (type === "session.step.ended" || type === "session.step.failed")) {
    holdForLookup(sessionId, event);
    return;
  }
  enterSession(sessionId);
  try {
    dispatchEvent(event, now);
  } finally {
    leaveSession();
  }
};
var holdForLookup = (sessionId, event) => {
  if (watched.size === 0 && !watch?.sessionId && activeRoots.size === 0)
    return;
  if (!lookedUp.has(sessionId)) {
    lookedUp.add(sessionId);
    if (lookedUp.size > 200) {
      const oldest = lookedUp.values().next();
      if (!oldest.done)
        lookedUp.delete(oldest.value);
    }
    resolveSessionParent(sessionId);
  }
  const held = deferredEvents.get(sessionId) ?? [];
  held.push(event);
  if (held.length > 4)
    held.shift();
  deferredEvents.set(sessionId, held);
};
var fetchSessionParent = async (sessionId) => {
  const bases = [];
  for (const candidate of [serverOrigin, watch?.origin, desktopOrigin()]) {
    if (candidate && !bases.includes(candidate))
      bases.push(candidate);
  }
  for (const base of bases) {
    let response;
    try {
      response = await fetch(new URL(`/api/session/${encodeURIComponent(sessionId)}`, base), {
        headers: { Accept: "application/json", ...serverHeaders() },
        signal: AbortSignal.timeout(3000),
        redirect: "manual"
      });
    } catch {
      continue;
    }
    const contentType = response.headers.get("content-type") ?? "";
    if (!response.ok || !contentType.includes("application/json")) {
      await response.body?.cancel().catch(() => {
        return;
      });
      continue;
    }
    try {
      const body = await response.json();
      return readString2(body.parentID);
    } catch {
      return null;
    }
  }
  return null;
};
var resolveSessionParent = async (sessionId) => {
  const parentID = await fetchSessionParent(sessionId);
  if (parentID === null) {
    deferredEvents.delete(sessionId);
    return;
  }
  if (parentID)
    sessionParents.set(sessionId, parentID);
  else
    sessionParents.delete(sessionId);
  if (watchedRootsFor(sessionId).length === 0) {
    deferredEvents.delete(sessionId);
    return;
  }
  trackSession(sessionId);
  const held = deferredEvents.get(sessionId) ?? [];
  deferredEvents.delete(sessionId);
  for (const event of held)
    handleEvent(event, Date.now());
};
var dispatchEvent = (event, now) => {
  const type = normType(readString2(event.type));
  if (!type)
    return;
  const payload = readRecord2(event.data) ?? readRecord2(event.properties);
  if (!payload)
    return;
  if (type === "session.text.delta" || type === "session.reasoning.delta") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const messageID = readString2(payload.assistantMessageID);
    const delta = readString2(payload.delta);
    const kind = type === "session.reasoning.delta" ? "reasoning" : "text";
    const partID = fragmentPartID(messageID, kind, payload.ordinal);
    if (!partID || delta.length === 0)
      return;
    deltaParts.add(partID);
    recordChars(messageID, partID, kind, delta.length, now);
    return;
  }
  if (type === "session.text.ended" || type === "session.reasoning.ended") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const messageID = readString2(payload.assistantMessageID);
    const kind = type === "session.reasoning.ended" ? "reasoning" : "text";
    const partID = fragmentPartID(messageID, kind, payload.ordinal);
    if (!partID)
      return;
    if (deltaParts.has(partID))
      return;
    const text = readString2(payload.text);
    const previous = partChars.get(partID) ?? 0;
    if (text.length <= previous)
      return;
    recordChars(messageID, partID, kind, text.length - previous, now);
    return;
  }
  if (type === "session.tool.input.started") {
    if (!isWatchedSession(payload.sessionID))
      return;
    markActive(now);
    const mid = readString2(payload.assistantMessageID);
    if (mid)
      stepFor(mid, now);
    return;
  }
  if (type === "session.tool.input.delta") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const messageID = readString2(payload.assistantMessageID);
    const delta = readString2(payload.delta);
    if (delta.length === 0)
      return;
    markActive(now);
    const partID = toolPartID(messageID, readToolCallID(payload));
    deltaToolCalls.add(partID);
    recordChars(messageID, partID, "tool", delta.length, now);
    return;
  }
  if (type === "session.tool.input.ended") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const messageID = readString2(payload.assistantMessageID);
    const partID = toolPartID(messageID, readToolCallID(payload));
    if (deltaToolCalls.has(partID))
      return;
    const text = readString2(payload.text) || readString2(payload.input);
    const previous = partChars.get(partID) ?? 0;
    if (text.length <= previous)
      return;
    markActive(now);
    recordChars(messageID, partID, "tool", text.length - previous, now);
    return;
  }
  if (type === "session.tool.called") {
    if (!isWatchedSession(payload.sessionID))
      return;
    markActive(now);
    const id = readToolCallID(payload) || readString2(payload.assistantMessageID);
    if (id) {
      activeToolIds.add(`tool:${id}`);
      if (toolStartAt === null && turnExecAt !== null)
        toolStartAt = now;
      const mid = readString2(payload.assistantMessageID);
      const target = mid ? stepFor(mid, now) : latestOpenStepId() ? steps.get(latestOpenStepId()) ?? null : null;
      pendingToolStep.set(`tool:${id}`, target ? target.id : "");
      if (target) {
        target.toolOpen += 1;
        if (target.toolSince === null)
          target.toolSince = now;
      }
    }
    lastEventAt = now;
    return;
  }
  if (type === "session.tool.success" || type === "session.tool.failed") {
    if (!isWatchedSession(payload.sessionID))
      return;
    markActive(now);
    const id = readToolCallID(payload) || readString2(payload.assistantMessageID);
    if (id)
      activeToolIds.delete(`tool:${id}`);
    if (id) {
      const stepId = pendingToolStep.get(`tool:${id}`);
      pendingToolStep.delete(`tool:${id}`);
      const target = stepId ? steps.get(stepId) : undefined;
      if (target) {
        target.toolOpen = Math.max(0, target.toolOpen - 1);
        if (target.toolOpen === 0)
          closeStepTool(target, now);
      }
    }
    noteTools(now);
    lastEventAt = now;
    return;
  }
  if (type === "session.shell.started") {
    if (!isWatchedSession(payload.sessionID))
      return;
    markActive(now);
    const key = `shell:${readString2(payload.id) || String(eventsSeen)}`;
    activeToolIds.add(key);
    if (toolStartAt === null && turnExecAt !== null)
      toolStartAt = now;
    const openId = latestOpenStepId();
    const target = openId ? steps.get(openId) ?? null : null;
    pendingToolStep.set(key, target ? target.id : "");
    if (target) {
      target.toolOpen += 1;
      if (target.toolSince === null)
        target.toolSince = now;
    }
    lastEventAt = now;
    return;
  }
  if (type === "session.shell.ended") {
    if (!isWatchedSession(payload.sessionID))
      return;
    markActive(now);
    const id = readString2(payload.id);
    const closeKey = (key) => {
      activeToolIds.delete(key);
      const stepId = pendingToolStep.get(key);
      pendingToolStep.delete(key);
      const target = stepId ? steps.get(stepId) : undefined;
      if (target) {
        target.toolOpen = Math.max(0, target.toolOpen - 1);
        if (target.toolOpen === 0)
          closeStepTool(target, now);
      }
    };
    if (id)
      closeKey(`shell:${id}`);
    else
      activeToolIds.forEach((key) => {
        if (key.startsWith("shell:"))
          closeKey(key);
      });
    noteTools(now);
    lastEventAt = now;
    return;
  }
  if (type === "session.step.started") {
    if (!isWatchedSession(payload.sessionID))
      return;
    markActive(now);
    const messageID = readString2(payload.assistantMessageID);
    if (!messageID)
      return;
    const model = readString2(payload.modelID) || readString2(readRecord2(payload.model)?.id);
    if (model)
      currentModel = model;
    const existing = steps.get(messageID);
    if (existing && (existing.settled || existing.endAt !== null)) {
      steps.delete(messageID);
      turnStepOrder = turnStepOrder.filter((id) => id !== messageID);
    }
    const serverCreated = readNumber(event.created) || now;
    const started = readNumber(payload.started);
    const startAt = started > 0 ? now - Math.max(0, serverCreated - started) : now;
    stepFor(messageID, startAt).startObserved = true;
    lastEventAt = now;
    return;
  }
  if (type === "session.step.ended" || type === "session.step.failed") {
    if (!isWatchedSession(payload.sessionID))
      return;
    markActive(now);
    const tokens = readRecord2(payload.tokens);
    if (!tokens) {
      lastEventAt = now;
      return;
    }
    const messageID = readString2(payload.assistantMessageID);
    recordCacheStep(readString2(payload.sessionID), messageID || `step@${now}`, stepUsageFrom(tokens, readNumber(payload.cost)), now);
    settleStep(messageID, readNumber(tokens.output), readNumber(tokens.reasoning), now);
    lastEventAt = now;
    return;
  }
  if (type === "session.execution.started") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const startedSession = readString2(payload.sessionID);
    if (startedSession && !sessionParents.has(startedSession)) {
      noteBackgroundRoot(startedSession, now);
    }
    if (turnStepOrder.length > 0 || turnChars > 0) {
      finalizeTurn(now);
    }
    if (turnExecAt === null)
      turnExecAt = now;
    busy = true;
    lastEventAt = now;
    return;
  }
  if (type === "session.execution.succeeded" || type === "session.execution.failed") {
    if (!isWatchedSession(payload.sessionID))
      return;
    busy = false;
    lastEventAt = now;
    finalizeTurn(now);
    return;
  }
  if (type === "session.execution.interrupted") {
    if (!isWatchedSession(payload.sessionID))
      return;
    lastEventAt = now;
    if (readString2(payload.reason) === "shutdown")
      return;
    busy = false;
    finalizeTurn(now);
    return;
  }
  if (type === "permission.asked" || type === "permission.v2.asked") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const requestId = readString2(payload.id);
    if (requestId)
      pendingPermissions.add(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "permission.replied" || type === "permission.v2.replied") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const requestId = readString2(payload.requestID);
    if (requestId)
      pendingPermissions.delete(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "form.created") {
    const form = readRecord2(payload.form);
    if (!form || !isWatchedSession(form.sessionID))
      return;
    const requestId = readString2(form.id);
    if (requestId)
      pendingQuestions.add(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "form.replied" || type === "form.cancelled") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const requestId = readString2(payload.id);
    if (requestId)
      pendingQuestions.delete(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "question.asked" || type === "question.v2.asked") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const requestId = readString2(payload.id);
    if (requestId)
      pendingQuestions.add(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "question.replied" || type === "question.rejected" || type === "question.v2.replied" || type === "question.v2.rejected") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const requestId = readString2(payload.requestID);
    if (requestId)
      pendingQuestions.delete(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "session.status") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const status = readRecord2(payload.status);
    const nextBusy = status?.type === "busy" || status?.type === "retry";
    if (busy && !nextBusy)
      finalizeTurn(now);
    if (nextBusy && turnExecAt === null)
      turnExecAt = now;
    busy = nextBusy;
    lastEventAt = now;
    return;
  }
  if (type === "session.idle") {
    if (!isWatchedSession(payload.sessionID))
      return;
    busy = false;
    lastEventAt = now;
    finalizeTurn(now);
  }
};
var handleSseChunk = (chunk) => {
  const data = [];
  for (const line of chunk.split(`
`)) {
    if (!line.startsWith("data:"))
      continue;
    data.push(line.slice(5).trimStart());
  }
  if (data.length === 0)
    return;
  let parsed;
  try {
    parsed = JSON.parse(data.join(`
`));
  } catch {
    return;
  }
  if (!parsed || typeof parsed !== "object")
    return;
  const envelope = parsed;
  const event = envelope.payload && typeof envelope.payload === "object" ? envelope.payload : parsed;
  eventsSeen += 1;
  handleEvent(event, Date.now());
};
var parseEndpoint = (value) => {
  const bracketed = /^\[([^\]]*)\]:(\d+)$/.exec(value);
  if (bracketed)
    return { host: bracketed[1], port: Number(bracketed[2]) };
  const plain = /^([^:]+):(\d+)$/.exec(value);
  if (plain)
    return { host: plain[1], port: Number(plain[2]) };
  return null;
};
var toOrigin = (scheme, host, port) => {
  const dial = host === "" || host === "*" || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `${scheme}://${dial.includes(":") ? `[${dial}]` : dial}:${port}`;
};
var runFile = async (file, args) => {
  const { stdout } = await execFileAsync(file, args, {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    windowsHide: true
  });
  return String(stdout);
};
var windowsListenEndpoints = async (pid) => {
  const out = await runFile("netstat", ["-ano"]);
  const found = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 5 || cols[0] !== "TCP")
      continue;
    if (Number(cols[4]) !== pid)
      continue;
    const listening = cols[2] === "0.0.0.0:0" || cols[2] === "[::]:0" || cols[2] === "*:*" || cols[3] === "LISTENING";
    if (!listening)
      continue;
    const endpoint = parseEndpoint(cols[1]);
    if (endpoint)
      found.push(endpoint);
  }
  return found;
};
var ssListenEndpoints = async (pid) => {
  const out = await runFile("ss", ["-ltnp"]);
  const found = [];
  for (const line of out.split(/\r?\n/)) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 6 || cols[0] !== "LISTEN")
      continue;
    if (!new RegExp(`\\bpid=${pid}\\b`).test(cols.slice(5).join(" ")))
      continue;
    const endpoint = parseEndpoint(cols[3]);
    if (endpoint)
      found.push(endpoint);
  }
  return found;
};
var lsofListenEndpoints = async (pid) => {
  const out = await runFile("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-a", "-p", String(pid)]);
  const found = [];
  for (const line of out.split(/\r?\n/)) {
    const match = /\bTCP\s+(\S+)/.exec(line);
    if (!match)
      continue;
    const endpoint = parseEndpoint(match[1]);
    if (endpoint)
      found.push(endpoint);
  }
  return found;
};
var LITTLE_ENDIAN = os.endianness() === "LE";
var procEndpoint = (value, ipv6) => {
  const [address, portHex] = value.split(":");
  if (!address || !portHex)
    return null;
  const port = Number.parseInt(portHex, 16);
  if (!Number.isInteger(port) || port <= 0)
    return null;
  if (ipv6) {
    const loopback = `${"0".repeat(24)}${LITTLE_ENDIAN ? "01000000" : "00000001"}`;
    return address === loopback || address === "0".repeat(32) ? { host: "::1", port } : null;
  }
  if (address === "00000000")
    return { host: "", port };
  const bytes = address.match(/../g);
  if (!bytes || bytes.length !== 4)
    return null;
  const ordered = LITTLE_ENDIAN ? [...bytes].reverse() : bytes;
  const host = ordered.map((byte) => Number.parseInt(byte, 16)).join(".");
  return { host, port };
};
var procListenEndpoints = async (pid) => {
  const fdDir = `/proc/${pid}/fd`;
  const inodes = new Set;
  for (const entry of await fs3.promises.readdir(fdDir)) {
    try {
      const target = await fs3.promises.readlink(path2.join(fdDir, entry));
      const match = /^socket:\[(\d+)\]$/.exec(target);
      if (match)
        inodes.add(match[1]);
    } catch {}
  }
  if (inodes.size === 0)
    return [];
  const found = [];
  for (const [file, ipv6] of [
    ["/proc/net/tcp", false],
    ["/proc/net/tcp6", true]
  ]) {
    let text;
    try {
      text = await fs3.promises.readFile(file, "utf8");
    } catch {
      continue;
    }
    for (const line of text.split(`
`).slice(1)) {
      const cols = line.trim().split(/\s+/);
      if (cols.length < 10 || cols[3] !== "0A" || !inodes.has(cols[9]))
        continue;
      const endpoint = procEndpoint(cols[1], ipv6);
      if (endpoint)
        found.push(endpoint);
    }
  }
  return found;
};
var parentListenEndpoints = async () => {
  const pid = process.ppid;
  if (!Number.isInteger(pid) || pid <= 1)
    return [];
  if (process.platform === "win32") {
    try {
      return await windowsListenEndpoints(pid);
    } catch {
      return [];
    }
  }
  try {
    const found = await ssListenEndpoints(pid);
    if (found.length > 0)
      return found;
  } catch {}
  try {
    const found = await lsofListenEndpoints(pid);
    if (found.length > 0)
      return found;
  } catch {}
  try {
    return await procListenEndpoints(pid);
  } catch {
    return [];
  }
};
var probeEventStream = async (origin, signal) => {
  try {
    const response = await fetch(new URL("/api/global/event", origin), {
      headers: { Accept: "text/event-stream", ...serverHeaders() },
      signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)]),
      redirect: "manual"
    });
    const body = response.body;
    if (body)
      body.cancel().catch(() => {
        return;
      });
    if (response.status === 401 || response.status === 403)
      return "refused";
    if (response.ok && (response.headers.get("content-type") ?? "").includes("text/event-stream"))
      return "stream";
    return null;
  } catch {
    return null;
  }
};
var discoverServerOrigin = async (signal) => {
  const now = Date.now();
  if (now - lastDiscoveryAt < DISCOVERY_INTERVAL_MS)
    return null;
  lastDiscoveryAt = now;
  let endpoints;
  try {
    endpoints = await parentListenEndpoints();
  } catch {
    return null;
  }
  let refused = null;
  for (const { host, port: candidate } of endpoints) {
    if (signal.aborted)
      return null;
    for (const scheme of ["http", "https"]) {
      const origin = toOrigin(scheme, host, candidate);
      const probe = await probeEventStream(origin, signal);
      if (probe === "stream") {
        console.log(`[live-tps] event stream origin is ${origin}; the page's origin was unreachable here`);
        return origin;
      }
      if (probe === "refused" && refused === null)
        refused = origin;
    }
  }
  return refused;
};
var scheduleReconnect = (message, kind) => {
  lastError = message;
  lastErrorKind = kind;
  connection = "error";
  if (!watch || retryTimer)
    return;
  const delay = retryDelay;
  retryDelay = Math.min(RETRY_MAX_MS, retryDelay * 2);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    beginStream();
  }, delay);
};
var startStream = async (tried = new Set) => {
  const current = watch;
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  controller?.abort();
  const local = new AbortController;
  controller = local;
  connection = "connecting";
  lastError = null;
  lastErrorKind = null;
  const own = desktopOrigin();
  const seen = new Set(tried);
  const candidates = [];
  for (const candidate of [serverOrigin, current?.origin, own]) {
    if (!candidate || seen.has(candidate))
      continue;
    seen.add(candidate);
    candidates.push(candidate);
  }
  for (const origin of candidates) {
    let response;
    try {
      response = await fetch(new URL("/api/global/event", origin), {
        headers: { Accept: "text/event-stream", ...serverHeaders() },
        signal: local.signal,
        redirect: "manual"
      });
      if (response.status === 401 || response.status === 403) {
        await response.body?.cancel();
        const endpoints = await parentListenEndpoints();
        if (local.signal.aborted)
          return;
        const headers = await passwordAuthHeaders(origin, dataDir(), new Set(endpoints.map((endpoint) => endpoint.port)), local.signal);
        if (local.signal.aborted)
          return;
        if (Object.keys(headers).length > 0) {
          response = await fetch(new URL("/api/global/event", origin), {
            headers: { Accept: "text/event-stream", ...headers },
            signal: local.signal,
            redirect: "manual"
          });
        }
      }
    } catch (error) {
      if (local.signal.aborted)
        return;
      lastError = error instanceof Error ? error.message : String(error);
      lastErrorKind = "network";
      continue;
    }
    if (!response.ok || !response.body) {
      lastError = `Event stream answered HTTP ${response.status}`;
      lastErrorKind = "http";
      await response.body?.cancel();
      continue;
    }
    if (origin === own)
      serverOrigin = own;
    connection = "live";
    retryDelay = RETRY_BASE_MS;
    lastEventAt = Date.now();
    eventsSeen = 0;
    resetInFlight();
    catchUpIfDay();
    try {
      const decoder = new TextDecoder;
      const reader = response.body.getReader();
      let buffer = "";
      while (!local.signal.aborted) {
        const { value, done } = await reader.read();
        if (done)
          break;
        buffer += decoder.decode(value, { stream: true });
        let boundary = buffer.indexOf(`

`);
        while (boundary !== -1) {
          const chunk = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          handleSseChunk(chunk);
          boundary = buffer.indexOf(`

`);
        }
      }
      if (!local.signal.aborted)
        scheduleReconnect("Event stream closed", "closed");
    } catch (error) {
      if (local.signal.aborted)
        return;
      scheduleReconnect(error instanceof Error ? error.message : String(error), "network");
    }
    return;
  }
  if (local.signal.aborted)
    return;
  const discovered = await discoverServerOrigin(local.signal);
  if (local.signal.aborted)
    return;
  if (discovered && !seen.has(discovered)) {
    serverOrigin = discovered;
    await startStream(seen);
    return;
  }
  scheduleReconnect(lastError ?? "Event stream unreachable", lastErrorKind ?? "network");
};
var beginStream = () => {
  startStream().catch((error) => {
    scheduleReconnect(error instanceof Error ? error.message : String(error), "network");
  });
};
var streamPending = false;
var ensureStream = () => {
  if (controller !== null || streamPending)
    return;
  streamPending = true;
  startStream().catch((error) => {
    scheduleReconnect(error instanceof Error ? error.message : String(error), "network");
  }).finally(() => {
    streamPending = false;
  });
};
var stopStream = () => {
  if (retryTimer) {
    clearTimeout(retryTimer);
    retryTimer = null;
  }
  controller?.abort();
  controller = null;
  connection = "idle";
};
var computeLive = (now) => {
  const from = now - WINDOW_MS;
  let chars = 0;
  let textChars = 0;
  let reasoningChars = 0;
  let toolChars = 0;
  let oldest = now;
  for (const sample of samples) {
    if (sample.at < from)
      continue;
    chars += sample.chars;
    if (sample.kind === "reasoning")
      reasoningChars += sample.chars;
    else if (sample.kind === "tool")
      toolChars += sample.chars;
    else
      textChars += sample.chars;
    if (sample.at < oldest)
      oldest = sample.at;
  }
  if (chars === 0) {
    return { tps: 0, spanMs: 0, chars: 0, textChars: 0, reasoningChars: 0, toolChars: 0 };
  }
  const spanMs = Math.max(1, Math.min(WINDOW_MS, now - oldest));
  return {
    tps: Math.min(estimateTokens(chars) / (spanMs / 1000), MAX_PLAUSIBLE_TOKENS_PER_SECOND),
    spanMs,
    chars,
    textChars,
    reasoningChars,
    toolChars
  };
};
var computeCurve = (now) => {
  const width = CURVE_WINDOW_MS / CURVE_BUCKETS;
  const newest = Math.floor(now / width) * width;
  const oldest = newest - CURVE_WINDOW_MS;
  pruneSamples(oldest);
  const buckets = new Array(CURVE_BUCKETS).fill(0);
  for (const sample of samples) {
    if (sample.at < oldest || sample.at >= newest)
      continue;
    const b = Math.min(CURVE_BUCKETS - 1, Math.floor((sample.at - oldest) / width));
    buckets[b] += sample.chars;
  }
  const values = [];
  for (let b = 0;b < CURVE_BUCKETS; b += 1) {
    values.push(Math.min(estimateTokens(buckets[b]) / (width / 1000), MAX_PLAUSIBLE_TOKENS_PER_SECOND));
  }
  return { values, startAt: oldest, stepMs: width };
};
var isHttpOrigin = (value) => {
  try {
    const parsed = new URL(value);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && parsed.username === "" && parsed.password === "";
  } catch {
    return false;
  }
};
var applyWatch = (next) => {
  const originChanged = watch === null || serverOrigin === null && watch.origin !== next.origin;
  watch = next;
  if (next.sessionId) {
    watched.add(next.sessionId);
    trackSession(next.sessionId);
  }
  if (!originChanged)
    return false;
  retryDelay = RETRY_BASE_MS;
  stopStream();
  beginStream();
  return true;
};
var json = (res, status, body) => {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
};
var readJsonBody = (req) => new Promise((resolve, reject) => {
  let body = "";
  req.on("data", (chunk) => {
    body += chunk;
    if (body.length > 64000) {
      reject(new Error("Request body too large"));
      req.destroy();
    }
  });
  req.on("end", () => {
    if (!body.trim()) {
      resolve(null);
      return;
    }
    try {
      resolve(JSON.parse(body));
    } catch {
      reject(new Error("Request body is not valid JSON"));
    }
  });
  req.on("error", reject);
});
var noteBackgroundRoot = (sessionId, now) => {
  activeRoots.delete(sessionId);
  activeRoots.set(sessionId, now);
  while (activeRoots.size > BACKGROUND_ROOT_CAP) {
    const oldest = activeRoots.keys().next();
    if (oldest.done)
      break;
    activeRoots.delete(oldest.value);
  }
};
var SESSION_EVENT_TYPES = new Set([
  "turn-finished",
  "turn-failed",
  "permission-asked",
  "question-asked",
  "turn-started",
  "session-created",
  "session-archived",
  "session-deleted"
]);
var handleSessionEvent = (body) => {
  const request = readRecord2(body);
  if (!request || request.v !== 1)
    return false;
  const event = readRecord2(request.event);
  if (!event)
    return false;
  const type = readString2(event.type);
  if (!SESSION_EVENT_TYPES.has(type))
    return false;
  const session = readRecord2(event.session);
  const sessionId = session ? readString2(session.id) : "";
  const parentId = session ? readString2(session.parentId) : "";
  if (!sessionId)
    return false;
  const now = Date.now();
  if (type === "session-created") {
    if (parentId)
      sessionParents.set(sessionId, parentId);
    else
      sessionParents.delete(sessionId);
  }
  if (type === "turn-started" && !parentId)
    noteBackgroundRoot(sessionId, now);
  if (type === "turn-started" || type === "turn-finished") {
    if (parentId)
      sessionParents.set(sessionId, parentId);
    if (watchedRootsFor(sessionId).length > 0)
      trackSession(sessionId);
    ensureStream();
  }
  if (type === "turn-finished")
    flushPersist();
  return true;
};
var server = http.createServer((req, res) => {
  if (req.headers.authorization !== `Bearer ${token}`) {
    json(res, 401, { error: "unauthorized" });
    return;
  }
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  if (url.pathname === "/health") {
    json(res, 200, { ok: true, pid: process.pid });
    return;
  }
  if (url.pathname === "/watch" && req.method === "POST") {
    readJsonBody(req).then((raw) => {
      const body = raw && typeof raw === "object" ? raw : {};
      const rawOrigin = body.origin;
      if (rawOrigin !== undefined && rawOrigin !== null && typeof rawOrigin !== "string") {
        json(res, 400, { error: "origin must be an http(s) origin from the OpenChamber server" });
        return;
      }
      const hinted = (rawOrigin ?? "").trim();
      if (hinted !== "" && !isHttpOrigin(hinted)) {
        json(res, 400, { error: "origin must be an http(s) origin from the OpenChamber server" });
        return;
      }
      const origin = hinted === "" ? null : hinted;
      const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId : null;
      const fresh = sessionId !== null && !watched.has(sessionId);
      const changed = applyWatch({ origin, sessionId }) || fresh;
      if (changed)
        catchUpIfDay();
      json(res, 200, { ok: true, changed, connection, sessionId });
    }).catch((error) => {
      json(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
    });
    return;
  }
  if (url.pathname === "/session-events" && req.method === "POST") {
    readJsonBody(req).then((body) => {
      if (!handleSessionEvent(body)) {
        json(res, 400, { ok: false, error: "unsupported session event" });
        return;
      }
      json(res, 200, { ok: true });
    }).catch((error) => {
      json(res, 400, { ok: false, error: error instanceof Error ? error.message : "bad body" });
    });
    return;
  }
  if (url.pathname === "/options") {
    if (req.method === "GET") {
      json(res, 200, options);
      return;
    }
    if (req.method === "POST") {
      readJsonBody(req).then((raw) => {
        const body = raw && typeof raw === "object" ? raw : {};
        const wasDay = options.day;
        const next = {
          cache: typeof body.cache === "boolean" ? body.cache : options.cache,
          day: typeof body.day === "boolean" ? body.day : options.day,
          detail: typeof body.detail === "boolean" ? body.detail : options.detail
        };
        options = next;
        writeOptions(options);
        if (!wasDay && options.day)
          catchUpIfDay();
        emitOptions();
        json(res, 200, options);
      }).catch((error) => {
        json(res, 400, { error: error instanceof Error ? error.message : "invalid options" });
      });
      return;
    }
    json(res, 405, { error: "method not allowed" });
    return;
  }
  if (url.pathname === "/day") {
    json(res, 200, day.snapshot(Date.now()));
    return;
  }
  if (url.pathname === "/day/rebuild" && req.method === "POST") {
    day.rebuild();
    json(res, 200, { ok: true });
    return;
  }
  if (url.pathname === "/history") {
    const requested = readString2(url.searchParams.get("sessionId")) || watch?.sessionId || null;
    if (requested !== null)
      enterSession(requested);
    else
      loadState(blankSession);
    let body;
    try {
      body = {
        sessionId: requested,
        turns,
        cache: cacheWire(cache)
      };
    } finally {
      leaveSession();
    }
    json(res, 200, body);
    return;
  }
  if (url.pathname === "/rate") {
    const now = Date.now();
    const requested = readString2(url.searchParams.get("sessionId")) || watch?.sessionId || null;
    if (requested !== null)
      enterSession(requested);
    else
      loadState(blankSession);
    let body;
    try {
      const curve = computeCurve(now);
      body = {
        connection,
        error: lastError,
        errorKind: lastErrorKind,
        sessionId: requested !== null && watched.has(requested) ? requested : null,
        busy,
        waiting: waitingKind(),
        toolActive: toolActive(),
        live: computeLive(now),
        running: turnStartedAt !== null ? computeRunning() : null,
        curve: curve.values,
        curveStart: curve.startAt,
        curveStep: curve.stepMs,
        curveAt: now,
        turn: {
          active: turnStartedAt !== null,
          ttftMs: liveTtftMs()
        },
        lastTurn,
        cache: cacheWire(cache),
        eventsSeen
      };
    } finally {
      leaveSession();
    }
    json(res, 200, body);
    return;
  }
  json(res, 404, { error: "not-found" });
});
readPersisted();
catchUpIfDay();
server.listen(port, "127.0.0.1", () => {
  ensureStream();
});
var shutdown = () => {
  flushPersist();
  day.flush();
  stopStream();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
