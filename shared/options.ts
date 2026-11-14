/**
 * Which optional blocks the frames draw.
 *
 * The waveform (the headline rate and its curve) is the extension's base:
 * these three blocks sit under it and are off until the user asks for them,
 * so a fresh install shows exactly one thing. Settings live in the service
 * (`GET`/`POST /options`) so both surfaces agree without polling, and so the
 * service can skip the daily history read while the day block is off.
 */
export type ViewOptions = {
  /** The two cache hit-rate lines and their numbers. */
  cache: boolean;
  /** The daily provider-reported token block. */
  day: boolean;
  /** The turn line: last average, TTFT, reasoning share, and the note. */
  detail: boolean;
};

export const DEFAULT_OPTIONS: ViewOptions = { cache: false, day: false, detail: false };

/** Accept the service's answer; anything unreadable keeps the defaults. */
export const optionsFrom = (value: unknown): ViewOptions => {
  if (!value || typeof value !== 'object') return { ...DEFAULT_OPTIONS };
  const raw = value as Record<string, unknown>;
  return {
    cache: raw.cache === true,
    day: raw.day === true,
    detail: raw.detail === true,
  };
};

export const sameOptions = (a: ViewOptions, b: ViewOptions): boolean =>
  a.cache === b.cache && a.day === b.day && a.detail === b.detail;
