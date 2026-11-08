// Tiny SVG sparkline helpers shared by the status section and the rail panel.
// No dependencies; the guest bundler inlines this into each entry.
export const SPARK_N = 24;

/**
 * One drawn curve: a rate per fixed slice of the rolling window.
 *
 * The buckets carry their own timestamps instead of being placed at
 * `index / (length - 1)`. That is the whole difference between a curve that
 * translates and one that wriggles: when the service anchored its 24 slices at
 * "now", every 250 ms poll re-cut the window at a new phase, so a single chunk
 * changed buckets and the shape deformed in place — a spike split across two
 * neighbouring points, then merged — while x never moved. Reading x off the
 * bucket's own clock makes a chunk's bucket a function of its timestamp, so its
 * height is fixed and only its x changes as the window advances.
 */
export type SparkFrame = {
  /** Rate of each bucket, oldest first. */
  values: number[];
  /** Epoch ms of the first bucket's start. */
  startAt: number;
  /** Bucket width in ms. */
  stepMs: number;
  /** Epoch ms the frame was computed at; the window's right edge. */
  at: number;
  /**
   * Epoch ms the edge may be projected to and no further — where the data
   * stopped. Without it a guest inching the edge forward with the wall clock
   * keeps the curve sweeping through a silence it no longer describes;
   * `Infinity` keeps an older service drawing exactly as it did.
   */
  parkAt: number;
};

const EMPTY = { line: '', area: '' };

/**
 * Path strings for one frame, with `now` as the right edge of the window.
 *
 * `now` need not be the service's own `at`: a guest that redraws between polls
 * passes a projected clock, which is what turns 250 ms of measured history into
 * a continuous pan instead of a four-steps-per-second stutter.
 */
export function sparkPaths(
  frame: SparkFrame,
  now: number,
  w: number,
  h: number,
  scale: number,
  pad = 1,
): { line: string; area: string } {
  const n = frame.values.length;
  if (n === 0) return EMPTY;
  const span = n * frame.stepMs;
  const left = now - span;
  // Each point sits at the end of its bucket: that is when its average is
  // known, so it appears at the right edge exactly as its bucket completes and
  // then drifts left with the window.
  const x = (i: number): number =>
    pad + ((frame.startAt + (i + 1) * frame.stepMs - left) / span) * (w - pad * 2);
  const y = (v: number): number => h - pad - (Math.max(0, v) / scale) * (h - pad * 2);
  let line = '';
  frame.values.forEach((v, i) => {
    line += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
  });
  const area = `${line}L${x(n - 1).toFixed(1)},${h} L${x(0).toFixed(1)},${h} Z`;
  return { line: line.trim(), area };
}

/**
 * Full-scale for the next frame.
 *
 * Growing immediately keeps a new peak from being clipped; shrinking slowly
 * keeps the rest of the curve from bobbing every time the peak bucket changes.
 * The ease is per redraw, so a caller drawing at 60 fps uses a slow one.
 */
export function nextScale(previous: number, values: number[]): number {
  const target = Math.max(1, ...values);
  if (!Number.isFinite(previous) || previous <= 0) return target;
  if (target >= previous) return target;
  return previous + (target - previous) * 0.03;
}

export function makeSparkSvg(w: number, h: number): { svg: SVGSVGElement; line: SVGPathElement; area: SVGPathElement } {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('width', String(w));
  svg.setAttribute('height', String(h));
  svg.setAttribute('viewBox', `0 0 ${w} ${h}`);
  svg.setAttribute('aria-hidden', 'true');
  const area = document.createElementNS(NS, 'path');
  area.setAttribute('class', 'spark-area');
  const line = document.createElementNS(NS, 'path') as SVGPathElement;
  line.setAttribute('class', 'spark-line');
  line.setAttribute('fill', 'none');
  line.setAttribute('stroke-width', '1.5');
  line.setAttribute('stroke-linejoin', 'round');
  line.setAttribute('stroke-linecap', 'round');
  svg.append(area, line);
  return { svg, line, area };
}

export function drawSpark(
  parts: { line: SVGPathElement; area: SVGPathElement },
  frame: SparkFrame,
  now: number,
  w: number,
  h: number,
  scale: number,
): void {
  const { line, area } = sparkPaths(frame, now, w, h, scale);
  parts.line.setAttribute('d', line);
  parts.area.setAttribute('d', area);
}

/** Drop the drawn curve; used when the answering record belongs to no session. */
export function clearSpark(parts: { line: SVGPathElement; area: SVGPathElement }): void {
  parts.line.setAttribute('d', '');
  parts.area.setAttribute('d', '');
}
