// Page smoke: run the built guest pages against a fake host frame, without a
// browser. The case that matters is the relay client: it mounts a guest as a
// self-contained `srcDoc`, so `window.location` is `about:srcdoc` and there is
// no http(s) origin to hand the service. The page must still ask for numbers
// instead of painting "cannot reach the server".
//
// Run: node scripts/page-smoke.mjs  (from the package root, after `bun run build`)
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const SESSION = 'ses_page';
const NO_ORIGIN_COPY = [
  '当前页面连不上 OpenChamber 服务',
  'Cannot reach the OpenChamber server from this surface',
];

let failures = 0;
const check = (name, cond, extra = '') => {
  if (cond) console.log(`ok   ${name}`);
  else {
    failures += 1;
    console.log(`FAIL ${name} ${extra}`);
  }
};

// --- a DOM small enough for these two pages ----------------------------------
const makeStats = () => ({ textWrites: 0, classWrites: 0, hiddenWrites: 0, styleWrites: 0, attributeWrites: 0, pathWrites: 0, layoutReads: 0, rafCallbacks: 0, rateRequests: 0 });

class Style {
  constructor(stats) { this.props = {}; this.stats = stats; }
  setProperty(name, value) { this.props[name] = String(value); this.stats.styleWrites += 1; }
  removeProperty(name) { delete this.props[name]; }
  getPropertyValue(name) { return this.props[name] ?? ''; }
  set width(value) { this.setProperty('width', value); }
  get width() { return this.getPropertyValue('width'); }
  set animationPlayState(value) { this.setProperty('animation-play-state', value); }
  get animationPlayState() { return this.getPropertyValue('animation-play-state'); }
}

class El {
  constructor(tag, stats) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.stats = stats;
    this.style = new Style(stats);
    this.dataset = {};
    this._className = '';
    this._text = '';
    this._hidden = false;
    this.attrs = {};
  }
  append(...nodes) { for (const node of nodes) this.children.push(node); }
  appendChild(node) { this.children.push(node); return node; }
  insertBefore(node) { this.children.push(node); return node; }
  removeChild(node) { this.children = this.children.filter((c) => c !== node); return node; }
  setAttribute(key, value) {
    this.attrs[key] = String(value);
    this.stats.attributeWrites += 1;
    if (key === 'd') this.stats.pathWrites += 1;
  }
  getAttribute(key) { return this.attrs[key] ?? null; }
  hasAttribute(key) { return Object.hasOwn(this.attrs, key); }
  removeAttribute(key) { delete this.attrs[key]; }
  addEventListener() {}
  removeEventListener() {}
  querySelectorAll(selector) {
    const found = [];
    const walk = (el) => {
      for (const child of el.children) {
        if (!(child instanceof El)) continue;
        if (selector === 'dt' && child.tagName === 'DT') found.push(child);
        walk(child);
      }
    };
    walk(this);
    return found;
  }
  set className(value) { this._className = value; this.stats.classWrites += 1; }
  get className() { return this._className; }
  set hidden(value) { this._hidden = value; this.stats.hiddenWrites += 1; }
  get hidden() { return this._hidden; }
  get scrollHeight() { this.stats.layoutReads += 1; return 0; }
  set textContent(value) { this._text = String(value); this.children = []; this.stats.textWrites += 1; }
  get textContent() { return this._text + this.children.map((child) => child.textContent).join(''); }
}

class MessageEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.data = init.data;
    this.source = init.source;
    this.origin = init.origin ?? '';
  }
}

const TOKENS = {
  background: '#111', elevated: '#222', foreground: '#eee', muted: '#999',
  subtle: '#333', border: '#444', hover: '#3a3a3a', active: '#4a4a4a',
  selection: '#555', selectionForeground: '#fff', focus: '#6af',
  primary: '#6af', primaryForeground: '#000', primaryText: '#6af',
  successText: '#3c3', warningText: '#cc3', errorText: '#f66', infoText: '#6af',
  success: '#3c3', warning: '#cc3', error: '#f66', info: '#6af',
  font: 'system-ui', mono: 'monospace', radius: '9px',
};

/** The number a fixed page must paint once the fake host answers `/rate`. */
const LIVE_TPS = 42.5;
const HOUR = 3_600_000;
const OPTIONS_ON = { cache: true, day: true, detail: true };
const OPTIONS_OFF = { cache: false, day: false, detail: false };
const DAY_START = (() => {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.getTime();
})();
const RATE = {
  connection: 'live',
  error: null,
  errorKind: null,
  sessionId: SESSION,
  busy: false,
  waiting: null,
  toolActive: false,
  live: { tps: LIVE_TPS, spanMs: 1000, chars: 12, textChars: 12, reasoningChars: 0, toolChars: 0 },
  running: { tps: LIVE_TPS, tokens: 12, durationMs: 1000 },
  curve: [],
  curveStart: Date.now(),
  curveStep: 1250,
  curveAt: Date.now(),
  turn: { active: false, ttftMs: null },
  lastTurn: null,
  cache: {
    startedAt: Date.now() - 60_000,
    steps: 8,
    sessions: 2,
    hit: 19_200,
    miss: 3_800,
    hitRate: 83.5,
    write: 0,
    output: 110,
    reasoning: 0,
    cost: 0,
    last: {
      at: Date.now(),
      sessionId: SESSION,
      messageID: 'msg_page',
      hit: 1_600,
      miss: 100,
      hitRate: 94.1,
      delta: 1.2,
    },
    prevHitRate: 92.9,
  },
  eventsSeen: 0,
};

/** Run one built bundle in a fake frame and collect what it posts to its host. */
const runGuest = (bundle, href, { session = { id: SESSION, title: 'page smoke', busy: false }, rate = RATE, options = OPTIONS_ON } = {}) => {
  const source = fs.readFileSync(path.join(ROOT, bundle), 'utf8');
  const stats = makeStats();
  let clock = 0;
  let nextId = 0;
  let holdRates = false;
  const timers = new Map();
  const animations = new Map();
  const observers = new Set();
  const posted = [];
  const listeners = [];
  const root = new El('div', stats);
  const documentElement = new El('html', stats);
  const document = {
    documentElement,
    hidden: false,
    querySelector: (selector) => (selector === '#root' ? root : null),
    createElement: (tag) => new El(tag, stats),
    createElementNS: (_ns, tag) => new El(tag, stats),
    addEventListener: (type, fn) => { listeners.push([type, fn]); },
    removeEventListener: () => {},
  };
  const location = new URL(href);
  const win = {
    location,
    document,
    parent: { postMessage: (message) => {
      posted.push(message);
      if (message.type === 'service-request' && message.payload?.path?.startsWith('/rate')) stats.rateRequests += 1;
    } },
    addEventListener: (type, fn) => { listeners.push([type, fn]); },
    removeEventListener: () => {},
    setTimeout: (fn, delay) => { const id = ++nextId; timers.set(id, { fn, at: clock + delay }); return id; },
    clearTimeout: (id) => timers.delete(id),
    setInterval: () => 0,
    clearInterval: () => {},
    requestAnimationFrame: (fn) => { const id = ++nextId; animations.set(id, fn); return id; },
    cancelAnimationFrame: (id) => animations.delete(id),
    performance: { now: () => clock },
    matchMedia: () => ({ matches: false, addEventListener() {}, removeEventListener() {} }),
    navigator: { userAgent: 'node' },
  };
  win.window = win;
  win.self = win;

  const sandbox = {
    window: win,
    self: win,
    document,
    location,
    parent: win.parent,
    MessageEvent,
    ResizeObserver: class { observe() {} unobserve() {} disconnect() {} },
    IntersectionObserver: class {
      constructor(callback) { this.callback = callback; }
      observe(target) { this.target = target; observers.add(this); }
      disconnect() { observers.delete(this); }
    },
    URL,
    TextEncoder,
    TextDecoder,
    performance: win.performance,
    navigator: win.navigator,
    requestAnimationFrame: win.requestAnimationFrame,
    cancelAnimationFrame: win.cancelAnimationFrame,
    setTimeout: win.setTimeout,
    clearTimeout: win.clearTimeout,
    setInterval: win.setInterval,
    clearInterval: win.clearInterval,
    queueMicrotask,
    console,
    globalThis: win,
  };
  vm.createContext(sandbox);

  let channel = null;
  let version = null;
  const dispatch = (data) => {
    const event = new MessageEvent('message', { data, source: win.parent });
    for (const [type, fn] of listeners.slice()) {
      if (type === 'message') fn(event);
    }
  };
  const reply = (request, payload) => {
    dispatch({ channel, v: version, type: 'result', id: request.id, ok: true, payload });
  };

  vm.runInContext(source, sandbox, { filename: bundle });
  const hello = posted.find((message) => message && message.type === 'hello');
  if (!hello) throw new Error(`${bundle} never posted hello`);
  channel = hello.channel;
  version = hello.v;

  dispatch({
    channel,
    v: version,
    type: 'ready',
    payload: {
      session,
      surface: 'status',
      connection: { connected: true, account: null },
      settings: {},
      locale: 'zh',
      theme: { mode: 'dark', tokens: TOKENS },
    },
  });

  // Answer the page the way the host proxy would. `/watch` is accepted without
  // an origin: that is what a relay surface has to send.
  const replied = new Set();
  const replyPending = (rateOverride) => {
    for (const request of posted.filter((message) => message && message.type === 'service-request')) {
      if (replied.has(request.id)) continue;
      if (request.payload?.path === '/watch') {
        replied.add(request.id);
        reply(request, { status: 200, body: JSON.stringify({ ok: true, changed: true, connection: 'live', sessionId: SESSION }) });
      } else if (request.payload?.path?.startsWith('/rate') && (!holdRates || rateOverride)) {
        replied.add(request.id);
        reply(request, { status: 200, body: JSON.stringify(rateOverride ?? rate) });
      } else if (request.payload?.path === '/day') {
        replied.add(request.id);
        reply(request, { status: 200, body: JSON.stringify(DAY) });
      } else if (request.payload?.path === '/options') {
        replied.add(request.id);
        reply(request, { status: 200, body: JSON.stringify(options) });
      }
    }
  };
  replyPending();
  const flush = async () => {
    for (let i = 0; i < 10; i += 1) { await Promise.resolve(); replyPending(); }
  };
  const event = (type) => {
    for (const [name, fn] of listeners.slice()) if (name === type) fn();
  };

  return {
    posted, stats, rootEl: root, root: () => root.textContent, flush,
    resetStats: () => Object.assign(stats, makeStats()),
    pendingFrames: () => animations.size,
    setRate: (next) => { rate = next; },
    holdRates: (next) => { holdRates = next; },
    replyRatesWith: (next) => replyPending(next),
    pushServiceEvent: (topic, data) => dispatch({ channel, v: version, type: 'service-event', payload: { topic, data } }),
    setDocumentHidden: (hidden) => { document.hidden = hidden; event('visibilitychange'); },
    setIntersecting: (visible) => {
      for (const observer of observers) observer.callback([{ target: observer.target, isIntersecting: visible, intersectionRatio: visible ? 1 : 0 }]);
    },
    setPageShown: (shown) => event(shown ? 'pageshow' : 'pagehide'),
    session: (next) => dispatch({ channel, v: version, type: 'session', payload: { session: next } }),
    lifecycle: (phase) => dispatch({ channel, v: version, type: 'session-lifecycle', payload: { sessionId: rate.sessionId, phase } }),
    advance: async (ms) => {
      const end = clock + ms;
      await flush();
      while (clock < end) {
        clock = Math.min(end, clock + 1_000 / 60);
        for (const [id, timer] of [...timers]) {
          if (timer.at <= clock) { timers.delete(id); timer.fn(); }
        }
        await flush();
        const frames = [...animations.values()];
        animations.clear();
        for (const fn of frames) { stats.rafCallbacks += 1; fn(clock); }
        await flush();
      }
    },
  };
};

const settle = async () => {
  for (let i = 0; i < 8; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

const findByClass = (node, className) => {
  if (String(node.className ?? '').split(/\s+/).includes(className)) return node;
  for (const child of node.children) {
    if (!(child instanceof El)) continue;
    const hit = findByClass(child, className);
    if (hit) return hit;
  }
  return null;
};

const widthOf = (node) => String(node?.style?.props?.width ?? node?.style?.width ?? '');

const findByText = (node, text) => {
  if (node.textContent === text) return node;
  for (const child of node.children) {
    if (!(child instanceof El)) continue;
    const hit = findByText(child, text);
    if (hit) return hit;
  }
  return null;
};

const DAY = {
  ok: true,
  day: '2026-11-07',
  dayStart: DAY_START,
  updatedAt: DAY_START + 10 * HOUR,
  refreshing: false,
  stale: false,
  error: null,
  today: {
    input: 1_973_524,
    output: 220_433,
    reasoning: 319_563,
    cacheRead: 111_932_144,
    cacheWrite: 0,
    total: 114_445_664,
    cost: 1.85,
    messages: 871,
  },
  hours: Array.from({ length: 24 }, (_, hour) => (hour === 8 ? 42_106_190 : hour === 9 ? 11_163_578 : 0)),
  models: [
    { key: 'amr-link/deepseek-v4.1-flash', provider: 'amr-link', model: 'deepseek-v4.1-flash', total: 88_000_000, output: 137_295, messages: 444 },
    { key: 'amr-link/deepseek-v4.1-flash-eco', provider: 'amr-link', model: 'deepseek-v4.1-flash-eco', total: 26_000_000, output: 28_784, messages: 60 },
  ],
  sessions: [
    { id: 'ses_a', title: '基因组项目受阻', total: 35_099_172, output: 79_336, messages: 201 },
    { id: 'ses_b', title: '当前公共区域', total: 5_185_206, output: 20_282, messages: 55 },
  ],
  scan: { sessions: 9, messages: 504, partial: false },
};

const SURFACES = [
  { name: 'status', bundle: 'status/main.js', url: 'http://127.0.0.1:28888/status/index.html' },
  { name: 'panel', bundle: 'panel/main.js', url: 'http://127.0.0.1:28888/panel/index.html' },
];

for (const surface of SURFACES) {
  // A normal browser surface knows its origin and keeps working as before.
  const direct = runGuest(surface.bundle, surface.url);
  await settle();
  const directWatch = direct.posted.find(
    (message) => message.type === 'service-request' && message.payload?.path === '/watch',
  );
  const directBody = directWatch ? JSON.parse(directWatch.payload.body) : null;
  check(`${surface.name}: an http page names its origin`, directBody?.origin === 'http://127.0.0.1:28888', JSON.stringify(directBody));
  check(`${surface.name}: an http page still shows the live number`, direct.root().includes(String(LIVE_TPS)), JSON.stringify(direct.root()));
  check(`${surface.name}: an http page never says it cannot reach the server`, !NO_ORIGIN_COPY.some((copy) => direct.root().includes(copy)), JSON.stringify(direct.root()));
  check(`${surface.name}: the daily block shows today's total`, direct.root().includes('1.1亿'), JSON.stringify(direct.root().slice(-400)));
  check(`${surface.name}: the daily block names the cache reads`, direct.root().includes('缓存读取'), JSON.stringify(direct.root().slice(-400)));
  check(`${surface.name}: the daily block names itself`, direct.root().includes(surface.name === 'status' ? '今日' : '今日 Token'), JSON.stringify(direct.root().slice(0, 200)));
  const dayRequests = direct.posted.filter((message) => message.type === 'service-request' && message.payload?.path === '/day').length;
  direct.pushServiceEvent('day', { ...DAY, today: { ...DAY.today, total: 220_000_000, cacheRead: 210_000_000 }, updatedAt: DAY_START + 11 * HOUR });
  await direct.flush();
  check(`${surface.name}: a pushed day snapshot repaints the total`, direct.root().includes('2.2亿'), JSON.stringify(direct.root().slice(-400)));
  check(`${surface.name}: a pushed day snapshot needs no poll`, direct.posted.filter((message) => message.type === 'service-request' && message.payload?.path === '/day').length === dayRequests, JSON.stringify(direct.posted.filter((m) => m.type === 'service-request').map((m) => m.payload?.path)));
  direct.pushServiceEvent('not-day', { today: { total: 1 } });
  await direct.flush();
  check(`${surface.name}: other topics do not repaint the day`, direct.root().includes('2.2亿'), JSON.stringify(direct.root().slice(-400)));
  const settledValue = findByText(direct.rootEl, String(LIVE_TPS));
  check(
    `${surface.name}: an idle kept number is drawn stale, not live`,
    settledValue !== null && settledValue.className.includes('stale'),
    JSON.stringify(settledValue && settledValue.className),
  );

  // A relay surface: the host hands the page over as a srcDoc, so there is no
  // http(s) origin at all. This is the regression: the page used to stop here.
  const relay = runGuest(surface.bundle, 'about:srcdoc');
  await settle();
  const relayWatch = relay.posted.find(
    (message) => message.type === 'service-request' && message.payload?.path === '/watch',
  );
  const relayBody = relayWatch ? JSON.parse(relayWatch.payload.body) : null;
  check(`${surface.name}: a relay srcDoc still asks the service to watch`, relayWatch !== undefined);
  check(
    `${surface.name}: the origin-less watch carries no bogus origin`,
    relayBody !== null && relayBody.origin === undefined,
    JSON.stringify(relayBody),
  );
  check(`${surface.name}: the origin-less watch still names its session`, relayBody?.sessionId === SESSION, JSON.stringify(relayBody));
  check(
    `${surface.name}: a relay srcDoc still polls /rate`,
    relay.posted.some((message) => message.type === 'service-request' && message.payload?.path?.startsWith('/rate')),
  );
  check(`${surface.name}: a relay srcDoc shows the live number`, relay.root().includes(String(LIVE_TPS)), JSON.stringify(relay.root()));
  check(
    `${surface.name}: a relay srcDoc no longer says it cannot reach the server`,
    !NO_ORIGIN_COPY.some((copy) => relay.root().includes(copy)),
    JSON.stringify(relay.root()),
  );
  // The two cache hit rates: last settled step and the conversation total,
  // each drawn with a progress bar.
  check(
    `${surface.name}: the last-step hit rate is drawn`,
    direct.root().includes('94.1'),
    JSON.stringify(direct.root()),
  );
  check(
    `${surface.name}: the conversation hit rate is drawn`,
    direct.root().includes('83.5'),
    JSON.stringify(direct.root()),
  );
  const lastBar = findByClass(direct.rootEl, 'hitbar');
  const totalBars = [];
  const collectBars = (node) => {
    if (String(node.className ?? '').includes('hitbar')) totalBars.push(node);
    for (const child of node.children) if (child instanceof El) collectBars(child);
  };
  collectBars(direct.rootEl);
  check(
    `${surface.name}: both hit rates carry a progress bar`,
    lastBar !== null && totalBars.length === 2,
    `bars=${totalBars.length}`,
  );
  const widths = totalBars.map((bar) => widthOf(findByClass(bar, 'fill')));
  check(
    `${surface.name}: the bars fill to their percentages`,
    widths.some((w) => w.startsWith('94.1')) && widths.some((w) => w.startsWith('83.5')),
    JSON.stringify(widths),
  );
  check(
    `${surface.name}: the per-step rate says which step it is`,
    direct.root().includes('单步') && direct.root().includes('累计'),
    JSON.stringify(direct.root()),
  );

  const relayValue = findByText(relay.rootEl, String(LIVE_TPS));
  check(
    `${surface.name}: a relay srcDoc keeps the stale styling`,
    relayValue !== null && relayValue.className.includes('stale'),
    JSON.stringify(relayValue && relayValue.className),
  );

  // A provider that has not reported any cache yet: no bars, just dashes.
  // The empty tracks used to render as stray ``— [bar] —`` rows.
  const noCache = runGuest(surface.bundle, surface.url, { rate: { ...RATE, cache: null } });
  await settle();
  const barHidden = [];
  const collect = (node, hidden) => {
    const nextHidden = hidden || node.hidden === true;
    if (String(node.className ?? '').split(/\s+/).includes('hitbar')) barHidden.push(nextHidden);
    for (const child of node.children) if (child instanceof El) collect(child, nextHidden);
  };
  collect(noCache.rootEl, false);
  check(
    `${surface.name}: no cache data draws no bars`,
    barHidden.length > 0 && barHidden.every(Boolean),
    `bars=${barHidden.length} hidden=${JSON.stringify(barHidden)}`,
  );
  check(
    `${surface.name}: no cache data writes no percentage`,
    !noCache.root().includes('94.1') && !noCache.root().includes('83.5'),
    JSON.stringify(noCache.root()),
  );

  // The section is also mounted with no chat open: the watch must still go out,
  // naming no session, instead of being suppressed along with the origin.
  const bare = runGuest(surface.bundle, 'about:srcdoc', { session: null });
  await settle();
  const bareWatch = bare.posted.find(
    (message) => message.type === 'service-request' && message.payload?.path === '/watch',
  );
  check(
    `${surface.name}: a relay srcDoc with no session still watches`,
    bareWatch !== undefined && JSON.parse(bareWatch.payload.body).sessionId === null,
    bareWatch ? bareWatch.payload.body : '(no watch)',
  );

  const quietRate = {
    ...RATE,
    curve: Array(24).fill(0),
    live: { tps: 0, spanMs: 0, chars: 0, textChars: 0, reasoningChars: 0, toolChars: 0 },
  };
  const activeRate = { ...RATE, busy: true, curve: Array(24).fill(LIVE_TPS) };
  const quiet = runGuest(surface.bundle, surface.url, { rate: quietRate });
  await quiet.flush();
  quiet.resetStats();
  await quiet.advance(10_000);
  check(`${surface.name}: ten idle seconds own no animation callback`, quiet.stats.rafCallbacks === 0 && quiet.pendingFrames() === 0, JSON.stringify(quiet.stats));
  check(`${surface.name}: identical idle answers cause no DOM writes or layout reads`,
    Object.entries(quiet.stats).filter(([key]) => !['rateRequests', 'rafCallbacks'].includes(key)).every(([, value]) => value === 0), JSON.stringify(quiet.stats));
  check(`${surface.name}: idle polling slows to once a second`, quiet.stats.rateRequests >= 9 && quiet.stats.rateRequests <= 10, JSON.stringify(quiet.stats));
  console.log(`metrics ${surface.name}: 10 idle seconds ${JSON.stringify(quiet.stats)}`);

  // A lifecycle event wakes the slower idle loop immediately, then live
  // responses keep the original 250 ms cadence and smooth panning.
  quiet.setRate(activeRate);
  quiet.resetStats();
  quiet.lifecycle('started');
  await quiet.flush();
  check(`${surface.name}: a new turn wakes idle polling immediately`, quiet.stats.rateRequests === 1, JSON.stringify(quiet.stats));
  await quiet.advance(1_000);
  check(`${surface.name}: an active curve still animates and polls promptly`, quiet.stats.pathWrites > 0 && quiet.stats.rafCallbacks > 0 && quiet.stats.rateRequests >= 4, JSON.stringify(quiet.stats));
  quiet.setRate(quietRate);
  await quiet.advance(300);
  quiet.resetStats();
  await quiet.advance(1_000);
  check(`${surface.name}: a decayed curve releases its animation loop`, quiet.stats.rafCallbacks === 0 && quiet.stats.pathWrites === 0 && quiet.pendingFrames() === 0, JSON.stringify(quiet.stats));

  const visibility = runGuest(surface.bundle, surface.url, { rate: activeRate });
  await visibility.flush();
  for (const [name, toggle] of [
    ['background document', (hidden) => visibility.setDocumentHidden(hidden)],
    ['collapsed iframe', (hidden) => visibility.setIntersecting(!hidden)],
    ['page history', (hidden) => visibility.setPageShown(!hidden)],
  ]) {
    toggle(true);
    visibility.resetStats();
    await visibility.advance(1_000);
    check(`${surface.name}: ${name} suspends polling and animation`, visibility.stats.rateRequests === 0 && visibility.stats.rafCallbacks === 0 && visibility.pendingFrames() === 0, JSON.stringify(visibility.stats));
    check(`${surface.name}: ${name} pauses the CSS status pulse`, findByClass(visibility.rootEl, 'dot').style.animationPlayState === 'paused');
    toggle(false);
    await visibility.flush();
    check(`${surface.name}: returning from ${name} requests fresh data immediately`, visibility.stats.rateRequests === 1, JSON.stringify(visibility.stats));
    await visibility.advance(100);
    check(`${surface.name}: returning from ${name} resumes the curve`, visibility.stats.pathWrites > 0, JSON.stringify(visibility.stats));
  }

  // A slow reply from the old chat must not repaint after a session switch;
  // the pending wake follows it with one request for the newly selected chat.
  const switching = runGuest(surface.bundle, surface.url, { rate: activeRate });
  await switching.flush();
  switching.holdRates(true);
  await switching.advance(300);
  switching.setRate({ ...quietRate, sessionId: 'ses_new', running: { ...RATE.running, tps: 55 } });
  switching.session({ id: 'ses_new', title: 'new chat', busy: false });
  switching.replyRatesWith({ ...activeRate, running: { ...RATE.running, tps: 99 } });
  await switching.flush();
  check(`${surface.name}: a late answer from the previous chat is ignored`, !switching.root().includes('99.0'), switching.root());
  switching.holdRates(false);
  await switching.flush();
  check(`${surface.name}: switching chat immediately fetches that chat's data`, switching.root().includes('55.0') && switching.posted.some((message) => message.payload?.path === '/rate?sessionId=ses_new'), switching.root());

  const stalled = runGuest(surface.bundle, surface.url, { rate: activeRate });
  await stalled.flush();
  stalled.holdRates(true);
  await stalled.advance(2_500);
  stalled.resetStats();
  await stalled.advance(1_000);
  check(`${surface.name}: a stalled service does not keep repainting a frozen curve`, stalled.stats.rafCallbacks === 0 && stalled.stats.pathWrites === 0 && stalled.pendingFrames() === 0, JSON.stringify(stalled.stats));
  stalled.holdRates(false);
  await stalled.advance(100);
  check(`${surface.name}: a recovered service starts the curve again`, stalled.stats.pathWrites > 0, JSON.stringify(stalled.stats));
}

// A fresh install shows the waveform alone; the blocks below it are opt-in.
const bareStatus = runGuest('status/main.js', SURFACES[0].url, { options: OPTIONS_OFF });
await bareStatus.flush();
check('status: the default view keeps the rate', bareStatus.root().includes(String(LIVE_TPS)), JSON.stringify(bareStatus.root()));
check('status: the default view hides the daily block', !bareStatus.root().includes('今日'), JSON.stringify(bareStatus.root()));
check('status: the default view hides the cache lines', !bareStatus.root().includes('缓存读取'), JSON.stringify(bareStatus.root()));
check('status: the default view hides the turn detail', !bareStatus.root().includes('上轮均值'), JSON.stringify(bareStatus.root()));
bareStatus.pushServiceEvent('options', OPTIONS_ON);
await bareStatus.flush();
check('status: turning the blocks on repaints them', bareStatus.root().includes('今日') && bareStatus.root().includes('缓存读取'), JSON.stringify(bareStatus.root()));

const barePanel = runGuest('panel/main.js', SURFACES[1].url, { options: OPTIONS_OFF });
await barePanel.flush();
check('panel: the default view hides today', findByClass(barePanel.rootEl, 'dayblock').hidden === true, JSON.stringify(barePanel.root().slice(0, 300)));
check('panel: the default view keeps the rate', barePanel.root().includes(String(LIVE_TPS)), JSON.stringify(barePanel.root().slice(0, 300)));
barePanel.pushServiceEvent('options', OPTIONS_ON);
await barePanel.flush();
check('panel: turning the blocks on repaints them', findByClass(barePanel.rootEl, 'dayblock').hidden === false, JSON.stringify(barePanel.root().slice(-300)));

console.log(failures === 0 ? '\nALL PAGE SMOKE TESTS PASSED' : `\n${failures} FAILURES`);
process.exit(failures === 0 ? 0 : 1);
