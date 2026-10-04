// Tiny SVG sparkline helper shared by the status section and the rail panel.
// No dependencies; the guest bundler inlines this into each entry.
export const SPARK_N = 24;

export function sparkPaths(values: number[], w: number, h: number, pad = 1): { line: string; area: string } {
  if (values.length === 0) return { line: '', area: '' };
  const max = Math.max(1, ...values);
  const n = values.length;
  const x = (i: number): number => (n === 1 ? w / 2 : pad + (i * (w - pad * 2)) / (n - 1));
  const y = (v: number): number => h - pad - (v / max) * (h - pad * 2);
  let line = '';
  values.forEach((v, i) => {
    line += `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(v).toFixed(1)} `;
  });
  const area = `${line}L${x(n - 1).toFixed(1)},${h} L${x(0).toFixed(1)},${h} Z`;
  return { line: line.trim(), area };
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
  const line = document.createElementNS(NS, 'path');
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
  values: number[],
  w: number,
  h: number,
): void {
  const { line, area } = sparkPaths(values, w, h);
  parts.line.setAttribute('d', line);
  parts.area.setAttribute('d', area);
}
