import { connectHost, HostRequestError } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { drawSpark, makeSparkSvg } from '../shared/spark';

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
  /** Drawn curve owned by the service: finished turns, plus the live window while streaming. */
  curve: number[];
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
    noOrigin: '当前页面连不上 OpenChamber 服务',
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
    noOrigin: 'Cannot reach the OpenChamber server from this surface',
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
    drawSpark(sparkParts, [], SPARK_W, SPARK_H);
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
  valueEl.textContent = Number.isFinite(shown) && shown > 0 ? formatTps(shown) : '—';
  valueEl.className = 'value';

  // The curve is owned by the service: it survives iframe remounts and
  // session switches. Just draw what it hands over.
  drawSpark(sparkParts, rate.curve, SPARK_W, SPARK_H);

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

const poll = async (): Promise<void> => {
  if (stopped || polling) return;
  if (!origin) {
    render(null, copy.noOrigin);
    return;
  }
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
      render(rate);
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
  if (!origin) {
    render(null, copy.noOrigin);
    return;
  }
  const key = `${origin}|${sessionId ?? ''}`;
  if (key === configuredKey || configuring) return;
  configuring = true;
  try {
    await host.serviceRequest({
      method: 'POST',
      path: '/watch',
      body: JSON.stringify({ origin, sessionId }),
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
