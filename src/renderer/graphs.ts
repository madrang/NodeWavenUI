/**
 * The Graphs window: an SVG surface that agents draw on through the `nodewavenGraphs` page global.
 * The page opens empty. Every drawing method replaces the current graph, and the drawing classes
 * reference the theme palette, so the colors follow the active app theme (see docs/graphs.md).
 */

import { requireElement } from './dom.js';
import { resolveThemeId, THEME_MIRROR_KEY } from './theme.js';

/** One series of a line or scatter graph: points as [x, y] pairs, with an optional legend name. */
export interface GraphSeries {
  readonly name?: string;
  readonly points: readonly (readonly [number, number])[];
}

/** The spec of one line graph: one or more series drawn as polylines. */
export interface LineGraphSpec {
  readonly title?: string;
  readonly series: readonly GraphSeries[];
}

/** The spec of one scatter graph: one or more series drawn as point markers. */
export interface ScatterGraphSpec {
  readonly title?: string;
  readonly series: readonly GraphSeries[];
}

/** One bar of a bar graph. */
export interface GraphBar {
  readonly label: string;
  readonly value: number;
}

/** The spec of one bar graph: labelled values on a zero baseline. */
export interface BarGraphSpec {
  readonly title?: string;
  readonly bars: readonly GraphBar[];
}

/** The drawing surface and the empty hint of the page. */
const surface = requireElement<SVGSVGElement>('#graph-root');
const emptyHint = requireElement<HTMLElement>('#graph-empty');

/** The view box of the drawing surface. */
const VIEW_WIDTH = 1000;
const VIEW_HEIGHT = 620;

/** The plot margins inside the view box: room for the axis labels. The top margin follows the title and the legend. */
const MARGIN = { left: 70, right: 24, bottom: 42 } as const;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isPoint(value: unknown): value is readonly [number, number] {
  return Array.isArray(value) && value.length === 2 && isFiniteNumber(value[0]) && isFiniteNumber(value[1]);
}

/**
 * Checks that a value is a non-empty list of series, each with a non-empty point list.
 *
 * @param value The value to check. It can have any type, because agents build it from JSON.
 * @returns True when every series carries valid points and an optional string name.
 */
function isSeriesList(value: unknown): value is readonly GraphSeries[] {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  return value.every((series) => {
    if (typeof series !== 'object' || series === null) {
      return false;
    }
    const record = series as Record<string, unknown>;
    const name = record['name'];
    const points = record['points'];
    return (name === undefined || typeof name === 'string') && Array.isArray(points) && points.length > 0 && points.every(isPoint);
  });
}

/**
 * Checks that a value is a non-empty bar list with string labels and finite values.
 *
 * @param value The value to check. It can have any type, because agents build it from JSON.
 * @returns True when every bar carries a non-empty label and a finite value.
 */
function isBarList(value: unknown): value is readonly GraphBar[] {
  if (!Array.isArray(value) || value.length === 0) {
    return false;
  }
  return value.every((bar) => {
    if (typeof bar !== 'object' || bar === null) {
      return false;
    }
    const record = bar as Record<string, unknown>;
    return typeof record['label'] === 'string' && record['label'].length > 0 && isFiniteNumber(record['value']);
  });
}

/** Reads the optional title of a spec. Throws on a non-string title. */
function readTitle(spec: Record<string, unknown>): string | null {
  const title = spec['title'];
  if (title === undefined || title === null) {
    return null;
  }
  if (typeof title !== 'string') {
    throw new Error('The graph title must be a string.');
  }
  return title;
}

/** One axis scale: values between min and max map linearly onto the pixel span from "from" to "to". */
interface Scale {
  readonly min: number;
  readonly max: number;
  readonly from: number;
  readonly to: number;
}

/** Maps one value through a scale. */
function map(scale: Scale, value: number): number {
  return scale.from + ((value - scale.min) / (scale.max - scale.min)) * (scale.to - scale.from);
}

/** Builds a scale over a value range, widened by one on both sides when the range is empty. */
function scaleOf(min: number, max: number, from: number, to: number): Scale {
  if (min === max) {
    return { min: min - 1, max: max + 1, from, to };
  }
  return { min, max, from, to };
}

/** Chooses a readable step (1, 2, or 5 times a power of ten) for one axis range. */
function niceStep(span: number): number {
  const raw = span / 5;
  const power = 10 ** Math.floor(Math.log10(raw));
  const unit = raw / power;
  const factor = unit <= 1 ? 1 : unit <= 2 ? 2 : unit <= 5 ? 5 : 10;
  return factor * power;
}

/** Builds the tick values of one axis range. */
function ticksFor(min: number, max: number): readonly number[] {
  const step = niceStep(max - min);
  const ticks: number[] = [];
  const first = Math.ceil(min / step) * step;
  for (let value = first; value <= max + step * 1e-9; value += step) {
    ticks.push(Number(value.toFixed(10)));
  }
  return ticks;
}

/** Formats one tick value for the step it came from. Steps only carry the digits 1, 2, and 5. */
function formatTick(value: number, step: number): string {
  const decimals = Math.max(0, Math.min(6, -Math.floor(Math.log10(step))));
  return value.toFixed(decimals);
}

function svgElement<T extends keyof SVGElementTagNameMap>(
  tag: T,
  attributes: Record<string, string | number>,
): SVGElementTagNameMap[T] {
  const element = document.createElementNS('http://www.w3.org/2000/svg', tag);
  for (const [name, value] of Object.entries(attributes)) {
    element.setAttribute(name, String(value));
  }
  return element;
}

function svgText(x: number, y: number, text: string, className: string, anchor = 'middle'): SVGTextElement {
  const element = svgElement('text', { x, y, class: className, 'text-anchor': anchor });
  element.textContent = text;
  return element;
}

/** The plot rectangle of one drawing. */
interface Plot {
  readonly x0: number;
  readonly x1: number;
  readonly y0: number;
  readonly y1: number;
}

/** One legend entry: the series name and the series index that carries its color class. */
interface LegendEntry {
  readonly name: string;
  readonly seriesIndex: number;
}

/** Draws the grid lines, the axes, and the tick labels of one plot into the given parent. */
function drawFrame(
  parent: SVGElement,
  plot: Plot,
  yScale: Scale,
  xLabels: readonly { readonly at: number; readonly text: string }[],
): void {
  const yStep = niceStep(yScale.max - yScale.min);
  for (const tick of ticksFor(yScale.min, yScale.max)) {
    const y = map(yScale, tick);
    parent.append(svgElement('line', { x1: plot.x0, y1: y, x2: plot.x1, y2: y, class: tick === 0 ? 'axis' : 'grid' }));
    parent.append(svgText(plot.x0 - 8, y + 4, formatTick(tick, yStep), 'axis-label', 'end'));
  }
  parent.append(svgElement('line', { x1: plot.x0, y1: plot.y0, x2: plot.x0, y2: plot.y1, class: 'axis' }));
  parent.append(svgElement('line', { x1: plot.x0, y1: plot.y1, x2: plot.x1, y2: plot.y1, class: 'axis' }));
  for (const label of xLabels) {
    parent.append(svgText(label.at, plot.y1 + 18, label.text, 'axis-label'));
  }
}

/** Draws the title and the legend of one drawing. Returns the top edge of the plot. */
function drawHead(plot: Plot, title: string | null, legend: readonly LegendEntry[]): number {
  if (title !== null) {
    surface.append(svgText(VIEW_WIDTH / 2, 26, title, 'graph-title'));
  }
  const legendY = title !== null ? 48 : 16;
  let x = plot.x1;
  for (const entry of [...legend].reverse()) {
    const label = svgText(x, legendY, entry.name, 'legend-text', 'end');
    surface.append(label);
    // The swatch follows the rendered text width, so it never crosses its own or the neighbor label.
    const textWidth = label.getComputedTextLength();
    surface.append(
      svgElement('line', {
        x1: x - textWidth - 14,
        y1: legendY - 4,
        x2: x - textWidth - 4,
        y2: legendY - 4,
        'stroke-width': 3,
        class: `line-series-${entry.seriesIndex % 6}`,
      }),
    );
    x -= textWidth + 34;
  }
  return title !== null ? 62 : 26;
}

/** Draws one series list as polylines (line) or point markers (scatter). */
function drawSeriesPlot(spec: LineGraphSpec | ScatterGraphSpec, markers: boolean): string {
  if (!isSeriesList(spec.series)) {
    throw new Error('The graph needs a series list: [{ name, points: [[x, y], ...] }, ...] with at least one point per series.');
  }
  const allPoints = spec.series.flatMap((series) => series.points);
  const xs = allPoints.map((point) => point[0]);
  const ys = allPoints.map((point) => point[1]);
  const xScale = scaleOf(Math.min(...xs), Math.max(...xs), MARGIN.left, VIEW_WIDTH - MARGIN.right);
  const legend = spec.series
    .map((series, seriesIndex) => ({ name: series.name ?? '', seriesIndex }))
    .filter((entry) => entry.name.length > 0);
  const title = readTitle(spec as unknown as Record<string, unknown>);
  const y0 = drawHead({ x0: MARGIN.left, x1: VIEW_WIDTH - MARGIN.right, y0: 0, y1: VIEW_HEIGHT - MARGIN.bottom }, title, legend);
  const plot: Plot = { x0: MARGIN.left, x1: VIEW_WIDTH - MARGIN.right, y0, y1: VIEW_HEIGHT - MARGIN.bottom };
  // The vertical scale maps into the plot below the head, so the highest point stays under title and legend.
  const yScale = scaleOf(Math.min(...ys), Math.max(...ys), VIEW_HEIGHT - MARGIN.bottom, y0);
  const xStep = niceStep(xScale.max - xScale.min);
  const xLabels = ticksFor(xScale.min, xScale.max).map((tick) => ({ at: map(xScale, tick), text: formatTick(tick, xStep) }));
  drawFrame(surface, plot, yScale, xLabels);
  spec.series.forEach((series, index) => {
    if (markers) {
      for (const point of series.points) {
        surface.append(
          svgElement('circle', {
            cx: map(xScale, point[0]),
            cy: map(yScale, point[1]),
            r: 4,
            stroke: 'none',
            class: `fill-series-${index % 6}`,
          }),
        );
      }
    } else {
      const coordinates = series.points.map((point) => `${map(xScale, point[0])},${map(yScale, point[1])}`);
      surface.append(svgElement('polyline', { points: coordinates.join(' '), fill: 'none', class: `line-series-${index % 6}` }));
    }
  });
  return `${markers ? 'scatter' : 'line'} graph: ${spec.series.length} series, ${allPoints.length} points`;
}

/** Draws one bar graph: labelled bars on a zero baseline. */
function drawBars(spec: BarGraphSpec): string {
  if (!isBarList(spec.bars)) {
    throw new Error('The bar graph needs a bar list: [{ label, value }, ...] with a string label and a finite value.');
  }
  const values = spec.bars.map((bar) => bar.value);
  const title = readTitle(spec as unknown as Record<string, unknown>);
  const y0 = drawHead({ x0: MARGIN.left, x1: VIEW_WIDTH - MARGIN.right, y0: 0, y1: VIEW_HEIGHT - MARGIN.bottom }, title, []);
  const plot: Plot = { x0: MARGIN.left, x1: VIEW_WIDTH - MARGIN.right, y0, y1: VIEW_HEIGHT - MARGIN.bottom };
  // The vertical scale maps into the plot below the head, so the tallest bar stays under the title.
  const yScale = scaleOf(Math.min(0, ...values), Math.max(0, ...values), VIEW_HEIGHT - MARGIN.bottom, y0);
  const yStep = niceStep(yScale.max - yScale.min);
  const band = (plot.x1 - plot.x0) / spec.bars.length;
  const labelEvery = Math.max(1, Math.ceil(44 / band));
  const xLabels = spec.bars
    .map((bar, index) => ({ at: plot.x0 + band * (index + 0.5), text: bar.label, index }))
    .filter((label) => label.index % labelEvery === 0);
  drawFrame(surface, plot, yScale, xLabels);
  const zero = map(yScale, 0);
  spec.bars.forEach((bar, index) => {
    const x = plot.x0 + band * index + band * 0.15;
    const width = band * 0.7;
    const y = map(yScale, bar.value);
    surface.append(
      svgElement('rect', {
        x,
        width,
        y: Math.min(y, zero),
        height: Math.abs(zero - y),
        stroke: 'none',
        class: `fill-series-${index % 6}`,
      }),
    );
    if (band >= 26) {
      surface.append(svgText(x + width / 2, Math.min(y, zero) - 6, formatTick(bar.value, yStep), 'axis-label'));
    }
  });
  return `bar graph: ${spec.bars.length} bars`;
}

/** The spec of one live scrolling chart: a rolling window that `append` fills over time. */
export interface LiveGraphSpec {
  readonly title?: string;
  /** How many points stay visible. The oldest drops off when one more arrives. */
  readonly window: number;
  /** True to draw a dashed line at the mean of the visible points, with its value as the label. */
  readonly mean?: boolean;
  /** The value unit, shown on the mean label, for example " ms". */
  readonly unit?: string;
}

/** One live chart: the rolling values, the drawing elements, and the axis ticks of the last draw. */
interface LiveChart {
  readonly spec: LiveGraphSpec;
  readonly values: number[];
  readonly line: SVGPolylineElement;
  readonly meanLine: SVGLineElement;
  readonly meanLabel: SVGTextElement;
  frame: SVGGElement;
  frameKey: string;
}

/** The running live chart, or null before `live` starts and after any other drawing. */
let liveChart: LiveChart | null = null;

/** Reads the y of one appended point: a finite number or an object with a finite y. */
function readLiveY(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }
  if (typeof value === 'object' && value !== null) {
    const y = (value as Record<string, unknown>)['y'];
    if (typeof y === 'number' && Number.isFinite(y)) {
      return y;
    }
  }
  throw new Error('The appended point must be a finite number or an object { y }.');
}

/**
 * Starts one live scrolling chart. Every `append` lands one point at the right edge;
 * the window scrolls when it fills, and the axes rescale as the values move.
 *
 * @param spec The chart spec: { title?, window, mean?, unit? }.
 * @returns A confirmation string.
 * @throws Error when the window is not an integer between 2 and 100000.
 */
function startLive(spec: unknown): string {
  if (typeof spec !== 'object' || spec === null) {
    throw new Error('The live graph needs a spec object: { title?, window, mean?, unit? }.');
  }
  const record = spec as Record<string, unknown>;
  if (typeof record['window'] !== 'number' || !Number.isInteger(record['window']) || record['window'] < 2 || record['window'] > 100000) {
    throw new Error('The live graph needs a window: an integer between 2 and 100000 points.');
  }
  const title = readTitle(record);
  const unit = record['unit'] === undefined || record['unit'] === null ? '' : String(record['unit']);
  const wantMean = record['mean'] === undefined || record['mean'] === null ? false : record['mean'] === true;
  surface.replaceChildren();
  emptyHint.hidden = true;
  const plot: Plot = { x0: MARGIN.left, x1: VIEW_WIDTH - MARGIN.right, y0: title !== null ? 62 : 26, y1: VIEW_HEIGHT - MARGIN.bottom };
  drawHead({ ...plot, y0: 0 }, title, []);
  const frame = svgElement('g', {});
  const line = svgElement('polyline', { fill: 'none', class: 'line-series-0' });
  const meanLine = svgElement('line', { class: 'mean-line' });
  const meanLabel = svgText(plot.x1, 0, '', 'mean-label', 'end');
  surface.append(frame, line, meanLine, meanLabel);
  liveChart = {
    spec: { ...(title !== null ? { title } : {}), window: record['window'], ...(wantMean ? { mean: true } : {}), unit },
    values: [],
    line,
    meanLine,
    meanLabel,
    frame,
    frameKey: '',
  };
  updateLive();
  return `live chart: window of ${record['window']} points${wantMean ? ', mean line on' : ''}`;
}

/** Redraws the live chart from its rolling values: the frame only when its ticks move, the line and mean every time. */
function updateLive(): void {
  const chart = liveChart;
  if (!chart) {
    return;
  }
  const plot: Plot = { x0: MARGIN.left, x1: VIEW_WIDTH - MARGIN.right, y0: chart.spec.title ? 62 : 26, y1: VIEW_HEIGHT - MARGIN.bottom };
  // The x axis spans the whole window, so the line grows from the left edge and scrolls once the window fills.
  const xScale = scaleOf(0, chart.spec.window - 1, plot.x0, plot.x1);
  const ys = chart.values;
  const yScale = ys.length > 0 ? scaleOf(Math.min(...ys), Math.max(...ys), plot.y1, plot.y0) : scaleOf(0, 1, plot.y1, plot.y0);
  const xStep = niceStep(xScale.max - xScale.min);
  const xLabels = ticksFor(xScale.min, xScale.max).map((tick) => ({ at: map(xScale, tick), text: formatTick(tick, xStep) }));
  const yTicks = ticksFor(yScale.min, yScale.max);
  const frameKey = `${xLabels.map((label) => label.text).join(',')}|${yTicks.join(',')}`;
  if (frameKey !== chart.frameKey) {
    chart.frame.remove();
    chart.frame = svgElement('g', {});
    drawFrame(chart.frame, plot, yScale, xLabels);
    surface.prepend(chart.frame);
    chart.frameKey = frameKey;
  }
  chart.line.setAttribute(
    'points',
    ys.map((y, index) => `${map(xScale, index)},${map(yScale, y)}`).join(' '),
  );
  if (ys.length > 0 && chart.spec.mean) {
    const mean = ys.reduce((sum, value) => sum + value, 0) / ys.length;
    const at = map(yScale, mean);
    chart.meanLine.setAttribute('x1', String(plot.x0));
    chart.meanLine.setAttribute('x2', String(plot.x1));
    chart.meanLine.setAttribute('y1', String(at));
    chart.meanLine.setAttribute('y2', String(at));
    chart.meanLabel.setAttribute('y', String(at - 5));
    // One decimal fits values of ten and up; small magnitudes, like sub-millisecond latencies, keep two.
    chart.meanLabel.textContent = `mean ${mean.toFixed(Math.abs(mean) < 10 ? 2 : 1)}${chart.spec.unit}`;
  } else {
    chart.meanLine.removeAttribute('x1');
    chart.meanLabel.textContent = '';
  }
}

/**
 * Appends one point to the running live chart.
 *
 * @param point The value: a finite number or an object { y }.
 * @returns A confirmation string with the visible point count.
 * @throws Error when no live chart runs or the value is invalid.
 */
function appendLive(point: unknown): string {
  const value = readLiveY(point);
  if (!liveChart) {
    throw new Error('No live chart runs. Start one with nodewavenGraphs.live first.');
  }
  liveChart.values.push(value);
  if (liveChart.values.length > liveChart.spec.window) {
    liveChart.values.shift();
  }
  updateLive();
  return `appended ${value}: ${liveChart.values.length} points visible`;
}

/** Empties the surface and shows the empty hint again. */
function clearSurface(): string {
  surface.replaceChildren();
  emptyHint.hidden = false;
  liveChart = null;
  return 'cleared';
}

/** Runs one drawing after its spec passed the guard. Every drawing replaces the current graph and ends a live chart. */
function draw(action: () => string): string {
  surface.replaceChildren();
  liveChart = null;
  const result = action();
  emptyHint.hidden = true;
  return result;
}

/** The page global the agents drive. Every method validates its spec, draws, and answers with a confirmation. */
export const nodewavenGraphs = {
  clear: (): string => clearSurface(),
  /** Starts one live scrolling chart that `append` fills. */
  live: (spec: unknown): string => startLive(spec),
  /** Appends one point to the running live chart. */
  append: (point: unknown): string => appendLive(point),
  line: (spec: unknown): string =>
    draw(() => {
      if (typeof spec !== 'object' || spec === null) {
        throw new Error('The line graph needs a spec object: { title, series }.');
      }
      return drawSeriesPlot(spec as LineGraphSpec, false);
    }),
  scatter: (spec: unknown): string =>
    draw(() => {
      if (typeof spec !== 'object' || spec === null) {
        throw new Error('The scatter graph needs a spec object: { title, series }.');
      }
      return drawSeriesPlot(spec as ScatterGraphSpec, true);
    }),
  bars: (spec: unknown): string =>
    draw(() => {
      if (typeof spec !== 'object' || spec === null) {
        throw new Error('The bar graph needs a spec object: { title, bars }.');
      }
      return drawBars(spec as BarGraphSpec);
    }),
} as const;

(globalThis as { nodewavenGraphs?: typeof nodewavenGraphs }).nodewavenGraphs = nodewavenGraphs;

/** Applies the theme the workspace window mirrored, so the page follows the active app theme. */
function applyMirroredTheme(): void {
  document.documentElement.dataset.theme = resolveThemeId(localStorage.getItem(THEME_MIRROR_KEY));
}

applyMirroredTheme();
// A theme change in the workspace window writes the mirror, and the storage event recolors the page.
window.addEventListener('storage', (event) => {
  if (event.key === THEME_MIRROR_KEY) {
    applyMirroredTheme();
  }
});
console.info('[NodeWavenUI] graphs window ready');
