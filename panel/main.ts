import { connectHost, HostRequestError } from '@openchamber/sdk';
import { applyHostReady } from '@openchamber/sdk/ui';
import { createSparkAnimator, makeSparkSvg, type SparkFrame } from '../shared/spark';
import { createRefreshLoop, createView } from '../shared/refresh';
import { DEFAULT_OPTIONS, optionsFrom, type ViewOptions } from '../shared/options';
import {
  formatDayClock,
  formatDayCount,
  formatDayDate,
  formatDayTokens,
  localeFromTag,
  type DayPayload,
  type Locale,
} from '../shared/day';

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
  /** Conversation-wide cache accounting; null until a step settles. */
  cache?: CacheInfo | null;
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
    live: '实时', lastTurn: '上轮均值', ttft: '首字延迟',
    reasoning: '推理占比', connection: '连接', events: '事件',
    measured: '实测', estimated: '估计',
    noReasoning: '本轮无推理数据（模型未上报推理）',
    stepHit: '单步命中',
    totalHit: '累计命中',
    hitMiss: '命中 / 未命中',
    output: '输出',
    steps: '步数',
    subs: '子对话',
    cost: '费用',
    noData: '打开一个对话并让模型生成后显示',
    inProgress: '本轮进行中…',
    estimateNote: '实时值按字符数启发式换算（字符/4，按模型校准）；上轮均值优先用提供商上报的真实 token。',
    dayTitle: '今日 Token',
    dayUnit: 'Token',
    dayUpdated: '更新于',
    dayDetail: '今日明细',
    dayInput: '输入',
    dayOutput: '输出',
    dayReasoning: '推理',
    dayCacheRead: '缓存读取',
    dayCacheWrite: '缓存写入',
    dayTotal: '合计',
    dayHourly: '按小时',
    dayModels: '按模型',
    daySessions: '按会话',
    dayTurns: '轮对话',
    dayScanned: '已扫描',
    daySessionsUnit: '个会话',
    dayMessagesUnit: '条消息',
    dayNote: '口径：input + output + reasoning + 缓存读取 + 缓存写入，取提供商上报的已结算值；只统计本地自然日内完成的助手消息。',
    dayZero: '今天还没有已完成的对话',
    dayPartial: '（部分会话读取失败）',
    dayRefreshing: '刷新中',
    dayLoading: '统计中…',
    dayFailed: '暂时读不到用量',
    optCache: '命中率',
    optDay: '今日统计',
    optDetail: '上轮明细',
  },
  en: {
    title: 'Live TPS',
    unit: 'tok/s',
    idle: 'idle', generating: 'generating', toolRunning: 'running tool',
    waitingPermission: 'waiting for permission', waitingQuestion: 'waiting for answer',
    connecting: 'connecting', reconnecting: 'reconnecting',
    noService: 'Allow the local service in Settings → Extensions',
    live: 'live', lastTurn: 'last', ttft: 'TTFT',
    reasoning: 'reasoning share', connection: 'connection', events: 'events',
    measured: 'measured', estimated: 'estimated',
    noReasoning: 'No reasoning reported for this turn',
    stepHit: 'last-step hit',
    totalHit: 'total hit',
    hitMiss: 'hit / miss',
    output: 'output',
    steps: 'steps',
    subs: 'sub-sessions',
    cost: 'cost',
    noData: 'Open a chat and let the model generate',
    inProgress: 'Turn in progress…',
    estimateNote: 'Live values estimate tokens from characters (chars/4), corrected per model; last-turn averages prefer provider-reported tokens.',
    dayTitle: 'Token per Day',
    dayUnit: 'Token',
    dayUpdated: 'updated',
    dayDetail: "Today's breakdown",
    dayInput: 'input',
    dayOutput: 'output',
    dayReasoning: 'reasoning',
    dayCacheRead: 'cache read',
    dayCacheWrite: 'cache write',
    dayTotal: 'total',
    dayHourly: 'per hour',
    dayModels: 'by model',
    daySessions: 'by session',
    dayTurns: 'turns',
    dayScanned: 'scanned',
    daySessionsUnit: 'sessions',
    dayMessagesUnit: 'messages',
    dayNote: 'Counts input + output + reasoning + cache read + cache write as reported by the provider for assistant messages completed since local midnight.',
    dayZero: 'no completed turns today',
    dayPartial: '(some sessions could not be read)',
    dayRefreshing: 'refreshing',
    dayLoading: 'counting…',
    dayFailed: 'usage is unavailable',
    optCache: 'hits',
    optDay: 'today',
    optDetail: 'last turn',
  },
} as const;

type Copy = Record<keyof (typeof COPY)['zh'], string>;

const host = connectHost();
const view = createView();
const root = document.querySelector('#root');
if (!root) throw new Error('Missing #root');

let copy: Copy = COPY.zh;
let locale: Locale = 'zh';
let options: ViewOptions = { ...DEFAULT_OPTIONS };
let lastRate: RateResponse | null = null;
let origin: string | null = null;
let sessionId: string | null = null;
let mounted = false;
let configuredKey = '';
/** Floor between watch re-asserts, so a down service costs one call a second. */
let lastReassertAt = 0;
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
const spark = createSparkAnimator(sparkParts, SPARK_W, SPARK_H);
// The drawing keeps its 248-unit coordinate system; the element spans the
// panel and stretches the curve horizontally, so its width never needs
// measuring (or a resize observer) on a page that redraws every frame.
sparkParts.svg.setAttribute('width', '100%');
sparkParts.svg.setAttribute('preserveAspectRatio', 'none');
for (const path of [sparkParts.line, sparkParts.area]) {
  path.setAttribute('vector-effect', 'non-scaling-stroke');
}
sparkEl.append(sparkParts.svg);
const list = document.createElement('dl');
/** The label that belongs to each value row, so a hidden block hides both. */
const rowDts = new WeakMap<HTMLElement, HTMLElement>();
const row = (label: string): HTMLElement => {
  const dt = document.createElement('dt');
  dt.textContent = label;
  const dd = document.createElement('dd');
  dd.textContent = '—';
  rowDts.set(dd, dt);
  list.append(dt, dd);
  return dd;
};
const hideRow = (dd: HTMLElement, hidden: boolean): void => {
  if (dd.hidden !== hidden) dd.hidden = hidden;
  const dt = rowDts.get(dd);
  if (dt && dt.hidden !== hidden) dt.hidden = hidden;
};
const lastEl = row('');
const ttftEl = row('');
const reasoningEl = row('');
/** The two hit rates sit under the curve, not inside the value list. */
type CacheLine = {
  root: HTMLElement;
  label: HTMLElement;
  bar: HTMLElement;
  fill: HTMLElement;
  pct: HTMLElement;
  delta: HTMLElement;
};
const makeCacheLine = (): CacheLine => {
  const line = document.createElement('div');
  line.className = 'cacheline';
  const label = document.createElement('span');
  label.className = 'cache-name';
  const bar = document.createElement('span');
  bar.className = 'hitbar';
  const fill = document.createElement('span');
  fill.className = 'fill';
  bar.append(fill);
  const pct = document.createElement('span');
  pct.className = 'pct';
  pct.textContent = '—';
  const delta = document.createElement('span');
  delta.className = 'delta';
  line.append(label, bar, pct, delta);
  return { root: line, label, bar, fill, pct, delta };
};
const cacheBlock = document.createElement('div');
cacheBlock.className = 'cacheblock';
const stepLine = makeCacheLine();
const totalLine = makeCacheLine();
cacheBlock.append(stepLine.root, totalLine.root);
const hitMissEl = row('');
const outputEl = row('');
const stepsEl = row('');
const costEl = row('');
const connEl = row('');
const eventsEl = row('');
const noteEl = document.createElement('div');
noteEl.className = 'note';

/** The only place the options are edited; both frames follow the service. */
const optionsBar = document.createElement('div');
optionsBar.className = 'opts';
const optionBox = (key: keyof ViewOptions): HTMLInputElement => {
  const box = document.createElement('input');
  box.type = 'checkbox';
  const label = document.createElement('label');
  label.className = 'opt';
  label.append(box);
  const text = document.createElement('span');
  text.className = 'opt-text';
  label.append(text);
  optionsBar.append(label);
  box.addEventListener('change', () => {
    options = { ...options, [key]: box.checked };
    applyOptions();
    render(lastRate);
    void saveOptions();
  });
  return box;
};
const cacheBox = optionBox('cache');
const dayBox = optionBox('day');
const detailBox = optionBox('detail');
const optionLabels = (): void => {
  const spans = optionsBar.querySelectorAll('label .opt-text');
  const texts = [copy.optCache, copy.optDay, copy.optDetail];
  spans.forEach((span, i) => view.text(span as HTMLElement, texts[i] ?? ''));
};

const saveOptions = async (): Promise<void> => {
  try {
    await host.serviceRequest({
      method: 'POST',
      path: '/options',
      body: JSON.stringify(options),
    });
  } catch {
    // The service may be down; the next mount reads what it last saved.
  }
};

/** Show or hide each optional block, and keep the checkboxes in step. */
const applyOptions = (): void => {
  cacheBox.checked = options.cache;
  dayBox.checked = options.day;
  detailBox.checked = options.detail;
  const detail = options.detail;
  hideRow(lastEl, !detail);
  hideRow(ttftEl, !detail);
  hideRow(reasoningEl, !detail);
  hideRow(connEl, !detail);
  hideRow(eventsEl, !detail);
  view.hidden(noteEl, !detail);
  const cache = options.cache;
  view.hidden(cacheBlock, !cache);
  hideRow(hitMissEl, !cache);
  hideRow(outputEl, !cache);
  hideRow(stepsEl, !cache);
  hideRow(costEl, !cache);
  view.hidden(dayBlock, !options.day);
};

// --- the daily token block ----------------------------------------------------

const dayBlock = document.createElement('div');
dayBlock.className = 'dayblock';
const dayHead = document.createElement('div');
dayHead.className = 'dhead';
const dayTitleEl = document.createElement('h2');
const dayDateEl = document.createElement('span');
dayDateEl.className = 'ddate';
dayHead.append(dayTitleEl, dayDateEl);
const dayBigRow = document.createElement('div');
dayBigRow.className = 'dbigrow';
const dayBig = document.createElement('div');
dayBig.className = 'dbig muted';
dayBig.textContent = '—';
const dayUnitEl = document.createElement('span');
dayUnitEl.className = 'dunit';
dayBigRow.append(dayBig, dayUnitEl);
const daySub = document.createElement('div');
daySub.className = 'dsub';
const dayBody = document.createElement('div');
const dayFoot = document.createElement('div');
dayFoot.className = 'dfoot';
dayBlock.append(dayHead, dayBigRow, daySub, dayBody, dayFoot);

let dayPayload: DayPayload | null = null;
let dayNotice: string | null = null;

const dnode = <K extends keyof HTMLElementTagNameMap>(
  tag: K,
  className: string | null,
  text?: string,
): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

const dayShare = (value: number, total: number): number =>
  total > 0 ? Math.min(100, Math.round((value / total) * 100)) : 0;

const clearDayBody = (): void => {
  while (dayBody.firstChild) dayBody.removeChild(dayBody.firstChild);
};

const dayDetailBlock = (payload: DayPayload): HTMLElement => {
  const section = dnode('section', 'dsection');
  section.append(dnode('h3', null, copy.dayDetail));
  const dl = dnode('dl', 'detail');
  const rows: Array<[string, number]> = [
    [copy.dayInput, payload.today.input],
    [copy.dayOutput, payload.today.output],
    [copy.dayReasoning, payload.today.reasoning],
    [copy.dayCacheRead, payload.today.cacheRead],
    [copy.dayCacheWrite, payload.today.cacheWrite],
  ];
  for (const [label, value] of rows) {
    const dt = dnode('dt', null, label);
    const dd = dnode('dd', null, formatDayTokens(value, locale));
    if (value > 0) {
      dd.append(dnode('span', 'share', `${dayShare(value, payload.today.total)}%`));
    }
    dl.append(dt, dd);
  }
  dl.append(dnode('dt', 'strong', copy.dayTotal));
  dl.append(dnode('dd', 'strong', formatDayTokens(payload.today.total, locale)));
  section.append(dl);
  return section;
};

const dayHourlyBlock = (payload: DayPayload): HTMLElement => {
  const section = dnode('section', 'dsection');
  section.append(dnode('h3', null, copy.dayHourly));
  const chart = dnode('div', 'chart');
  const max = Math.max(...payload.hours, 1);
  for (let hour = 0; hour < 24; hour += 1) {
    const column = dnode('div', 'col');
    const value = payload.hours[hour] ?? 0;
    const fill = dnode('div', 'fill');
    fill.style.height = `${dayShare(value, max)}%`;
    column.append(fill);
    column.title = `${String(hour).padStart(2, '0')}:00 · ${formatDayTokens(value, locale)}`;
    chart.append(column);
  }
  section.append(chart);
  const axis = dnode('div', 'axis');
  for (const hour of [0, 6, 12, 18, 23]) {
    const mark = dnode('span', null, `${String(hour).padStart(2, '0')}:00`);
    mark.style.left = `${(hour / 23) * 100}%`;
    axis.append(mark);
  }
  section.append(axis);
  return section;
};

const dayRankBlock = (title: string, rows: Array<{ label: string; value: number }>): HTMLElement | null => {
  if (rows.length === 0) return null;
  const section = dnode('section', 'dsection');
  section.append(dnode('h3', null, title));
  const max = Math.max(...rows.map((row) => row.value), 1);
  for (const row of rows) {
    const line = dnode('div', 'rank');
    const name = dnode('span', 'rank-name', row.label);
    const track = dnode('span', 'rank-track');
    const fill = dnode('i', null);
    fill.style.width = `${dayShare(row.value, max)}%`;
    track.append(fill);
    const value = dnode('span', 'rank-val', formatDayTokens(row.value, locale));
    line.append(name, track, value);
    section.append(line);
  }
  return section;
};

const renderDay = (payload: DayPayload | null, message: string | null = null): void => {
  dayPayload = payload;
  dayNotice = message;
  clearDayBody();
  dayTitleEl.textContent = copy.dayTitle;
  dayUnitEl.textContent = copy.dayUnit;
  daySub.textContent = '';
  dayFoot.textContent = '';
  if (message && !payload) {
    dayBig.textContent = '—';
    dayBig.className = 'dbig muted';
    dayDateEl.textContent = '';
    daySub.textContent = message;
    return;
  }
  if (!payload) {
    dayBig.textContent = '—';
    dayBig.className = 'dbig muted';
    dayDateEl.textContent = '';
    daySub.textContent = copy.dayLoading;
    return;
  }
  dayDateEl.textContent = `${formatDayDate(payload.day, locale)} · ${copy.dayUpdated} ${formatDayClock(payload.updatedAt)}`;
  const statusBits: string[] = [];
  if (payload.refreshing) statusBits.push(copy.dayRefreshing);
  if (payload.today.messages > 0) {
    statusBits.push(`${formatDayCount(payload.today.messages, locale)} ${copy.dayTurns}`);
  }
  if (payload.scan.partial) statusBits.push(copy.dayPartial);
  daySub.textContent = statusBits.join(' · ');
  if (payload.error) {
    dayBig.textContent = '—';
    dayBig.className = 'dbig muted';
    const banner = dnode('div', 'dbanner', copy.dayFailed);
    banner.title = payload.error;
    dayBody.append(banner);
    return;
  }
  dayBig.textContent = formatDayTokens(payload.today.total, locale);
  dayBig.className = payload.today.total > 0 ? 'dbig' : 'dbig muted';
  if (payload.today.total === 0) {
    dayBody.append(dnode('div', 'dempty', copy.dayZero));
    return;
  }
  dayBody.append(dayDetailBlock(payload), dayHourlyBlock(payload));
  const models = dayRankBlock(copy.dayModels, payload.models.map((row) => ({
    label: row.model,
    value: row.total,
  })));
  if (models) dayBody.append(models);
  const sessions = dayRankBlock(copy.daySessions, payload.sessions.map((row) => ({
    label: row.title || row.id,
    value: row.total,
  })));
  if (sessions) dayBody.append(sessions);
  dayFoot.textContent = [
    copy.dayNote,
    `${copy.dayScanned} ${formatDayCount(payload.scan.sessions, locale)} ${copy.daySessionsUnit}`,
    `${formatDayCount(payload.scan.messages, locale)} ${copy.dayMessagesUnit}`,
  ].join(' · ');
};

/** One read when the frame mounts; every later change is pushed on `day`. */
const readDay = async (): Promise<void> => {
  try {
    const result = await host.serviceRequest({ method: 'GET', path: '/day' });
    if (result.status >= 400) {
      renderDay(null, `HTTP ${result.status}`);
      return;
    }
    renderDay(JSON.parse(result.body) as DayPayload, null);
  } catch (error) {
    renderDay(null, describeError(error));
  }
};

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

const formatPct = (value: number | null | undefined): string => (
  typeof value === 'number' && Number.isFinite(value) ? `${value.toFixed(1)}%` : '—'
);

const barWidth = (value: number | null | undefined): string => (
  `${Math.max(0, Math.min(100, typeof value === 'number' && Number.isFinite(value) ? value : 0))}%`
);

const formatTokens = (value: number): string => {
  if (!Number.isFinite(value) || value <= 0) return '0';
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}k`;
  return String(Math.round(value));
};

const paintCache = (info: CacheInfo | null | undefined): void => {
  const hasSteps = !!info && info.steps > 0;
  const hasRate = hasSteps && info !== null && info !== undefined && info.hit + info.miss > 0;
  view.hidden(cacheBlock, !hasRate);
  view.text(stepLine.label, copy.stepHit);
  view.text(totalLine.label, copy.totalHit);
  view.text(stepLine.pct, hasRate && info ? formatPct(info.last?.hitRate) : '—');
  view.text(totalLine.pct, hasRate && info ? formatPct(info.hitRate) : '—');
  view.width(stepLine.fill, hasRate ? barWidth(info?.last?.hitRate) : '0%');
  view.width(totalLine.fill, hasRate ? barWidth(info?.hitRate) : '0%');
  const delta = hasRate ? info?.last?.delta : null;
  if (typeof delta === 'number' && Number.isFinite(delta) && Math.abs(delta) >= 0.05) {
    view.text(stepLine.delta, `${delta >= 0 ? '↑' : '↓'}${Math.abs(delta).toFixed(1)}`);
    view.className(stepLine.delta, delta >= 0 ? 'delta up' : 'delta down');
  } else {
    view.text(stepLine.delta, '');
    view.className(stepLine.delta, 'delta');
  }
  if (!hasSteps || !info) {
    view.text(hitMissEl, '—');
    view.text(outputEl, '—');
    view.text(stepsEl, '—');
    view.text(costEl, '—');
    return;
  }
  view.text(hitMissEl, `${formatTokens(info.hit)} / ${formatTokens(info.miss)}`);
  view.text(outputEl, `${formatTokens(info.output)} tok`);
  view.text(stepsEl, info.sessions > 1
    ? `${info.steps} · ${copy.subs} ${info.sessions - 1}`
    : String(info.steps));
  view.text(costEl, info.cost > 0 ? `$${Number(info.cost.toFixed(4))}` : '—');
};

const render = (rate: RateResponse | null, notice: string | null = null): void => {
  lastRate = rate;
  applyOptions();
  if (!rate) {
    refresh.setActive(false);
    spark.update(null);
    view.className(dot, 'dot');
    view.text(stateText, notice ?? copy.connecting);
    paintCache(null);
    return;
  }
  if (rate.connection === 'error') {
    view.className(dot, 'dot wait');
    view.text(stateText, rate.error ?? copy.reconnecting);
  } else if (rate.connection !== 'live') {
    view.className(dot, 'dot');
    view.text(stateText, copy.connecting);
  } else if (rate.waiting === 'permission') {
    view.className(dot, 'dot wait');
    view.text(stateText, copy.waitingPermission);
  } else if (rate.waiting === 'question') {
    view.className(dot, 'dot wait');
    view.text(stateText, copy.waitingQuestion);
  } else if (rate.toolActive) {
    view.className(dot, 'dot live');
    view.text(stateText, copy.toolRunning);
  } else if (rate.busy) {
    view.className(dot, 'dot live');
    view.text(stateText, copy.generating);
  } else {
    view.className(dot, 'dot');
    view.text(stateText, copy.idle);
  }

  const live = rate.live.tps;
  // Full strength only while the model is emitting text or reasoning. Tool
  // arguments also land in `live.chars`, but the headline should not look
  // live while the model itself has stopped producing.
  const streaming = rate.busy && rate.waiting === null
    && (rate.live.textChars > 0 || rate.live.reasoningChars > 0);
  // Headline is the running turn average: stable across network jitter and
  // identical to the finalized average when the turn ends.
  const shown = rate.running ? rate.running.tps : (rate.lastTurn?.tokensPerSecond ?? NaN);
  const hasValue = Number.isFinite(shown) && shown > 0;
  view.text(bigEl, hasValue ? formatTps(shown) : '—');
  // Grey whenever tokens are not arriving. The number stays the running or
  // last average, but full strength made it read as a live rate while the
  // curve was already decaying: thinking, a tool run, or a finished turn.
  view.className(bigEl, hasValue ? (streaming ? 'big' : 'big stale') : 'big muted');

  // The curve is owned by the service: it survives panel reloads and
  // session switches, and is a rolling rate window rather than turn history.
  // An empty curve means the answer belongs to no session, so nothing is drawn
  // rather than the previous session's shape being left on screen.
  spark.update(sparkFrameFrom(rate));
  refresh.setActive(rate.busy || rate.toolActive || spark.moving);

  const lt = rate.lastTurn;
  view.text(lastEl, lt
    ? `${formatTps(lt.tokensPerSecond)} ${copy.unit} (${lt.source === 'tokens' ? copy.measured : copy.estimated})`
    : '—');
  const ttft = rate.turn.active ? rate.turn.ttftMs : lt?.ttftMs ?? null;
  view.text(ttftEl, ttft !== null || lt ? formatSecs(ttft) : '—');
  if (lt && lt.tokens > 0 && !lt.hasReasoning) {
    view.text(reasoningEl, copy.noReasoning);
  } else if (rate.live.chars > 0) {
    const share = rate.live.reasoningChars / Math.max(1, rate.live.chars);
    view.text(reasoningEl, `${(share * 100).toFixed(0)}%`);
  } else {
    view.text(reasoningEl, '—');
  }
  view.text(connEl, rate.connection);
  view.text(eventsEl, String(rate.eventsSeen));
  paintCache(rate.cache);
  if (notice) view.text(stateText, notice);
  if (!lt && !rate.busy) view.text(noteEl, copy.noData);
  else if (!lt) view.text(noteEl, copy.inProgress);
  else view.text(noteEl, copy.estimateNote);
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
  const requestedSession = sessionId;
  try {
    const result = await host.serviceRequest({
      method: 'GET',
      path: requestedSession ? `/rate?sessionId=${encodeURIComponent(requestedSession)}` : '/rate',
    });
    if (!refresh.visible || requestedSession !== sessionId) return;
    if (result.status < 400) {
      const rate = JSON.parse(result.body) as RateResponse;
      // A page with no session must never show another session's numbers:
      // until this page's watch(null) lands, the service may still answer for
      // a session some other page watched.
      render(sessionId === null && rate.sessionId !== null ? withoutSession(rate) : rate);
      // A restarted service remembers no watch (and no pushed day snapshots):
      // re-assert it and take one day snapshot, at most once a second.
      if ((rate.sessionId ?? null) !== (sessionId ?? null)) {
        const now = Date.now();
        if (now - lastReassertAt >= 1_000) {
          lastReassertAt = now;
          configuredKey = '';
          void readDay();
          await configure(sessionId);
        }
      }
    } else render(null, `HTTP ${result.status}`);
  } catch (error) {
    if (refresh.visible && requestedSession === sessionId) render(null, describeError(error));
  }
};

const configure = async (id: string | null): Promise<void> => {
  const key = `${origin ?? ''}|${id ?? ''}`;
  if (key === configuredKey) return;
  try {
    await host.serviceRequest({
      method: 'POST',
      path: '/watch',
      body: JSON.stringify(origin ? { origin, sessionId: id } : { sessionId: id }),
    });
    configuredKey = key;
  } catch (error) {
    configuredKey = '';
    render(null, describeError(error));
  }
};

const relabel = (): void => {
  const labels = [
    copy.lastTurn, copy.ttft, copy.reasoning,
    copy.hitMiss, copy.output, copy.steps, copy.cost,
    copy.connection, copy.events,
  ];
  list.querySelectorAll('dt').forEach((dt, i) => {
    if (i < labels.length) view.text(dt, labels[i]);
  });
  view.text(titleEl, copy.title);
  view.text(unitLine, copy.unit);
  optionLabels();
  renderDay(dayPayload, dayNotice);
};

const refresh = createRefreshLoop(root, poll, (visible) => {
  spark.setVisible(visible);
  dot.style.animationPlayState = visible ? 'running' : 'paused';
});

/** The optional blocks; both surfaces follow the service, never their own copy. */
const readOptions = async (): Promise<void> => {
  try {
    const result = await host.serviceRequest({ method: 'GET', path: '/options' });
    if (result.status < 400) options = optionsFrom(JSON.parse(result.body));
  } catch {
    // Keep the defaults; the service may not be up yet.
  }
  applyOptions();
  render(lastRate);
};

const mount = (): void => {
  relabel();
  applyOptions();
  root.append(titleEl, optionsBar, stateLine, bigEl, unitLine, sparkEl, cacheBlock, list, noteEl, dayBlock);
  host.onServiceEvent((event) => {
    if (event.topic === 'options') {
      const next = optionsFrom(event.data);
      const dayWasOff = !options.day;
      options = next;
      applyOptions();
      render(lastRate);
      if (dayWasOff && options.day) void readDay();
      return;
    }
    if (event.topic !== 'day' || !event.data || typeof event.data !== 'object') return;
    renderDay(event.data as unknown as DayPayload, null);
  });
  void configure(sessionId);
  void readOptions();
  void readDay();
  refresh.start();
};

host.onReady((next) => {
  locale = localeFromTag(next.locale);
  copy = COPY[locale];
  applyHostReady(next, document.documentElement);
  sessionId = next.session?.id ?? null;
  origin = resolveOrigin();
  relabel();
  if (!mounted) {
    mounted = true;
    mount();
    return;
  }
  renderDay(dayPayload, dayNotice);
  void configure(sessionId);
  refresh.wake();
});

host.onSession((next) => {
  const changed = sessionId !== (next?.id ?? null);
  sessionId = next?.id ?? null;
  void configure(sessionId);
  if (changed) refresh.wake();
});

host.onSessionLifecycle(() => refresh.wake());
