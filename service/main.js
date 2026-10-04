// service/main.ts
import http from "node:http";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
var execFileAsync = promisify(execFile);
var port = Number(process.env.OPENCHAMBER_SERVICE_PORT);
var token = process.env.OPENCHAMBER_SERVICE_TOKEN ?? "";
if (!Number.isInteger(port) || port <= 0 || !token) {
  console.error("OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required");
  process.exit(1);
}
var WINDOW_MS = 1000;
var SAMPLE_LIMIT = 5000;
var RETRY_BASE_MS = 1000;
var RETRY_MAX_MS = 15000;
var PROBE_TIMEOUT_MS = 2000;
var DISCOVERY_INTERVAL_MS = 5000;
var DEFAULT_CHARS_PER_TOKEN = 0.25;
var MIN_CHARS_PER_TOKEN = 0.05;
var MAX_CHARS_PER_TOKEN = 1;
var CALIBRATION_WEIGHT = 0.3;
var MIN_CALIBRATION_CHARS = 40;
var MAX_STREAM_GAP_MS = 1000;
var TURNS_CAP = 30;
var SESSIONS_CAP = 20;
var CURVE_BUCKETS = 12;
var sessionMemory = new Map;
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
var charsPerToken = DEFAULT_CHARS_PER_TOKEN;
var calibrated = false;
var controller = null;
var retryTimer = null;
var retryDelay = RETRY_BASE_MS;
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
var fbRatio = NaN;
var fbTps = NaN;
var lastTurn = null;
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
  fbRatio = NaN;
  fbTps = NaN;
  for (const id of turnStepOrder)
    steps.delete(id);
  turnStepOrder = [];
};
var resetMeasurement = () => {
  samples.length = 0;
  partChars.clear();
  deltaParts.clear();
  deltaToolCalls.clear();
  messageChars.clear();
  lastEventAt = 0;
  busy = false;
  charsPerToken = DEFAULT_CHARS_PER_TOKEN;
  calibrated = false;
  clearTurn();
  pendingPermissions.clear();
  pendingQuestions.clear();
  activeToolIds.clear();
  pendingToolStep.clear();
  steps.clear();
  lastTurn = null;
  turns.length = 0;
};
var turns = [];
var stashSession = (sessionId) => {
  if (!sessionId)
    return;
  sessionMemory.set(sessionId, {
    lastTurn,
    turns: turns.slice(-TURNS_CAP),
    charsPerToken,
    calibrated
  });
  while (sessionMemory.size > SESSIONS_CAP) {
    const oldest = sessionMemory.keys().next();
    if (oldest.done)
      break;
    sessionMemory.delete(oldest.value);
  }
};
var loadSession = (sessionId) => {
  const saved = sessionId ? sessionMemory.get(sessionId) : undefined;
  if (!saved)
    return;
  lastTurn = saved.lastTurn;
  turns = saved.turns.slice(-TURNS_CAP);
  charsPerToken = saved.charsPerToken;
  calibrated = saved.calibrated;
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
      reasoningChars: 0,
      firstReasoningAt: null,
      lastReasoningAt: null,
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
var stepReasoningExclMs = (step) => {
  if (!step.settled || step.reasoning !== 0 || step.reasoningChars === 0)
    return 0;
  if (step.firstReasoningAt === null || step.lastReasoningAt === null)
    return 0;
  return Math.max(0, step.lastReasoningAt - step.firstReasoningAt);
};
var MAX_PLAUSIBLE_TOKENS_PER_SECOND = 5000;
var plausibleRate = (tokens, ms) => {
  if (!(ms >= 1))
    return null;
  const tps = tokens / (ms / 1000);
  return tps > MAX_PLAUSIBLE_TOKENS_PER_SECOND ? null : tps;
};
var contributeStep = (step) => {
  if (!step.startObserved)
    return null;
  const endRef = step.endAt ?? step.lastDeltaAt ?? step.startAt;
  const netMs = Math.max(0, endRef - step.startAt) - stepToolWithinMs(step, step.startAt, endRef) - stepReasoningExclMs(step);
  if (!(netMs >= 1))
    return null;
  let tokens;
  let real;
  if (step.settled && step.output + step.reasoning > 0) {
    tokens = step.output + step.reasoning;
    real = true;
  } else if (!step.settled && step.chars > 0) {
    tokens = step.chars * charsPerToken;
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
  if (turnChars === fbChars && charsPerToken === fbRatio && Number.isFinite(fbTps)) {
    return { tps: fbTps, source: "estimate" };
  }
  const ref = turnLastCharAt ?? turnStartedAt;
  const frozenWait = turnWaitMs + (waitStartAt !== null ? Math.max(0, ref - waitStartAt) : 0);
  const frozenTool = turnToolMs + (toolStartAt !== null ? Math.max(0, ref - toolStartAt) : 0);
  const reconstructed = turnExecAt === null ? ref - turnStartedAt : ref - turnExecAt - frozenWait - frozenTool;
  const elapsedMs = reconstructed >= 1 ? reconstructed : turnActiveMs;
  const tps = plausibleRate(turnChars * charsPerToken, elapsedMs);
  if (tps === null) {
    fbTps = NaN;
    return null;
  }
  fbChars = turnChars;
  fbRatio = charsPerToken;
  fbTps = tps;
  return { tps, source: "estimate" };
};
var finalizeTurn = (now) => {
  noteWaiting(now);
  noteTools(now);
  const wallMs = turnStartedAt !== null ? Math.max(1, now - turnStartedAt) : 1;
  const sum = sumSteps();
  if (sum) {
    lastTurn = {
      tokensPerSecond: sum.tokens / (sum.netMs / 1000),
      source: sum.real ? "tokens" : "estimate",
      tokens: sum.tokens,
      activeMs: Math.round(sum.netMs),
      wallMs,
      ttftMs: sum.ttftMs,
      hasReasoning: turnReasoningChars > 0 || [...steps.values()].some((s) => s.reasoning > 0),
      endedAt: now
    };
    turns.push({ tps: lastTurn.tokensPerSecond, at: now });
    if (turns.length > TURNS_CAP)
      turns.splice(0, turns.length - TURNS_CAP);
    clearTurn();
    return;
  }
  if (turnStartedAt === null || turnLastCharAt === null || turnChars === 0) {
    clearTurn();
    return;
  }
  const activeMs = Math.max(1, turnActiveMs > 0 ? Math.round(turnActiveMs) : Math.min(wallMs, MAX_STREAM_GAP_MS));
  const tps = plausibleRate(turnChars * charsPerToken, activeMs);
  if (tps === null) {
    clearTurn();
    return;
  }
  lastTurn = {
    tokensPerSecond: tps,
    source: "estimate",
    tokens: turnChars * charsPerToken,
    activeMs,
    wallMs,
    ttftMs: turnTtftMs(),
    hasReasoning: turnReasoningChars > 0,
    endedAt: now
  };
  turns.push({ tps: lastTurn.tokensPerSecond, at: now });
  if (turns.length > TURNS_CAP)
    turns.splice(0, turns.length - TURNS_CAP);
  clearTurn();
};
var pruneSamples = (now) => {
  let expired = 0;
  while (expired < samples.length && now - samples[expired].at > WINDOW_MS) {
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
    if (kind === "reasoning") {
      step.reasoningChars += chars;
      if (step.firstReasoningAt === null)
        step.firstReasoningAt = now;
      step.lastReasoningAt = now;
    }
  }
};
var isWatchedSession = (sessionID) => typeof sessionID === "string" && watch !== null && watch.sessionId !== null && sessionID === watch.sessionId;
var readString = (value) => typeof value === "string" ? value : "";
var readNumber = (value) => typeof value === "number" && Number.isFinite(value) ? value : 0;
var readRecord = (value) => value !== null && typeof value === "object" && !Array.isArray(value) ? value : null;
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
var readToolCallID = (payload) => readString(payload.callID) || readString(payload.id) || readString(payload.toolCallID);
var toolPartID = (messageID, callID) => `${messageID}:tool:${callID || "input"}`;
var calibrate = (messageID, output, reasoning) => {
  const chars = messageChars.get(messageID) ?? 0;
  if (chars < MIN_CALIBRATION_CHARS)
    return;
  const generated = output + reasoning;
  if (!Number.isFinite(generated) || generated <= 0)
    return;
  const ratio = Math.min(MAX_CHARS_PER_TOKEN, Math.max(MIN_CHARS_PER_TOKEN, generated / chars));
  charsPerToken = charsPerToken + (ratio - charsPerToken) * CALIBRATION_WEIGHT;
  calibrated = true;
};
var settleStep = (messageID, output, reasoning, now) => {
  const generated = output + reasoning;
  if (!messageID || generated <= 0)
    return;
  calibrate(messageID, output, reasoning);
  const step = stepFor(messageID, now);
  step.output = output;
  step.reasoning = reasoning;
  step.settled = true;
  if (step.endAt === null)
    step.endAt = now;
  closeStepTool(step, now);
};
var handleEvent = (event, now) => {
  const type = normType(readString(event.type));
  if (!type)
    return;
  const payload = readRecord(event.data) ?? readRecord(event.properties);
  if (!payload)
    return;
  if (type === "session.text.delta" || type === "session.reasoning.delta") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const messageID = readString(payload.assistantMessageID);
    const delta = readString(payload.delta);
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
    const messageID = readString(payload.assistantMessageID);
    const kind = type === "session.reasoning.ended" ? "reasoning" : "text";
    const partID = fragmentPartID(messageID, kind, payload.ordinal);
    if (!partID)
      return;
    if (deltaParts.has(partID))
      return;
    const text = readString(payload.text);
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
    const mid = readString(payload.assistantMessageID);
    if (mid)
      stepFor(mid, now);
    return;
  }
  if (type === "session.tool.input.delta") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const messageID = readString(payload.assistantMessageID);
    const delta = readString(payload.delta);
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
    const messageID = readString(payload.assistantMessageID);
    const partID = toolPartID(messageID, readToolCallID(payload));
    if (deltaToolCalls.has(partID))
      return;
    const text = readString(payload.text) || readString(payload.input);
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
    const id = readToolCallID(payload) || readString(payload.assistantMessageID);
    if (id) {
      activeToolIds.add(`tool:${id}`);
      if (toolStartAt === null && turnExecAt !== null)
        toolStartAt = now;
      const mid = readString(payload.assistantMessageID);
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
    const id = readToolCallID(payload) || readString(payload.assistantMessageID);
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
    const key = `shell:${readString(payload.id) || String(eventsSeen)}`;
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
    const id = readString(payload.id);
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
    const messageID = readString(payload.assistantMessageID);
    if (!messageID)
      return;
    const existing = steps.get(messageID);
    if (existing && (existing.settled || existing.endAt !== null)) {
      steps.delete(messageID);
      turnStepOrder = turnStepOrder.filter((id) => id !== messageID);
    }
    stepFor(messageID, now).startObserved = true;
    lastEventAt = now;
    return;
  }
  if (type === "session.step.ended" || type === "session.step.failed") {
    if (!isWatchedSession(payload.sessionID))
      return;
    markActive(now);
    const tokens = readRecord(payload.tokens);
    if (!tokens)
      return;
    settleStep(readString(payload.assistantMessageID), readNumber(tokens.output), readNumber(tokens.reasoning), now);
    lastEventAt = now;
    return;
  }
  if (type === "session.execution.started") {
    if (!isWatchedSession(payload.sessionID))
      return;
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
    if (readString(payload.reason) === "shutdown")
      return;
    busy = false;
    finalizeTurn(now);
    return;
  }
  if (type === "permission.asked" || type === "permission.v2.asked") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const requestId = readString(payload.id);
    if (requestId)
      pendingPermissions.add(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "permission.replied" || type === "permission.v2.replied") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const requestId = readString(payload.requestID);
    if (requestId)
      pendingPermissions.delete(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "form.created") {
    const form = readRecord(payload.form);
    if (!form || !isWatchedSession(form.sessionID))
      return;
    const requestId = readString(form.id);
    if (requestId)
      pendingQuestions.add(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "form.replied" || type === "form.cancelled") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const requestId = readString(payload.id);
    if (requestId)
      pendingQuestions.delete(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "question.asked" || type === "question.v2.asked") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const requestId = readString(payload.id);
    if (requestId)
      pendingQuestions.add(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "question.replied" || type === "question.rejected" || type === "question.v2.replied" || type === "question.v2.rejected") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const requestId = readString(payload.requestID);
    if (requestId)
      pendingQuestions.delete(requestId);
    lastEventAt = now;
    return;
  }
  if (type === "session.status") {
    if (!isWatchedSession(payload.sessionID))
      return;
    const status = readRecord(payload.status);
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
var toOrigin = (scheme, host, port2) => {
  const dial = host === "" || host === "*" || host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
  return `${scheme}://${dial.includes(":") ? `[${dial}]` : dial}:${port2}`;
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
    return await ssListenEndpoints(pid);
  } catch {}
  try {
    return await lsofListenEndpoints(pid);
  } catch {
    return [];
  }
};
var probeEventStream = async (origin, signal) => {
  try {
    const response = await fetch(new URL("/api/global/event", origin), {
      headers: { Accept: "text/event-stream" },
      signal: AbortSignal.any([signal, AbortSignal.timeout(PROBE_TIMEOUT_MS)])
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
  if (!current)
    return;
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
  const seen = new Set(tried);
  const candidates = [serverOrigin, current.origin].filter((origin) => origin !== null && origin.length > 0 && !seen.has(origin));
  for (const origin of candidates) {
    seen.add(origin);
    let response;
    try {
      response = await fetch(new URL("/api/global/event", origin), {
        headers: { Accept: "text/event-stream" },
        signal: local.signal
      });
    } catch (error) {
      if (local.signal.aborted)
        return;
      lastError = error instanceof Error ? error.message : String(error);
      lastErrorKind = "network";
      continue;
    }
    if (!response.ok || !response.body) {
      scheduleReconnect(`Event stream answered HTTP ${response.status}`, "http");
      return;
    }
    connection = "live";
    retryDelay = RETRY_BASE_MS;
    lastEventAt = Date.now();
    eventsSeen = 0;
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
  scheduleReconnect(lastError ?? "Event stream unreachable", "network");
};
var beginStream = () => {
  startStream().catch((error) => {
    scheduleReconnect(error instanceof Error ? error.message : String(error), "network");
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
  pruneSamples(now);
  if (samples.length === 0) {
    return { tps: 0, spanMs: 0, chars: 0, textChars: 0, reasoningChars: 0, toolChars: 0 };
  }
  const spanMs = Math.max(1, Math.min(WINDOW_MS, now - samples[0].at));
  let chars = 0;
  let textChars = 0;
  let reasoningChars = 0;
  let toolChars = 0;
  for (const sample of samples) {
    chars += sample.chars;
    if (sample.kind === "reasoning")
      reasoningChars += sample.chars;
    else if (sample.kind === "tool")
      toolChars += sample.chars;
    else
      textChars += sample.chars;
  }
  return {
    tps: Math.min(chars / (spanMs / 1000) * charsPerToken, MAX_PLAUSIBLE_TOKENS_PER_SECOND),
    spanMs,
    chars,
    textChars,
    reasoningChars,
    toolChars
  };
};
var liveBuckets = (now) => {
  pruneSamples(now);
  if (samples.length === 0)
    return [];
  const width = WINDOW_MS / CURVE_BUCKETS;
  const oldest = now - WINDOW_MS;
  const out = [];
  for (let b = 0;b < CURVE_BUCKETS; b += 1) {
    const from = oldest + b * width;
    const to = from + width;
    let chars = 0;
    for (const sample of samples) {
      if (sample.at < from || sample.at >= to)
        continue;
      chars += sample.chars;
    }
    if (chars === 0) {
      out.push(0);
      continue;
    }
    out.push(Math.min(chars / (width / 1000) * charsPerToken, MAX_PLAUSIBLE_TOKENS_PER_SECOND));
  }
  let lead = 0;
  while (lead < out.length && out[lead] <= 0)
    lead += 1;
  return out.slice(lead);
};
var computeCurve = (now) => {
  const past = turns.slice(-16).map((t) => t.tps);
  if (!busy || waitingKind() !== null)
    return past;
  const live = liveBuckets(now).filter((v) => v > 0);
  if (live.length === 0)
    return past;
  return [...past.slice(-8), ...live].slice(-(CURVE_BUCKETS * 2));
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
  const changed = watch === null || watch.origin !== next.origin || watch.sessionId !== next.sessionId;
  if (!changed)
    return false;
  if (watch === null || watch.origin !== next.origin)
    serverOrigin = null;
  stashSession(watch?.sessionId ?? null);
  watch = next;
  resetMeasurement();
  loadSession(next.sessionId);
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
      const origin = readString(body.origin);
      if (!isHttpOrigin(origin)) {
        json(res, 400, { error: "origin must be an http(s) origin from the OpenChamber server" });
        return;
      }
      const sessionId = typeof body.sessionId === "string" && body.sessionId.trim() ? body.sessionId : null;
      const changed = applyWatch({ origin, sessionId });
      json(res, 200, { ok: true, changed, connection, sessionId });
    }).catch((error) => {
      json(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
    });
    return;
  }
  if (url.pathname === "/rate") {
    const now = Date.now();
    const live = computeLive(now);
    json(res, 200, {
      connection,
      error: lastError,
      errorKind: lastErrorKind,
      sessionId: watch?.sessionId ?? null,
      busy,
      waiting: waitingKind(),
      toolActive: toolActive(),
      calibrated,
      live,
      running: turnStartedAt !== null ? computeRunning() : null,
      curve: computeCurve(now),
      turn: {
        active: turnStartedAt !== null,
        ttftMs: liveTtftMs()
      },
      lastTurn,
      eventsSeen
    });
    return;
  }
  json(res, 404, { error: "not-found" });
});
server.listen(port, "127.0.0.1");
var shutdown = () => {
  stopStream();
  server.close(() => process.exit(0));
};
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);
