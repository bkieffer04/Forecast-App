// src/app/api/forecast/route.ts
import { NextResponse } from "next/server";
import { ercotGetJson } from "@/lib/ercot";
import { buildSeasonalForecast, dailyStats, mae, mape } from "@/lib/forecast";

const SPP_15MIN_ENDPOINT = "/np6-905-cd/spp_node_zone_hub";

// ---------------- Cache (in-memory) ----------------
type CacheEntry<T> = { value: T; expMs: number };
const CACHE_TTL_MS = 10 * 60 * 1000;        // response cache
const DAY_ROWS_TTL_MS = 60 * 60 * 1000;     // day rows cache (1 hour)

function getCache() {
  const g = globalThis as any;
  if (!g.__FORECAST_CACHE__) g.__FORECAST_CACHE__ = new Map<string, CacheEntry<any>>();
  return g.__FORECAST_CACHE__ as Map<string, CacheEntry<any>>;
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
  getCache().set(key, { value, expMs: Date.now() + ttlMs });
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

// ---------------- ERCOT row parsing ----------------
// Row format you found:
// ["2026-02-10", 1, 1, "HB_WEST", "HU", -1.39, false]
type Row = any[];

function intervalToTime(interval: number) {
  const zeroBased = interval - 1;
  const minutes = zeroBased * 15;
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return { hh, mm };
}

function buildIsoFromDateAndInterval(dateStr: string, interval: number) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const { hh, mm } = intervalToTime(interval);
  const dt = new Date(y, m - 1, d, hh, mm, 0, 0);
  return dt.toISOString();
}

function parseRowsToPoints(rows: Row[], wantedDate: string) {
  const points = rows
    .map((r) => {
      if (!Array.isArray(r) || r.length < 6) return null;

      const deliveryDate = String(r[0] ?? "");
      const interval = Number(r[2]);
      const settlementPoint = String(r[3] ?? "").trim().toUpperCase();
      const value = Number(r[5]);

      if (deliveryDate !== wantedDate) return null;
      if (!Number.isFinite(interval) || interval < 1 || interval > 96) return null;
      if (settlementPoint !== "HB_WEST") return null;
      if (!Number.isFinite(value)) return null;

      const ts = buildIsoFromDateAndInterval(deliveryDate, interval);
      return { ts, value, interval };
    })
    .filter(Boolean) as { ts: string; value: number; interval: number }[];

  points.sort((a, b) => a.interval - b.interval);
  return points;
}

function rowsToHistory(rows: Row[]) {
  const out: { ts: Date; value: number }[] = [];
  for (const r of rows) {
    if (!Array.isArray(r) || r.length < 6) continue;

    const deliveryDate = String(r[0] ?? "");
    const interval = Number(r[2]);
    const sp = String(r[3] ?? "").trim().toUpperCase();
    const value = Number(r[5]);

    if (!deliveryDate || sp !== "HB_WEST") continue;
    if (!Number.isFinite(interval) || interval < 1 || interval > 96) continue;
    if (!Number.isFinite(value)) continue;

    const tsIso = buildIsoFromDateAndInterval(deliveryDate, interval);
    out.push({ ts: new Date(tsIso), value });
  }
  out.sort((a, b) => a.ts.getTime() - b.ts.getTime());
  return out;
}

// ---------------- ERCOT fetch helpers ----------------
async function fetchSppRows(fromDate: string, toDate: string) {
  const raw = await ercotGetJson<any>(SPP_15MIN_ENDPOINT, {
    settlementPoint: "HB_WEST",
    deliveryDateFrom: fromDate,
    deliveryDateTo: toDate,
    deliveryIntervalFrom: "1",
    deliveryIntervalTo: "96",
    DSTFlag: "false",
    size: "2000", // per-day pulls; keep it tight
  });

  const items: Row[] =
    raw?.items ?? raw?.data ?? raw?._embedded?.data ?? raw?._embedded?.items ?? [];

  return items;
}

/**
 * Fetches a single day's rows. We set deliveryDateTo = next day
 * to avoid "from == to" range quirks.
 */
async function fetchDayRows(dateYmd: string) {
  const key = `rows:HB_WEST:${dateYmd}`;
  const cached = cacheGet<Row[]>(key);
  if (cached) return cached;

  const to = nextDayYmd(dateYmd);
  const rows = await fetchSppRows(dateYmd, to);

  cacheSet(key, rows, DAY_ROWS_TTL_MS);
  return rows;
}

function previousSameWeekdayDates(target: Date, count: number) {
  // Returns [target-7, target-14, ...] length = count
  const out: Date[] = [];
  let d = new Date(target);
  d = toStartOfDay(d);
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

  // Response cache (per selected day)
  const respCacheKey = `forecast_v3:${targetYmd}`;
  const cachedResp = cacheGet<any>(respCacheKey);
  if (cachedResp) {
    return NextResponse.json(cachedResp, {
      headers: { "Cache-Control": "public, max-age=60" },
    });
  }

  // Compare day = same weekday last week
  const compareDay = addDays(targetDayStart, -7);
  const compareYmd = ymd(compareDay);

  try {
    // 1) Actuals for last week's same weekday (single-day fetch)
    const compareRows = await fetchDayRows(compareYmd);
    const actualsCompare = parseRowsToPoints(compareRows, compareYmd);

    // 2) History = last 4 occurrences of that weekday (same weekday seasonal baseline)
    const histDays = previousSameWeekdayDates(targetDayStart, 4); // [target-7, -14, -21, -28]
    const histRowsList = await Promise.all(histDays.map((d) => fetchDayRows(ymd(d))));
    const historyAll = rowsToHistory(histRowsList.flat());

    if (historyAll.length === 0) {
      return NextResponse.json({ error: "No HB_WEST history returned from ERCOT." }, { status: 502 });
    }

    // Forecast for selected day based on same-weekday seasonal baseline
    const forecastPoints = buildSeasonalForecast(targetDayStart, historyAll, 4);

    // Backtest: forecast compare day using history strictly before compare day
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

      actuals: {
        date: compareYmd,
        points: actualsCompare,
      },

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
  } catch (e: any) {
    const msg = e?.message ?? String(e);
    // If you added server-side timeout in ercotGetJson, surface that cleanly.
    const status = msg.toLowerCase().includes("timed out") ? 504 : 502;
    return NextResponse.json({ error: msg }, { status });
  }
}
