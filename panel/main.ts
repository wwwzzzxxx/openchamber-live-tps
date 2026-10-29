import { connectHost, HostRequestError } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { clearSpark as clearSparkPaths, drawSpark, makeSparkSvg, nextScale, type SparkFrame } from '../shared/spark';

const SPARK_W = 248;
const SPARK_H = 36;
/** Narrowest believable fallback step for a service that predates the timestamps. */
const SPARK_WINDOW_MS = 30_000;

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
  sessionId: string | null;
  busy: boolean;
  waiting: 'permission' | 'question' | null;
  toolActive: boolean;
  live: Live;
  running: { tps: number; source: 'tokens' | 'estimate' } | null;
  curve: number[];
  /** Epoch ms of the first bucket; absent from an older service. */
  curveStart?: number;
  /** Bucket width in ms; absent from an older service. */
  curveStep?: number;
  /** Epoch ms the curve was computed at; absent from an older service. */
  curveAt?: number;
  turn: { active: boolean; ttftMs: number | null };
  lastTurn: TurnResult | null;
  eventsSeen: number;
};

const COPY = {
  zh: {
    title: '实时 TPS',
    unit: 'tok/s',
    idle: '空闲', generating: '生成中', toolRunning: '工具执行中',
    waitingPermission: '等授权', waitingQuestion: '等回答',
    connecting: '连接中', reconnecting: '重连中',
    noService: '需在 设置 → 扩展 里允许本地服务',
    noOrigin: '当前页面连不上 OpenChamber 服务',
    live: '实时', lastTurn: '上轮均值', ttft: '首字延迟',
    reasoning: '推理占比', connection: '连接', events: '事件',
    measured: '实测', estimated: '估计',
    noReasoning: '本轮无推理数据（模型未上报推理）',
    noData: '打开一个对话并让模型生成后显示',
    inProgress: '本轮进行中…',
    estimateNote: '实时值按字符数启发式换算（字符/4，按模型校准）；上轮均值优先用提供商上报的真实 token。',
  },
  en: {
    title: 'Live TPS',
    unit: 'tok/s',
    idle: 'idle', generating: 'generating', toolRunning: 'running tool',
    waitingPermission: 'waiting for permission', waitingQuestion: 'waiting for answer',
    connecting: 'connecting', reconnecting: 'reconnecting',
    noService: 'Allow the local service in Settings → Extensions',
    noOrigin: 'Cannot reach the OpenChamber server from this surface',
    live: 'live', lastTurn: 'last', ttft: 'TTFT',
    reasoning: 'reasoning share', connection: 'connection', events: 'events',
    measured: 'measured', estimated: 'estimated',
    noReasoning: 'No reasoning reported for this turn',
    noData: 'Open a chat and let the model generate',
    inProgress: 'Turn in progress…',
    estimateNote: 'Live values estimate tokens from characters (chars/4), corrected per model; last-turn averages prefer provider-reported tokens.',
  },
} as const;

type Copy = Record<keyof (typeof COPY)['zh'], string>;

const host = connectHost();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing #root');

let copy: Copy = COPY.zh;
let origin: string | null = null;
let sessionId: string | null = null;
let mounted = false;
let polling = false;
let stopped = false;
let configuredKey = '';
/** Latest curve from the service, when this page received it, and its full scale. */
let sparkFrame: SparkFrame | null = null;
let sparkFrameAt = 0;
let sparkScale = 1;
let sparkPaintedAt = 0;
const titleEl = document.createElement('h1');
const stateLine = document.createElement('div');
const dot = document.createElement('span');
dot.className = 'dot';
const stateText = document.createElement('span');
stateLine.append(dot, stateText);
const bigEl = document.createElement('div');
bigEl.className = 'big muted';
bigEl.textContent = '—';
const unitLine = document.createElement('div');
unitLine.className = 'unit muted';
const sparkEl = document.createElement('div');
sparkEl.className = 'spark';
const sparkParts = makeSparkSvg(SPARK_W, SPARK_H);
sparkEl.append(sparkParts.svg);
const list = document.createElement('dl');
const row = (label: string): HTMLElement => {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = '—';
  list.append(dt, dd);
  return dd;
};
const lastEl = row('');
const ttftEl = row('');
const reasoningEl = row('');
const connEl = row('');
const eventsEl = row('');
const noteEl = document.createElement('div');
noteEl.className = 'note';

const resolveOrigin = (): string | null => {
  try {
    const url = new URL(window.location.href);
    if (url.protocol === 'http:' || url.protocol === 'https:') return url.origin;
  } catch { /* opaque sandbox origin */ }
  return null;
};

const formatTps = (tps: number): string => (!Number.isFinite(tps) ? '—' : tps >= 100 ? tps.toFixed(0) : tps.toFixed(1));
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

/**
 * Redraw between polls against a projected clock.
 *
 * The service answers every 250 ms, which is a fifth of a bucket: at one point
 * per poll the curve would jump two pixels at a time. Sliding the window edge
 * with the wall clock turns those jumps into a continuous pan, while the point
 * values stay exactly what the service measured.
 */
const paintSpark = (): void => {
  if (stopped) return;
  const frame = sparkFrame;
  const at = performance.now();
  // ~30 fps is enough for a 2 px/slide and keeps a decorative curve from
  // repainting the whole panel sixty times a second on an idle session.
  if (frame && frame.values.length > 0 && at - sparkPaintedAt >= 30) {
    sparkPaintedAt = at;
    const elapsed = Math.min(2_000, at - sparkFrameAt);
    sparkScale = nextScale(sparkScale, frame.values);
    drawSpark(sparkParts, frame, frame.at + elapsed, SPARK_W, SPARK_H, sparkScale);
  }
  requestAnimationFrame(paintSpark);
};

const render = (rate: RateResponse | null, notice: string | null = null): void => {
  if (!rate) {
    dot.className = 'dot';
    stateText.textContent = notice ?? copy.connecting;
    return;
  }
  if (rate.connection === 'error') {
    dot.className = 'dot wait';
    stateText.textContent = rate.error ?? copy.reconnecting;
  } else if (rate.connection !== 'live') {
    dot.className = 'dot';
    stateText.textContent = copy.connecting;
  } else if (rate.waiting === 'permission') {
    dot.className = 'dot wait';
    stateText.textContent = copy.waitingPermission;
  } else if (rate.waiting === 'question') {
    dot.className = 'dot wait';
    stateText.textContent = copy.waitingQuestion;
  } else if (rate.toolActive) {
    dot.className = 'dot live';
    stateText.textContent = copy.toolRunning;
  } else if (rate.busy) {
    dot.className = 'dot live';
    stateText.textContent = copy.generating;
  } else {
    dot.className = 'dot';
    stateText.textContent = copy.idle;
  }

  const live = rate.live.tps;
  const streaming = rate.busy && rate.waiting === null && live > 0.05;
  // Headline is the live rate, so the number and the sparkline read the same
  // activity: both drop to zero when the model stops emitting (think, tool,
  // or idle), instead of the number holding a stale turn average.
  const shown = live;
  bigEl.textContent = Number.isFinite(shown) && shown > 0 ? formatTps(shown) : '—';
  bigEl.className = Number.isFinite(shown) && shown > 0 ? 'big' : 'big muted';

  // The curve is owned by the service: it survives panel reloads and
  // session switches, and is a rolling rate window rather than turn history.
  // An empty curve means the answer belongs to no session, so nothing is drawn
  // rather than the previous session's shape being left on screen.
  sparkFrame = sparkFrameFrom(rate);
  sparkFrameAt = performance.now();
  if (sparkFrame.values.length === 0) {
    sparkFrame = null;
    clearSparkPaths(sparkParts);
  }

  const lt = rate.lastTurn;
  lastEl.textContent = lt
    ? `${formatTps(lt.tokensPerSecond)} ${copy.unit} (${lt.source === 'tokens' ? copy.measured : copy.estimated})`
    : '—';
  const ttft = rate.turn.active ? rate.turn.ttftMs : lt?.ttftMs ?? null;
  ttftEl.textContent = ttft !== null || lt ? formatSecs(ttft) : '—';
  if (lt && lt.tokens > 0 && !lt.hasReasoning) {
    reasoningEl.textContent = copy.noReasoning;
  } else if (rate.live.chars > 0) {
    const share = rate.live.reasoningChars / Math.max(1, rate.live.chars);
    reasoningEl.textContent = `${(share * 100).toFixed(0)}%`;
  } else {
    reasoningEl.textContent = '—';
  }
  connEl.textContent = rate.connection;
  eventsEl.textContent = String(rate.eventsSeen);
  if (notice) stateText.textContent = notice;
  if (!lt && !rate.busy) noteEl.textContent = copy.noData;
  else if (!lt) noteEl.textContent = copy.inProgress;
  else noteEl.textContent = copy.estimateNote;
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
});

const poll = async (): Promise<void> => {
  if (stopped || polling) return;
  if (!origin) {
    render(null, copy.noOrigin);
    return;
  }
  polling = true;
  try {
    const result = await host.serviceRequest({ method: 'GET', path: '/rate' });
    if (result.status < 400) {
      const rate = JSON.parse(result.body) as RateResponse;
      // A page with no session must never show another session's numbers:
      // until this page's watch(null) lands, the service may still answer for
      // a session some other page watched.
      render(sessionId === null && rate.sessionId !== null ? withoutSession(rate) : rate);
    } else render(null, `HTTP ${result.status}`);
  } catch (error) {
    render(null, describeError(error));
  } finally {
    polling = false;
  }
};

const configure = async (id: string | null): Promise<void> => {
  if (!origin) {
    render(null, copy.noOrigin);
    return;
  }
  const key = `${origin}|${id ?? ''}`;
  if (key === configuredKey) return;
  try {
    await host.serviceRequest({ method: 'POST', path: '/watch', body: JSON.stringify({ origin, sessionId: id }) });
    configuredKey = key;
  } catch (error) {
    configuredKey = '';
    render(null, describeError(error));
  }
};

const relabel = (): void => {
  const labels = [copy.lastTurn, copy.ttft, copy.reasoning, copy.connection, copy.events];
  list.querySelectorAll('dt').forEach((dt, i) => {
    if (i < labels.length) dt.textContent = labels[i];
  });
  titleEl.textContent = copy.title;
  unitLine.textContent = copy.unit;
};

const mount = (): void => {
  relabel();
  root.append(titleEl, stateLine, bigEl, unitLine, sparkEl, list, noteEl);
  stopped = false;
  void configure(sessionId);
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
  sessionId = next.session?.id ?? null;
  origin = resolveOrigin();
  relabel();
  if (!mounted) {
    mounted = true;
    mount();
    return;
  }
  void configure(sessionId);
});

host.onSession((next) => {
  sessionId = next?.id ?? null;
  void configure(sessionId);
});
