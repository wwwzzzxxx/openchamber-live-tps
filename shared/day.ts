/**
 * The daily-token side of Live TPS: provider-reported usage for the local
 * calendar day, kept by the service and rendered by the status and panel
 * frames. Nothing here estimates tokens; every number is a settled provider
 * report for an assistant message completed today.
 */

/** The two copy decks the guest frames ship. Anything else falls back to `en`. */
export type Locale = 'zh' | 'en';

/** Host language tag (`zh`, `zh-CN`, `zh-Hans`, …) to a copy deck. */
export const localeFromTag = (tag: string | null | undefined): Locale =>
  (tag ?? '').toLowerCase().startsWith('zh') ? 'zh' : 'en';

/** One provider-reported token breakdown for the local day. */
export type DayTotals = {
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + output + reasoning + cache read + cache write. */
  total: number;
  /** Provider-reported cost when the model has a price; 0 otherwise. */
  cost: number;
  /** Assistant messages completed today. */
  messages: number;
};

export type DayModelRow = {
  /** `provider/model`, stable across model switches. */
  key: string;
  provider: string;
  model: string;
  total: number;
  output: number;
  messages: number;
};

export type DaySessionRow = {
  id: string;
  title: string;
  total: number;
  output: number;
  messages: number;
};

/** What the service answers on `GET /day` and pushes on the `day` topic. */
export type DayPayload = {
  ok: boolean;
  /** Local calendar day, `YYYY-MM-DD`. */
  day: string;
  /** Epoch ms of local midnight for `day`. */
  dayStart: number;
  /** Epoch ms this aggregate was built. */
  updatedAt: number;
  refreshing: boolean;
  /** The payload predates the current day and is being rebuilt. */
  stale: boolean;
  error: string | null;
  today: DayTotals;
  /** Total tokens per local hour, 0..23. Future hours are 0. */
  hours: number[];
  models: DayModelRow[];
  sessions: DaySessionRow[];
  scan: { sessions: number; messages: number; partial: boolean };
};

/** One decimal, and no trailing `.0`, so `1340` stays readable. */
const round1 = (n: number): number => Math.round(n * 10) / 10;

const label = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(1));

/**
 * Compact token counts, in the unit each language actually reads:
 *
 * - English groups by thousands (`1.2k`, `13.4M`, `1.4B`).
 * - Chinese groups by 万 / 亿 (`1.2万`, `1340万`, `1.4亿`), which is how counts
 *   are spoken and written here; `13.4M` is not a Chinese reading.
 *
 * Below 10 000 both languages print the exact number: it is short enough and
 * more useful than a rounded unit.
 */
export const formatDayTokens = (n: number, locale: Locale = 'en'): string => {
  if (!Number.isFinite(n) || n <= 0) return '0';
  if (n < 10_000) return String(Math.round(n));
  if (locale === 'zh') {
    const wan = round1(n / 10_000);
    if (n < 100_000_000 && wan < 10_000) return `${label(wan)}万`;
    const yi = round1(n / 100_000_000);
    if (yi < 10_000) return `${label(yi)}亿`;
    return `${label(round1(n / 1_000_000_000_000))}万亿`;
  }
  if (n < 1_000_000) return `${label(round1(n / 1_000))}k`;
  const million = round1(n / 1_000_000);
  if (million < 1_000) return `${label(million)}M`;
  return `${label(round1(n / 1_000_000_000))}B`;
};

/** `09:45` in the viewer's local time. */
export const formatDayClock = (ts: number): string => {
  if (!Number.isFinite(ts) || ts <= 0) return '—';
  const d = new Date(ts);
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
};

/**
 * A `YYYY-MM-DD` day as the locale writes it: `11月13日` or `Nov 13`.
 * Falls back to the raw key when it is not a calendar day.
 */
export const formatDayDate = (day: string, locale: Locale = 'en'): string => {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!match) return day;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  if (Number.isNaN(date.getTime())) return day;
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en-US', {
    month: 'short',
    day: 'numeric',
  }).format(date);
};

/** Counts with the viewer's digit grouping (`8,712`). */
export const formatDayCount = (n: number, locale: Locale = 'en'): string =>
  new Intl.NumberFormat(locale === 'zh' ? 'zh-CN' : 'en-US', { maximumFractionDigits: 0 }).format(
    Math.round(Number.isFinite(n) ? n : 0),
  );

/** Local calendar day key for an epoch-ms timestamp, `YYYY-MM-DD`. */
export const dayKeyLocal = (ts: number): string => {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** Epoch ms of local midnight for the day containing `ts`. */
export const dayStartLocal = (ts: number): number => {
  const d = new Date(ts);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
};

/** The hourly buckets of `dayStart`, 0..23, as `HH` labels for the panel. */
export const hourLabels = (hours: number[]): string[] =>
  hours.map((_, hour) => `${String(hour).padStart(2, '0')}:00`);
