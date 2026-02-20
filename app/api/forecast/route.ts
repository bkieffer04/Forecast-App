// src/app/api/forecast/route.ts
import { NextResponse } from "next/server";
import { ercotGetJson } from "@/lib/ercot";
import { buildSeasonalForecast, dailyStats, mae, mape } from "@/lib/forecast";

const SPP_15MIN_ENDPOINT = "/np6-905-cd/spp_node_zone_hub";

// ---------------- Types ----------------

// The ERCOT endpoint returns "rows" (arrays). We only rely on indices 0,1,2,3,5.
// This tuple type matches that shape without pretending we know every column.
type Row = [
  deliveryDate: string, // r[0]
  deliveryHour: number, // r[1]
  deliveryInterval: number, // r[2]
  settlementPoint: string, // r[3]
  col4?: unknown, // r[4] (unused)
  value?: number, // r[5]
  ...rest: unknown[]
];

type Embedded = {
  data?: Row[];
  items?: Row[];
};

// ERCOT responses vary. We accept a few known shapes and treat everything else as unknown.
type UnknownErcotResponse = {
  items?: Row[];
  data?: Row[];
  _embedded?: Embedded;
  [key: string]: unknown;
};

type Point = { ts: string; value: number; interval: number };
type HistoryPoint = { ts: Date; value: number };

// ---------------- Cache (in-memory) ----------------
type CacheEntry<T> = { value: T; expMs: number };
const CACHE_TTL_MS = 10 * 60 * 1000; // response cache
const DAY_ROWS_TTL_MS = 60 * 60 * 1000; // raw day rows cache

type ForecastCache = Map<string, CacheEntry<unknown>>;

function getCache(): ForecastCache {
  const g = globalThis as typeof globalThis & { __FORECAST_CACHE__?: ForecastCache };
  if (!g.__FORECAST_CACHE__) g.__FORECAST_CACHE__ = new Map<string, CacheEntry<unknown>>();
  return g.__FORECAST_CACHE__;
}

function cacheGet<T>(key: string): T | null {
  const cache = getCache();
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expMs) {
    cache.delete(key);
    return null;
  }
  return entry.value as T;
}

function cacheSet<T>(key: string, value: T, ttlMs: number) {
  getCache().set(key, { value: value as unknown, expMs: Date.now() + ttlMs });
}

// ---------------- Date helpers ----------------
function parseYmd(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

function toStartOfDay(d: Date) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x;
}

function addDays(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  x.setHours(0, 0, 0, 0);
  return x;
}

function ymd(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function nextDayYmd(dateYmd: string) {
  const dt = parseYmd(dateYmd);
  if (!dt) throw new Error("Invalid date");
  dt.setDate(dt.getDate() + 1);
  return ymd(dt);
}

function buildIsoFromDateHourInterval(dateStr: string, deliveryHour: number, deliveryInterval: number) {
  const [y, m, d] = dateStr.split("-").map(Number);

  // ERCOT deliveryHour is Hour Ending (HE). Hour start is HE - 1.
  const hourStart = deliveryHour - 1;
  const minute = (deliveryInterval - 1) * 15;

  const dt = new Date(y, m - 1, d, hourStart, minute, 0, 0);
  return dt.toISOString();
}

function daySlot96(deliveryHour: number, deliveryInterval: number) {
  // 0..95
  return (deliveryHour - 1) * 4 + (deliveryInterval - 1);
}

function parseRowsToPoints(rows: Row[], wantedDate: string): Point[] {
  const points = rows
    .map((r) => {
      // Tuple guarantees at least 4 items, but value may be missing.
      const deliveryDate = String(r[0] ?? "");
      const deliveryHour = Number(r[1]);
      const deliveryInterval = Number(r[2]);
      const settlementPoint = String(r[3] ?? "").trim().toUpperCase();
      const value = Number(r[5]);

      if (deliveryDate !== wantedDate) return null;
      if (!Number.isFinite(deliveryHour) || deliveryHour < 1 || deliveryHour > 24) return null;
      if (!Number.isFinite(deliveryInterval) || deliveryInterval < 1 || deliveryInterval > 4) return null;
      if (settlementPoint !== "HB_WEST") return null;
      if (!Number.isFinite(value)) return null;

      const ts = buildIsoFromDateHourInterval(deliveryDate, deliveryHour, deliveryInterval);
      const slot = daySlot96(deliveryHour, deliveryInterval); // 0..95
      return { ts, value, slot };
    })
    .filter((x): x is { ts: string; value: number; slot: number } => x !== null);

  points.sort((a, b) => a.slot - b.slot);

  // If your frontend expects `interval: 1..96`, return interval = slot + 1
  return points.map((p) => ({ ts: p.ts, value: p.value, interval: p.slot + 1 }));
}

function rowsToHistory(rows: Row[]): HistoryPoint[] {
  const out: HistoryPoint[] = [];

  for (const r of rows) {
    const deliveryDate = String(r[0] ?? "");
    const deliveryHour = Number(r[1]);
    const deliveryInterval = Number(r[2]);
    const sp = String(r[3] ?? "").trim().toUpperCase();
    const value = Number(r[5]);

    if (!deliveryDate || sp !== "HB_WEST") continue;
    if (!Number.isFinite(deliveryHour) || deliveryHour < 1 || deliveryHour > 24) continue;
    if (!Number.isFinite(deliveryInterval) || deliveryInterval < 1 || deliveryInterval > 4) continue;
    if (!Number.isFinite(value)) continue;

    const tsIso = buildIsoFromDateHourInterval(deliveryDate, deliveryHour, deliveryInterval);
    out.push({ ts: new Date(tsIso), value });
  }

  out.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  return out;
}

// ---------------- ERCOT fetch helpers ----------------
function extractRows(raw: UnknownErcotResponse): Row[] {
  // Grab the first array we recognize, otherwise empty.
  const rows =
    raw.items ??
    raw.data ??
    raw._embedded?.data ??
    raw._embedded?.items ??
    [];

  return Array.isArray(rows) ? rows : [];
}

async function fetchSppRows(fromDate: string, toDate: string): Promise<Row[]> {
  const raw = await ercotGetJson<UnknownErcotResponse>(SPP_15MIN_ENDPOINT, {
    settlementPoint: "HB_WEST",
    deliveryDateFrom: fromDate,
    deliveryDateTo: toDate,
    // Keep whatever query params you already proved work.
    // The API returns hourEnding + quarter anyway; parsing handles it.
    deliveryIntervalFrom: "1",
    deliveryIntervalTo: "96",
    DSTFlag: "false",
    size: "2000",
  });

  console.log("raw", raw);
  return extractRows(raw);
}

async function fetchDayRows(dateYmd: string): Promise<Row[]> {
  const key = `rows:HB_WEST:${dateYmd}`;
  const cached = cacheGet<Row[]>(key);
  if (cached) return cached;

  const to = nextDayYmd(dateYmd);
  const rows = await fetchSppRows(dateYmd, to);

  cacheSet(key, rows, DAY_ROWS_TTL_MS);
  return rows;
}

function previousSameWeekdayDates(target: Date, count: number) {
  const out: Date[] = [];
  let d = toStartOfDay(target);
  for (let i = 0; i < count; i++) {
    d = addDays(d, -7);
    out.push(new Date(d));
  }
  return out;
}

// ---------------- Route ----------------
export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date");
  if (!date) return NextResponse.json({ error: "Missing date" }, { status: 400 });

  const targetDayStart = parseYmd(date);
  if (!targetDayStart) {
    return NextResponse.json({ error: "Invalid date (use YYYY-MM-DD)" }, { status: 400 });
  }

  const today = toStartOfDay(new Date());
  const max = addDays(today, 7);
  if (targetDayStart < today || targetDayStart > max) {
    return NextResponse.json({ error: "Date must be within the next 7 days" }, { status: 400 });
  }

  const targetYmd = ymd(targetDayStart);

  const respCacheKey = `forecast_v4:${targetYmd}`;
  const cachedResp = cacheGet<unknown>(respCacheKey);
  if (cachedResp) {
    return NextResponse.json(cachedResp, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  }

  const compareDay = addDays(targetDayStart, -7);
  const compareYmd = ymd(compareDay);

  try {
    // Actuals: same weekday last week
    const compareRows = await fetchDayRows(compareYmd);
    const actualsCompare = parseRowsToPoints(compareRows, compareYmd);

    // History: last 4 same-weekday occurrences
    const histDays = previousSameWeekdayDates(targetDayStart, 4);
    const histRowsList = await Promise.all(histDays.map((d) => fetchDayRows(ymd(d))));
    const historyAll = rowsToHistory(histRowsList.flat());

    if (historyAll.length === 0) {
      return NextResponse.json({ error: "No HB_WEST history returned from ERCOT." }, { status: 502 });
    }

    const forecastPoints = buildSeasonalForecast(targetDayStart, historyAll, 4);

    // Backtest: predict compare day using history strictly before compare day
    const historyBeforeCompare = historyAll.filter((p) => p.ts < compareDay);
    const forecastComparePoints = buildSeasonalForecast(compareDay, historyBeforeCompare, 4);

    const forecastVals = forecastPoints.map((p) => p.value);
    const actualVals = actualsCompare.map((p) => p.value);
    const predValsForBacktest = forecastComparePoints.map((p) => p.value);

    const resp = {
      settlementPoint: "HB_WEST" as const,
      date: targetYmd,
      dataMode: "ercot-np6-905",

      forecast: forecastPoints,

      actuals: { date: compareYmd, points: actualsCompare },

      stats: {
        forecast: dailyStats(forecastVals),
        actuals: dailyStats(actualVals),
      },

      backtest: {
        date: compareYmd,
        mae: mae(actualVals, predValsForBacktest),
        mape: mape(actualVals, predValsForBacktest),
        actualCount: actualVals.length,
      },
    };

    cacheSet(respCacheKey, resp, CACHE_TTL_MS);

    return NextResponse.json(resp, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    const status = msg.toLowerCase().includes("timed out") ? 504 : 502;
    return NextResponse.json({ error: msg }, { status });
  }
}