// app/api/forecast/route.ts
import { NextResponse } from "next/server";
import { ercotGetJson } from "@/lib/ercot";
import { buildSeasonalForecast, dailyStats, mae, mape } from "@/lib/forecast";

const ENDPOINT = "/np6-905-cd/spp_node_zone_hub";

const SETTLEMENT_POINT = "HB_WEST";
const INTERVALS_PER_DAY = 96;
const HISTORY_WEEKS = 4;

const RESPONSE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const DAY_ROWS_TTL_MS = 60 * 60 * 1000; // 1 hour

// ---------------- In-memory cache ----------------
type CacheEntry<T> = { value: T; expMs: number };

declare global {
  var __FORECAST_CACHE__: Map<string, CacheEntry<unknown>> | undefined;
}


function getCache() {
  if (!globalThis.__FORECAST_CACHE__) {
    globalThis.__FORECAST_CACHE__ = new Map<string, CacheEntry<unknown>>();
  }
  return globalThis.__FORECAST_CACHE__;
}

function cacheGet<T>(key: string): T | null {
  const entry = getCache().get(key);
  if (!entry) return null;
  if (Date.now() > entry.expMs) {
    getCache().delete(key);
    return null;
  }
  return entry.value as T;
}

function cacheSet<T>(key: string, value: T, ttlMs: number) {
  getCache().set(key, { value, expMs: Date.now() + ttlMs });
}

// ---------------- Date helpers ----------------
function parseYmd(s: string): Date | null {
  const [y, m, d] = s.split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

function ymd(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function addDays(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  x.setHours(0, 0, 0, 0);
  return x;
}

function nextDayYmd(dateYmd: string) {
  const d = parseYmd(dateYmd);
  if (!d) throw new Error("Invalid date");
  d.setDate(d.getDate() + 1);
  return ymd(d);
}

// ---------------- ERCOT row parsing ----------------
// Discovered row format:
// ["YYYY-MM-DD", <ignored>, interval, "HB_WEST", <ignored>, price, <ignored>]
type Row = unknown[];

function intervalToIso(deliveryDate: string, interval: number) {
  const [y, m, d] = deliveryDate.split("-").map(Number);
  const zero = interval - 1;
  const minutes = zero * 15;
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return new Date(y, m - 1, d, hh, mm, 0, 0).toISOString();
}

function rowsToDayPoints(rows: Row[], wantedDate: string) {
  const pts: { ts: string; value: number; interval: number }[] = [];

  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;

    const deliveryDate = String(r[0] ?? "");
    const interval = Number(r[2]);
    const sp = String(r[3] ?? "").trim().toUpperCase();
    const value = Number(r[5]);

    if (deliveryDate !== wantedDate) continue;
    if (sp !== SETTLEMENT_POINT) continue;
    if (!Number.isFinite(interval) || interval < 1 || interval > INTERVALS_PER_DAY) continue;
    if (!Number.isFinite(value)) continue;

    pts.push({ ts: intervalToIso(deliveryDate, interval), value, interval });
  }

  pts.sort((a, b) => a.interval - b.interval);
  return pts;
}

function rowsToHistory(rows: Row[]) {
  const out: { ts: Date; value: number }[] = [];

  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;

    const deliveryDate = String(r[0] ?? "");
    const interval = Number(r[2]);
    const sp = String(r[3] ?? "").trim().toUpperCase();
    const value = Number(r[5]);

    if (!deliveryDate) continue;
    if (sp !== SETTLEMENT_POINT) continue;
    if (!Number.isFinite(interval) || interval < 1 || interval > INTERVALS_PER_DAY) continue;
    if (!Number.isFinite(value)) continue;

    out.push({ ts: new Date(intervalToIso(deliveryDate, interval)), value });
  }

  out.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  return out;
}

// ---------------- ERCOT fetch helpers ----------------
type ErcotResponseShape = {
  items?: unknown[];
  data?: unknown[];
  _embedded?: {
    data?: unknown[];
    items?: unknown[];
  };
};

async function fetchSppRows(fromDate: string, toDate: string) {
  const raw = await ercotGetJson<ErcotResponseShape>(ENDPOINT, {
    settlementPoint: SETTLEMENT_POINT,
    deliveryDateFrom: fromDate,
    deliveryDateTo: toDate,
    deliveryIntervalFrom: "1",
    deliveryIntervalTo: String(INTERVALS_PER_DAY),
    DSTFlag: "false",
    size: "2000",
  });

  const rows =
    raw.items ??
    raw.data ??
    raw._embedded?.data ??
    raw._embedded?.items ??
    [];

  // Keep it as unknown[][]; parsers already validate shape.
  return rows as Row[];
}

/**
 * Fetches one day's rows using [date, nextDay) to avoid range quirks with from==to.
 * Results are cached separately so date switching doesn't re-hit ERCOT.
 */
async function fetchDayRows(dateYmd: string) {
  const key = `rows:${SETTLEMENT_POINT}:${dateYmd}`;
  const cached = cacheGet<Row[]>(key);
  if (cached) return cached;

  const rows = await fetchSppRows(dateYmd, nextDayYmd(dateYmd));
  cacheSet(key, rows, DAY_ROWS_TTL_MS);
  return rows;
}

function previousSameWeekdays(target: Date, weeks: number) {
  return Array.from({ length: weeks }, (_, i) => addDays(target, -(7 * (i + 1))));
}

// ---------------- Route ----------------
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const dateParam = searchParams.get("date");

  if (!dateParam) return NextResponse.json({ error: "Missing date" }, { status: 400 });

  const targetDay = parseYmd(dateParam);
  if (!targetDay) return NextResponse.json({ error: "Invalid date (use YYYY-MM-DD)" }, { status: 400 });

  const today = addDays(new Date(), 0);
  const max = addDays(today, 7);

  if (targetDay < today || targetDay > max) {
    return NextResponse.json({ error: "Date must be within the next 7 days" }, { status: 400 });
  }

  const targetYmd = ymd(targetDay);
  const respKey = `forecast:v3:${SETTLEMENT_POINT}:${targetYmd}`;

  const cached = cacheGet<unknown>(respKey);
  if (cached) {
    return NextResponse.json(cached, { headers: { "Cache-Control": "public, max-age=60" } });
  }

  const compareDay = addDays(targetDay, -7);
  const compareYmd = ymd(compareDay);

  try {
    const compareRows = await fetchDayRows(compareYmd);
    const actualsPoints = rowsToDayPoints(compareRows, compareYmd);

    const historyDays = previousSameWeekdays(targetDay, HISTORY_WEEKS);
    const historyRows = await Promise.all(historyDays.map((d) => fetchDayRows(ymd(d))));
    const historyAll = rowsToHistory(historyRows.flat());

    if (historyAll.length === 0) {
      return NextResponse.json(
        { error: `No ${SETTLEMENT_POINT} history returned from ERCOT.` },
        { status: 502 }
      );
    }

    const forecastPoints = buildSeasonalForecast(targetDay, historyAll, HISTORY_WEEKS);

    const historyBeforeCompare = historyAll.filter((p) => p.ts < compareDay);
    const forecastCompare = buildSeasonalForecast(compareDay, historyBeforeCompare, HISTORY_WEEKS);

    const forecastVals = forecastPoints.map((p) => p.value);
    const actualVals = actualsPoints.map((p) => p.value);
    const predVals = forecastCompare.map((p) => p.value);

    const resp = {
      settlementPoint: SETTLEMENT_POINT,
      date: targetYmd,
      dataMode: "ercot-np6-905",
      forecast: forecastPoints,
      actuals: {
        date: compareYmd,
        points: actualsPoints,
      },
      stats: {
        forecast: dailyStats(forecastVals),
        actuals: dailyStats(actualVals),
      },
      backtest: {
        date: compareYmd,
        mae: actualVals.length ? mae(actualVals, predVals) : NaN,
        mape: actualVals.length ? mape(actualVals, predVals) : null,
        actualCount: actualVals.length,
      },
    };

    cacheSet(respKey, resp, RESPONSE_TTL_MS);
    return NextResponse.json(resp, { headers: { "Cache-Control": "public, max-age=60" } });
  } catch (e: unknown) {
    const msg =
      e instanceof Error ? e.message : typeof e === "string" ? e : "Unknown error";

    const status = msg.toLowerCase().includes("timed out") ? 504 : 502;
    return NextResponse.json({ error: msg }, { status });
  }
}
