// src/lib/forecast.ts

export type FifteenMinPoint = { ts: string; value: number };

const INTERVALS_PER_DAY = 96;
const MINUTES_PER_INTERVAL = 15;

/**
 * Returns the 15-minute slot index for a Date (0..95).
 * NOTE: This uses the Date's local hour/minute. If you want strict UTC behavior,
 * pass Dates that are already created in UTC or switch to getUTCHours/getUTCMinutes.
 */
function slotIndexLocal(d: Date) {
  return d.getHours() * 4 + Math.floor(d.getMinutes() / MINUTES_PER_INTERVAL);
}

export function mae(actual: number[], pred: number[]) {
  const n = Math.min(actual.length, pred.length);
  if (n === 0) return NaN;

  let sum = 0;
  for (let i = 0; i < n; i++) sum += Math.abs(actual[i] - pred[i]);
  return sum / n;
}

/**
 * Mean Absolute Percentage Error.
 * Skips points where |actual| is near zero because percent error becomes misleading.
 */
export function mape(actual: number[], pred: number[], epsilon = 1e-6) {
  const n = Math.min(actual.length, pred.length);
  if (n === 0) return null;

  let sum = 0;
  let count = 0;

  for (let i = 0; i < n; i++) {
    const a = actual[i];
    if (!Number.isFinite(a) || Math.abs(a) <= epsilon) continue;
    sum += Math.abs((a - pred[i]) / a);
    count++;
  }

  return count ? (sum / count) * 100 : null;
}

export function dailyStats(values: number[]) {
  if (values.length === 0) return { min: NaN, max: NaN, avg: NaN, std: NaN };

  let min = Infinity;
  let max = -Infinity;
  let sum = 0;

  for (const v of values) {
    if (v < min) min = v;
    if (v > max) max = v;
    sum += v;
  }

  const avg = sum / values.length;

  // population standard deviation
  let varSum = 0;
  for (const v of values) {
    const d = v - avg;
    varSum += d * d;
  }

  const std = Math.sqrt(varSum / values.length);
  return { min, max, avg, std };
}

/**
 * Seasonal baseline forecast:
 * For each 15-minute interval on the target weekday, use the mean of that same
 * weekday + interval over the prior N weeks.
 *
 * - history should include rows with ts < targetDayStart
 * - only values in [targetDayStart - weeksLookback*7, targetDayStart) are used
 * - output is always 96 points (DST transition days are a known limitation)
 */
export function buildSeasonalForecast(
  targetDayStart: Date,
  history: { ts: Date; value: number }[],
  weeksLookback = 4,
): FifteenMinPoint[] {
  const targetDow = targetDayStart.getDay();

  const cutoff = new Date(targetDayStart);
  cutoff.setDate(cutoff.getDate() - weeksLookback * 7);

  const sums = new Array<number>(INTERVALS_PER_DAY).fill(0);
  const counts = new Array<number>(INTERVALS_PER_DAY).fill(0);

  for (const row of history) {
    if (row.ts < cutoff || row.ts >= targetDayStart) continue;
    if (row.ts.getDay() !== targetDow) continue;

    const slot = slotIndexLocal(row.ts);
    if (slot < 0 || slot >= INTERVALS_PER_DAY) continue;

    sums[slot] += row.value;
    counts[slot] += 1;
  }

  // Find a reasonable starting value for carry-forward fallback
  let lastValue = 0;
  for (let i = 0; i < INTERVALS_PER_DAY; i++) {
    if (counts[i] > 0) {
      lastValue = sums[i] / counts[i];
      break;
    }
  }

  const base = new Date(targetDayStart);
  base.setHours(0, 0, 0, 0);

  const out: FifteenMinPoint[] = [];
  for (let i = 0; i < INTERVALS_PER_DAY; i++) {
    const avg = counts[i] > 0 ? sums[i] / counts[i] : null;
    const value = avg ?? lastValue;
    lastValue = value;

    const ts = new Date(base);
    ts.setMinutes(i * MINUTES_PER_INTERVAL);

    out.push({ ts: ts.toISOString(), value });
  }

  return out;
}
