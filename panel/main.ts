import { connectHost, HostRequestError } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { drawSpark, makeSparkSvg } from '../shared/spark';

const SPARK_W = 248;
const SPARK_H = 36;

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
  // Headline is the running turn average: stable across network jitter and
  // identical to the finalized average when the turn ends.
  const shown = rate.running ? rate.running.tps : (rate.lastTurn?.tokensPerSecond ?? NaN);
  bigEl.textContent = Number.isFinite(shown) && shown > 0 ? formatTps(shown) : '—';
  bigEl.className = Number.isFinite(shown) && shown > 0 ? 'big' : 'big muted';

  // The curve is owned by the service: it survives panel reloads and
  // session switches, and is a rolling rate window rather than turn history.
  drawSpark(sparkParts, rate.curve, SPARK_W, SPARK_H);

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

const poll = async (): Promise<void> => {
  if (stopped || polling) return;
  if (!origin) {
    render(null, copy.noOrigin);
    return;
  }
  polling = true;
  try {
    const result = await host.serviceRequest({ method: 'GET', path: '/rate' });
    if (result.status < 400) render(JSON.parse(result.body) as RateResponse);
    else render(null, `HTTP ${result.status}`);
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
