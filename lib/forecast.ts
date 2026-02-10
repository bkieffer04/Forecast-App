export type FifteenMinPoint = { ts: string; value: number };

function slotIndex(d: Date) {
  return d.getHours() * 4 + Math.floor(d.getMinutes() / 15); // 0..95
}

export function mae(actual: number[], pred: number[]) {
  const n = Math.min(actual.length, pred.length);
  if (n === 0) return NaN;
  let s = 0;
  for (let i = 0; i < n; i++) s += Math.abs(actual[i] - pred[i]);
  return s / n;
}

export function mape(actual: number[], pred: number[]) {
  const n = Math.min(actual.length, pred.length);
  if (n === 0) return null;

  let s = 0;
  let c = 0;
  for (let i = 0; i < n; i++) {
    const a = actual[i];
    if (a === 0) continue;
    s += Math.abs((a - pred[i]) / a);
    c++;
  }
  return c ? (s / c) * 100 : null;
}

export function dailyStats(values: number[]) {
  if (values.length === 0) {
    return { min: NaN, max: NaN, avg: NaN, std: NaN };
  }

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;

  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }
  const avg = sum / values.length;

  // population std dev
  let varSum = 0;
  for (const v of values) {
    const d = v - avg;
    varSum += d * d;
  }
  const std = Math.sqrt(varSum / values.length);

  return { min, max, avg, std };
}


export function buildSeasonalForecast(
  targetDayStart: Date,
  history: { ts: Date; value: number }[],
  weeksLookback = 4,
): FifteenMinPoint[] {
  const targetDow = targetDayStart.getDay();

  const sums: number[][] = Array.from({ length: 7 }, () => Array(96).fill(0));
  const counts: number[][] = Array.from({ length: 7 }, () => Array(96).fill(0));

  const cutoff = new Date(targetDayStart);
  cutoff.setDate(cutoff.getDate() - weeksLookback * 7);

  for (const row of history) {
    if (row.ts < cutoff || row.ts >= targetDayStart) continue;
    const dow = row.ts.getDay();
    const slot = slotIndex(row.ts);
    sums[dow][slot] += row.value;
    counts[dow][slot] += 1;
  }

  const points: FifteenMinPoint[] = [];
  const base = new Date(targetDayStart);
  base.setHours(0, 0, 0, 0);

  let last = 0;
  for (let i = 0; i < 96; i++) {
    const avg = counts[targetDow][i] ? sums[targetDow][i] / counts[targetDow][i] : null;
    const value = avg ?? last;
    last = value;

    const ts = new Date(base);
    ts.setMinutes(i * 15);
    points.push({ ts: ts.toISOString(), value });
  }

  return points;
}

