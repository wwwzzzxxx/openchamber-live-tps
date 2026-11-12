import { connectHost, HostRequestError } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { createSparkAnimator, makeSparkSvg, type SparkFrame } from '../shared/spark';
import { createRefreshLoop, createView } from '../shared/refresh';

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

type CachePoint = {
  at: number;
  sessionId: string;
  messageID: string;
  hit: number;
  miss: number;
  hitRate: number | null;
  delta: number | null;
  output: number;
  reasoning: number;
};

type CacheInfo = {
  startedAt: number | null;
  steps: number;
  sessions: number;
  hit: number;
  miss: number;
  hitRate: number | null;
  write: number;
  input: number;
  output: number;
  reasoning: number;
  cost: number;
  last: CachePoint | null;
  prevHitRate: number | null;
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
  turn: { active: boolean; ttftMs: number | null };
  lastTurn: TurnResult | null;
  /** Conversation-wide cache accounting; null until a step settles. */
  cache?: CacheInfo | null;
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
    stepHit: '单步',
    totalHit: '累计',
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
    stepHit: 'step',
    totalHit: 'total',
    inProgress: 'in progress',
  },
} as const;

type Copy = Record<keyof (typeof COPY)['zh'], string>;

const SPARK_W = 120;
const SPARK_H = 18;
/** Narrowest believable fallback window for a service that predates the timestamps. */
const SPARK_WINDOW_MS = 30_000;
/** Floor between watch re-asserts, so a service that is down costs one call a second, not one per poll. */
const REASSERT_MIN_MS = 1_000;

const host = connectHost();
const view = createView();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing #root');

let copy: Copy = COPY.zh;
let origin: string | null = null;
let session: HostSession = null;
let mounted = false;
let configuredKey = '';
let configuring = false;
let lastReassertAt = 0;

const row1 = document.createElement('div');
row1.className = 'row';
const dot = document.createElement('span');
dot.className = 'dot';
const valueEl = document.createElement('span');
valueEl.className = 'value';
valueEl.textContent = '—';
const unitEl = document.createElement('span');
unitEl.className = 'unit';
const sparkEl = document.createElement('div');
sparkEl.className = 'row sparkrow';
const sparkParts = makeSparkSvg(SPARK_W, SPARK_H);
const spark = createSparkAnimator(sparkParts, SPARK_W, SPARK_H);
// Same treatment as the panel: the drawing keeps its coordinate system and the
// element spans the section, so the curve reaches both edges.
sparkParts.svg.setAttribute('width', '100%');
sparkParts.svg.setAttribute('preserveAspectRatio', 'none');
for (const path of [sparkParts.line, sparkParts.area]) {
  path.setAttribute('vector-effect', 'non-scaling-stroke');
}
sparkEl.append(sparkParts.svg);
row1.append(dot, valueEl, unitEl);
let lastHeight = 0;

const row2 = document.createElement('div');
row2.className = 'row meta';
const stateEl = document.createElement('span');
const lastEl = document.createElement('span');
row2.append(stateEl, lastEl);

type CacheRow = {
  root: HTMLElement;
  label: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  pct: HTMLElement;
  delta: HTMLElement;
};

const makeCacheRow = (): CacheRow => {
  const root = document.createElement('div');
  root.className = 'row cache';
  const label = document.createElement('span');
  label.className = 'cache-label';
  const bar = document.createElement('span');
  bar.className = 'hitbar';
  const fill = document.createElement('span');
  fill.className = 'fill';
  bar.append(fill);
  const pct = document.createElement('span');
  pct.className = 'cache-pct';
  pct.textContent = '—';
  const delta = document.createElement('span');
  delta.className = 'cache-delta';
  root.append(label, bar, pct, delta);
  return { root, label, bar, fill, pct, delta };
};

const stepCache = makeCacheRow();
const totalCache = makeCacheRow();

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
  return { values: rate.curve, startAt, stepMs: step, at };
};

const dropSpark = (): void => {
  spark.update(null);
};

const fitHeight = (force = false): void => {
  const changed = view.takeChanges();
  if (!force && !changed) return;
  const h = Math.min(320, Math.max(24, Math.ceil(root.scrollHeight) + 2));
  if (h !== lastHeight) {
    lastHeight = h;
    void host.setHeight(h).catch(() => undefined);
  }
};

const setState = (text: string): void => {
  // An empty state must not leave a flex gap behind in the meta row.
  view.text(stateEl, text);
  view.hidden(stateEl, text.length === 0);
};

const formatPct = (value: number | null | undefined): string => (
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—'
);

const barWidth = (value: number | null | undefined): string => (
  `${Math.max(0, Math.min(100, typeof value === 'number' && Number.isFinite(value) ? value : 0))}%`
);

/**
 * The two cache rates: the last settled step (which may belong to a
 * sub-session) and the conversation total. Both are hidden when no step has
 * reported a cache block, rather than drawn as a misleading 0%.
 */
const paintCache = (info: CacheInfo | null | undefined): void => {
  const present = !!info && info.steps > 0 && info.hit + info.miss > 0;
  view.hidden(stepCache.root, !present);
  view.hidden(totalCache.root, !present);
  if (!present || !info) {
    view.text(stepCache.pct, '—');
    view.text(totalCache.pct, '—');
    view.text(stepCache.delta, '');
    view.hidden(stepCache.bar, true);
    view.hidden(totalCache.bar, true);
    return;
  }
  view.text(stepCache.label, copy.stepHit);
  view.text(totalCache.label, copy.totalHit);
  view.hidden(stepCache.bar, false);
  view.hidden(totalCache.bar, false);
  const last = info.last;
  view.width(stepCache.fill, barWidth(last?.hitRate));
  view.text(stepCache.pct, formatPct(last?.hitRate));
  const delta = last?.delta;
  if (typeof delta === 'number' && Number.isFinite(delta) && Math.abs(delta) >= 0.05) {
    view.text(stepCache.delta, `${delta >= 0 ? '↑' : '↓'}${Math.abs(delta).toFixed(1)}`);
    view.className(stepCache.delta, delta >= 0 ? 'cache-delta up' : 'cache-delta down');
  } else {
    view.text(stepCache.delta, '');
    view.className(stepCache.delta, 'cache-delta');
  }
  view.width(totalCache.fill, barWidth(info.hitRate));
  view.text(totalCache.pct, formatPct(info.hitRate));
  view.text(totalCache.delta, '');
};

const render = (rate: RateResponse | null, notice: string | null = null): void => {
  if (!rate) {
    refresh.setActive(false);
    view.className(dot, 'dot');
    view.text(valueEl, '—');
    setState(notice ?? copy.connecting);
    view.text(lastEl, '');
    paintCache(null);
    dropSpark();
    fitHeight();
    return;
  }
  if (rate.connection === 'error') {
    view.className(dot, 'dot wait');
    // A network failure is a wrong address, not a bad response: name the
    // condition rather than leak the runtime's `fetch failed`.
    setState(
      rate.errorKind === 'network' ? copy.unreachable : (rate.error ?? copy.reconnecting),
    );
  } else if (rate.connection !== 'live') {
    view.className(dot, 'dot');
    setState(copy.connecting);
  } else if (rate.waiting === 'permission') {
    view.className(dot, 'dot wait');
    setState(copy.waitingPermission);
  } else if (rate.waiting === 'question') {
    view.className(dot, 'dot wait');
    setState(copy.waitingQuestion);
  } else if (rate.toolActive) {
    view.className(dot, 'dot live');
    setState(copy.toolRunning);
  } else {
    // "generating" and "idle" say nothing the dot and the headline do not
    // already say — they only stretched the meta line.
    view.className(dot, rate.busy ? 'dot live' : 'dot');
    setState('');
  }

  const live = rate.live.tps;
  const streaming = rate.busy && rate.waiting === null && live > 0.05;
  const turnActive = rate.busy || rate.toolActive;
  // Headline is the running turn average: stable across network jitter and
  // identical to the finalized average when the turn ends.
  const shown = rate.running ? rate.running.tps : (rate.lastTurn?.tokensPerSecond ?? NaN);
  const hasValue = Number.isFinite(shown) && shown > 0;
  view.text(valueEl, hasValue ? formatTps(shown) : '—');
  // Grey whenever tokens are not arriving, so the number does not read as a
  // live rate next to a curve that has already decayed towards zero.
  view.className(valueEl, hasValue && !streaming ? 'value stale' : 'value');

  // The curve is owned by the service: it survives iframe remounts and
  // session switches, and is a rolling rate window rather than turn history.
  // An empty curve means the answer belongs to no session, so nothing is drawn
  // rather than the previous session's shape being left on screen.
  spark.update(sparkFrameFrom(rate));
  refresh.setActive(rate.busy || rate.toolActive || spark.moving);

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
  view.text(lastEl, parts.length > 0 ? parts.join(' · ') : (turnActive ? copy.inProgress : copy.noData));

  paintCache(rate.cache);

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
  turn: { active: false, ttftMs: null },
  lastTurn: null,
  cache: null,
});

const poll = async (): Promise<void> => {
  // No origin is not a dead end: a relay client runs this page as a `srcDoc`,
  // where `window.location` is `about:srcdoc`. The service finds the server on
  // the machine that hosts it, so the page still asks and shows what it gets.
  const requestedSession = session?.id ?? null;
  try {
    // Name the session so a page and a service holding different sessions
    // each read their own record instead of whichever one watched last.
    const result = await host.serviceRequest({
      method: 'GET',
      path: requestedSession ? `/rate?sessionId=${encodeURIComponent(requestedSession)}` : '/rate',
    });
    if (!refresh.visible || requestedSession !== (session?.id ?? null)) return;
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
    if (refresh.visible && requestedSession === (session?.id ?? null)) render(null, describeError(error));
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

const refresh = createRefreshLoop(root, poll, (visible) => {
  spark.setVisible(visible);
  dot.style.animationPlayState = visible ? 'running' : 'paused';
});

const mount = (): void => {
  root.append(row1, sparkEl, row2, stepCache.root, totalCache.root);
  view.text(unitEl, copy.unit);
  fitHeight(true);
  window.addEventListener('resize', () => fitHeight(true));
  void configure(session?.id ?? null);
  refresh.start();
};

host.onReady((next) => {
  copy = next.locale.toLowerCase().startsWith('zh') ? COPY.zh : COPY.en;
  applyHostReady(next, document.documentElement);
  session = next.session ? { id: next.session.id, title: next.session.title, busy: next.session.busy } : null;
  origin = resolveOrigin();
  view.text(unitEl, copy.unit);
  if (!mounted) {
    mounted = true;
    mount();
    return;
  }
  void configure(session?.id ?? null);
  fitHeight(true);
  refresh.wake();
});

host.onSession((next) => {
  const changed = (session?.id ?? null) !== (next?.id ?? null);
  session = next ? { id: next.id, title: next.title, busy: next.busy } : null;
  void configure(session?.id ?? null);
  if (changed) refresh.wake();
});

host.onSessionLifecycle(() => refresh.wake());
