import { NextResponse } from "next/server";
import { buildSeasonalForecast } from "@/lib/forecast";

function parseYmd(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date();
  dt.setFullYear(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date");
  if (!date) return NextResponse.json({ error: "Missing date" }, { status: 400 });

  const target = parseYmd(date);
  if (!target) return NextResponse.json({ error: "Invalid date" }, { status: 400 });

  // Fake history: 45 days of 15-min points with some daily shape + noise.
  const history: { ts: Date; value: number }[] = [];
  const start = new Date(target);
  start.setDate(start.getDate() - 45);

  for (let t = new Date(start); t < target; t = new Date(t.getTime() + 15 * 60 * 1000)) {
    const hour = t.getHours() + t.getMinutes() / 60;
    const dailyWave = 20 * Math.sin((Math.PI * 2 * (hour - 14)) / 24);
    const base = 40;
    const noise = (Math.random() - 0.5) * 4;
    history.push({ ts: new Date(t), value: base + dailyWave + noise });
  }

  const points = buildSeasonalForecast(target, history, 4);

  return NextResponse.json({
    settlementPoint: "HB_WEST",
    date,
    points,
    metrics: { backtestDays: 0, mae: NaN, mape: null },
    dataMode: "mock",
  });
}
