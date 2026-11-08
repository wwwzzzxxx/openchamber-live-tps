import { connectHost, HostRequestError } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { clearSpark as clearSparkPaths, drawSpark, makeSparkSvg, nextScale, type SparkFrame } from '../shared/spark';

type Live = {
  tps: number;
  spanMs: number;
  chars: number;
  textChars: number;
  reasoningChars: number;
  toolChars: number;
};

type TurnResult = {
  tokensPerSecond: number;
  source: 'tokens' | 'estimate';
  tokens: number;
  activeMs: number;
  wallMs: number;
  ttftMs: number | null;
  hasReasoning: boolean;
  endedAt: number;
};

type RateResponse = {
  connection: 'idle' | 'connecting' | 'live' | 'error';
  error: string | null;
  /** `network` when the origin could not be dialled at all; see `error`. */
  errorKind: 'network' | 'http' | 'closed' | null;
  sessionId: string | null;
  busy: boolean;
  waiting: 'permission' | 'question' | null;
  toolActive: boolean;
  live: Live;
  /** Running turn average; null when nothing has streamed yet this turn. */
  running: { tps: number; source: 'tokens' | 'estimate' } | null;
  /** Drawn curve owned by the service: one rate per bucket of the last 30 s. */
  curve: number[];
  /** Epoch ms of the first bucket; absent from an older service. */
  curveStart?: number;
  /** Bucket width in ms; absent from an older service. */
  curveStep?: number;
  /** Epoch ms the curve was computed at; absent from an older service. */
  curveAt?: number;
  /** Furthest epoch ms the edge may be projected to; absent from an older service. */
  curveParkAt?: number;
  /** Epoch ms of the newest chunk; null before the first one. */
  curveLastAt?: number | null;
  turn: { active: boolean; ttftMs: number | null };
  lastTurn: TurnResult | null;
  eventsSeen: number;
};

type HostSession = { id: string; title: string; busy: boolean } | null;

const COPY = {
  zh: {
    unit: 'tok/s',
    toolRunning: '工具执行中',
    waitingPermission: '等授权',
    waitingQuestion: '等回答',
    connecting: '连接中',
    reconnecting: '重连中',
    noService: '需在 设置 → 扩展 里允许本地服务',
    unreachable: '连不上服务端事件流',
    noData: '对话开始后显示',
    lastTurn: '上轮',
    ttft: '首字',
    measured: '实测',
    estimated: '估计',
    noReasoning: '无推理数据',
    inProgress: '进行中',
  },
  en: {
    unit: 'tok/s',
    toolRunning: 'running tool',
    waitingPermission: 'waiting for permission',
    waitingQuestion: 'waiting for answer',
    connecting: 'connecting',
    reconnecting: 'reconnecting',
    noService: 'Allow the local service in Settings → Extensions',
    unreachable: 'cannot reach the server stream',
    noData: 'shows once a turn runs',
    lastTurn: 'last',
    ttft: 'ttft',
    measured: 'measured',
    estimated: 'estimated',
    noReasoning: 'no reasoning data',
    inProgress: 'in progress',
  },
} as const;

type Copy = Record<keyof (typeof COPY)['zh'], string>;

const SPARK_W = 120;
const SPARK_H = 18;
/** Narrowest believable fallback window for a service that predates the timestamps. */
const SPARK_WINDOW_MS = 30_000;
/**
 * Silence after which the curve is not shown at all. It describes a stream;
 * with nothing streaming there is no shape to read, and a frozen profile left
 * on screen reads as if it were still working. Wider than a normal gap between
 * chunks, short enough that a finished turn clears at once.
 */
const SPARK_HIDE_MS = 4_000;
/** Floor between watch re-asserts, so a service that is down costs one call a second, not one per poll. */
const REASSERT_MIN_MS = 1_000;

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing #root');

let copy: Copy = COPY.zh;
let origin: string | null = null;
let session: HostSession = null;
let mounted = false;
let polling = false;
let stopped = false;
let configuredKey = '';
let configuring = false;
let lastReassertAt = 0;
let heightReported = false;
/** Latest curve from the service, when this page received it, and its full scale. */
let sparkFrame: SparkFrame | null = null;
let sparkFrameAt = 0;
let sparkScale = 1;
let sparkPaintedAt = 0;
/** Edge the last path was drawn against; equal again means nothing to redraw. */
let sparkDrawn = Number.NaN;
/** Epoch ms of the newest chunk, and whether the curve is currently hidden. */
let sparkLastAt = Number.NaN;
let sparkIdle = false;

const row1 = document.createElement('div');
row1.className = 'row';
const dot = document.createElement('span');
dot.className = 'dot';
const valueEl = document.createElement('span');
valueEl.className = 'value';
valueEl.textContent = '—';
const unitEl = document.createElement('span');
unitEl.className = 'unit';
const sparkEl = document.createElement('span');
sparkEl.className = 'spark';
const sparkParts = makeSparkSvg(SPARK_W, SPARK_H);
sparkEl.append(sparkParts.svg);
row1.append(dot, valueEl, unitEl, sparkEl);
let lastHeight = 0;

const row2 = document.createElement('div');
row2.className = 'row meta';
const stateEl = document.createElement('span');
const lastEl = document.createElement('span');
row2.append(stateEl, lastEl);

const resolveOrigin = (): string | null => {
  try {
    const url = new URL(window.location.href);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  } catch {
    // about:srcdoc, an opaque sandbox origin, or no window: nothing usable.
  }
  return null;
};

const formatTps = (tps: number): string => {
  if (!Number.isFinite(tps)) return '—';
  return tps >= 100 ? tps.toFixed(0) : tps.toFixed(1);
};

const formatSecs = (ms: number | null): string => {
  if (ms === null || !Number.isFinite(ms)) return '—';
  const s = ms / 1000;
  return s >= 10 ? `${s.toFixed(0)}s` : `${s.toFixed(1)}s`;
};

/**
 * The wire curve plus the clock it was measured against. A service older than
 * the timestamps is read as a window ending at now, which is what that service
 * meant, so a mid-update mix still draws something sane.
 */
const sparkFrameFrom = (rate: RateResponse): SparkFrame => {
  const step = rate.curveStep && rate.curveStep > 0 ? rate.curveStep : SPARK_WINDOW_MS / Math.max(1, rate.curve.length);
  const at = rate.curveAt ?? Date.now();
  const startAt = rate.curveStart ?? at - rate.curve.length * step;
  // A service that predates `curveParkAt` gets an unbounded edge, which draws
  // exactly what it used to; one that sends it stops the sweep with the data.
  const parkAt = rate.curveParkAt ?? Number.POSITIVE_INFINITY;
  return { values: rate.curve, startAt, stepMs: step, at, parkAt };
};

const dropSpark = (): void => {
  sparkFrame = null;
  sparkScale = 1;
  sparkDrawn = Number.NaN;
  sparkLastAt = Number.NaN;
  clearSparkPaths(sparkParts);
};

/**
 * Redraw between polls against a projected clock, so the curve slides instead
 * of stepping two pixels at a time four times a second. The point values stay
 * exactly what the service measured; only the window edge moves.
 *
 * The projection stops at `parkAt`, where the data stopped, and the whole
 * curve fades out `SPARK_HIDE_MS` after the newest chunk. What is left on
 * screen is either moving or gone, so motion always means tokens.
 */
const paintSpark = (): void => {
  if (stopped) return;
  const frame = sparkFrame;
  const at = performance.now();
  // Date.now() pairs with the service's own epoch stamps, unlike the
  // performance clock used for the projection.
  const idle = !(Date.now() - sparkLastAt <= SPARK_HIDE_MS);
  if (idle !== sparkIdle) {
    sparkIdle = idle;
    sparkEl.classList.toggle('is-idle', idle);
    // Coming back needs a draw even if the edge happens to match the last one.
    sparkDrawn = Number.NaN;
  }
  // ~30 fps is enough for a 2 px/slide and keeps a decorative curve from
  // repainting the whole section sixty times a second on an idle session.
  if (!idle && frame && frame.values.length > 0 && at - sparkPaintedAt >= 30) {
    const drawn = Math.min(frame.at + Math.min(2_000, at - sparkFrameAt), frame.parkAt);
    if (drawn !== sparkDrawn) {
      sparkPaintedAt = at;
      sparkDrawn = drawn;
      // Parked means the shape will not be drawn again: jump the scale to its
      // target instead of easing, which would keep the frozen curve growing.
      sparkScale = drawn >= frame.parkAt
        ? Math.max(1, ...frame.values)
        : nextScale(sparkScale, frame.values);
      drawSpark(sparkParts, frame, drawn, SPARK_W, SPARK_H, sparkScale);
    }
  }
  requestAnimationFrame(paintSpark);
};

const fitHeight = (): void => {
  const h = Math.min(320, Math.max(24, Math.ceil(root.scrollHeight) + 2));
  if (h !== lastHeight) {
    lastHeight = h;
    void host.setHeight(h).catch(() => undefined);
  }
};

const setState = (text: string): void => {
  // An empty state must not leave a flex gap behind in the meta row.
  stateEl.textContent = text;
  stateEl.hidden = text.length === 0;
};

const render = (rate: RateResponse | null, notice: string | null = null): void => {
  if (!rate) {
    dot.className = 'dot';
    valueEl.textContent = '—';
    setState(notice ?? copy.connecting);
    lastEl.textContent = '';
    dropSpark();
    fitHeight();
    return;
  }
  if (rate.connection === 'error') {
    dot.className = 'dot wait';
    // A network failure is a wrong address, not a bad response: name the
    // condition rather than leak the runtime's `fetch failed`.
    setState(
      rate.errorKind === 'network' ? copy.unreachable : (rate.error ?? copy.reconnecting),
    );
  } else if (rate.connection !== 'live') {
    dot.className = 'dot';
    setState(copy.connecting);
  } else if (rate.waiting === 'permission') {
    dot.className = 'dot wait';
    setState(copy.waitingPermission);
  } else if (rate.waiting === 'question') {
    dot.className = 'dot wait';
    setState(copy.waitingQuestion);
  } else if (rate.toolActive) {
    dot.className = 'dot live';
    setState(copy.toolRunning);
  } else {
    // "generating" and "idle" say nothing the dot and the headline do not
    // already say — they only stretched the meta line.
    dot.className = rate.busy ? 'dot live' : 'dot';
    setState('');
  }

  const live = rate.live.tps;
  const streaming = rate.busy && rate.waiting === null && live > 0.05;
  const turnActive = rate.busy || rate.toolActive;
  // Headline is the running turn average: stable across network jitter and
  // identical to the finalized average when the turn ends.
  const shown = rate.running ? rate.running.tps : (rate.lastTurn?.tokensPerSecond ?? NaN);
  const hasValue = Number.isFinite(shown) && shown > 0;
  valueEl.textContent = hasValue ? formatTps(shown) : '—';
  // Grey whenever tokens are not arriving, so the number does not read as a
  // live rate next to a curve that has already decayed towards zero.
  valueEl.className = hasValue && !streaming ? 'value stale' : 'value';

  // The curve is owned by the service: it survives iframe remounts and
  // session switches, and is a rolling rate window rather than turn history.
  // An empty curve means the answer belongs to no session, so nothing is drawn
  // rather than the previous session's shape being left on screen.
  sparkFrame = sparkFrameFrom(rate);
  sparkFrameAt = performance.now();
  sparkLastAt = rate.curveLastAt ?? Number.NaN;
  // A new answer can carry new point values at the same edge; redraw it.
  sparkDrawn = Number.NaN;
  if (sparkFrame.values.length === 0) dropSpark();

  // Second row: last-turn average + TTFT. Prefer the finished turn; while a
  // turn runs, show its TTFT so far.
  const lt = rate.lastTurn;
  const parts: string[] = [];
  if (lt) {
    parts.push(`${copy.lastTurn} ${formatTps(lt.tokensPerSecond)} (${lt.source === 'tokens' ? copy.measured : copy.estimated})`);
  }
  const ttft = rate.turn.active ? rate.turn.ttftMs : lt?.ttftMs ?? null;
  if (ttft !== null || lt) {
    parts.push(`${copy.ttft} ${formatSecs(ttft)}`);
  }
  if (lt && !lt.hasReasoning && lt.tokens > 0) {
    parts.push(copy.noReasoning);
  }
  lastEl.textContent = parts.length > 0 ? parts.join(' · ') : (turnActive ? copy.inProgress : copy.noData);

  if (notice) setState(notice);
  fitHeight();
};

const describeError = (error: unknown): string => {
  if (error instanceof HostRequestError) {
    if (error.code === 'NO_SERVICE' || error.code === 'SERVICE_FAILED') return copy.noService;
    if (error.code === 'DISABLED') return copy.noService;
    if (error.code === 'HOST_TIMEOUT') return copy.reconnecting;
    return `${error.code}`;
  }
  return error instanceof Error ? error.message : String(error);
};

/**
 * The same answer with everything session-scoped blanked; connection fields
 * stay. A page with no session must not read another session's live numbers,
 * and `sessionId` in the answer names the record the service actually read.
 */
const withoutSession = (rate: RateResponse): RateResponse => ({
  ...rate,
  busy: false,
  waiting: null,
  toolActive: false,
  live: { tps: 0, spanMs: 0, chars: 0, textChars: 0, reasoningChars: 0, toolChars: 0 },
  running: null,
  curve: [],
  curveLastAt: null,
  turn: { active: false, ttftMs: null },
  lastTurn: null,
});

const poll = async (): Promise<void> => {
  if (stopped || polling) return;
  // No origin is not a dead end: a relay client runs this page as a `srcDoc`,
  // where `window.location` is `about:srcdoc`. The service finds the server on
  // the machine that hosts it, so the page still asks and shows what it gets.
  polling = true;
  try {
    // Name the session so a page and a service holding different sessions
    // each read their own record instead of whichever one watched last.
    const result = await host.serviceRequest({
      method: 'GET',
      path: session?.id ? `/rate?sessionId=${encodeURIComponent(session.id)}` : '/rate',
    });
    if (result.status < 400) {
      const rate = JSON.parse(result.body) as RateResponse;
      // A page with no session must never show another session's numbers:
      // until this page's watch(null) lands, the service may still answer for
      // a session some other page watched.
      render(session === null && rate.sessionId !== null ? withoutSession(rate) : rate);
      // A service that restarted (crash, redeploy, spawned anew) remembers
      // nothing and answers with no session, so the panel would sit on stale
      // state until the frame remounted. Re-assert the watch instead: the
      // throttle holds a dead service to one call a second, and `configuring`
      // stops this from racing the opening /watch.
      if ((rate.sessionId ?? null) !== (session?.id ?? null)) {
        const now = Date.now();
        if (now - lastReassertAt >= REASSERT_MIN_MS) {
          lastReassertAt = now;
          configuredKey = '';
          await configure(session?.id ?? null);
        }
      }
    } else {
      render(null, `HTTP ${result.status}`);
    }
  } catch (error) {
    render(null, describeError(error));
  } finally {
    polling = false;
  }
};

const configure = async (sessionId: string | null): Promise<void> => {
  const key = `${origin ?? ''}|${sessionId ?? ''}`;
  if (key === configuredKey || configuring) return;
  configuring = true;
  try {
    await host.serviceRequest({
      method: 'POST',
      path: '/watch',
      body: JSON.stringify(origin ? { origin, sessionId } : { sessionId }),
    });
    configuredKey = key;
  } catch (error) {
    configuredKey = '';
    render(null, describeError(error));
  } finally {
    configuring = false;
  }
};

const mount = (): void => {
  root.append(row1, row2);
  unitEl.textContent = copy.unit;
  if (!heightReported) {
    heightReported = true;
    // Real height follows content via fitHeight() on every render.
    fitHeight();
  }
  stopped = false;
  void configure(session?.id ?? null);
  void poll();
  requestAnimationFrame(paintSpark);
  const loop = () => {
    if (stopped) return;
    window.setTimeout(async () => {
      await poll();
      loop();
    }, document.hidden ? 1000 : 250);
  };
  loop();
};

host.onReady((next) => {
  copy = next.locale.toLowerCase().startsWith('zh') ? COPY.zh : COPY.en;
  applyHostReady(next, document.documentElement);
  session = next.session ? { id: next.session.id, title: next.session.title, busy: next.session.busy } : null;
  origin = resolveOrigin();
  unitEl.textContent = copy.unit;
  if (!mounted) {
    mounted = true;
    mount();
    return;
  }
  void configure(session?.id ?? null);
});

host.onSession((next) => {
  session = next ? { id: next.id, title: next.title, busy: next.busy } : null;
  void configure(session?.id ?? null);
});
