export type FifteenMinPoint = { ts: string; value: number };

function slotIndex(d: Date) {
  return d.getHours() * 4 + Math.floor(d.getMinutes() / 15); // 0..95
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

export function mae(actual: number[], pred: number[]) {
  let s = 0;
  for (let i = 0; i < actual.length; i++) s += Math.abs(actual[i] - pred[i]);
  return s / actual.length;
}

export function mape(actual: number[], pred: number[]) {
  let s = 0;
  let n = 0;
  for (let i = 0; i < actual.length; i++) {
    if (actual[i] === 0) continue;
    s += Math.abs((actual[i] - pred[i]) / actual[i]);
    n++;
  }
  return n ? (s / n) * 100 : null;
}
