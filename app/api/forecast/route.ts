// src/app/api/forecast/route.ts
import { NextResponse } from "next/server";
import { ercotGetJson } from "@/lib/ercot";
import { buildSeasonalForecast } from "@/lib/forecast";

const SPP_15MIN_ENDPOINT = "/np6-905-cd/spp_node_zone_hub";

function parseYmd(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

type Row = any[];

// interval: 1..96 where 1 = 00:00, 2 = 00:15, ... 96 = 23:45
function intervalToTime(interval: number) {
  const zeroBased = interval - 1;
  const minutes = zeroBased * 15;
  const hh = Math.floor(minutes / 60);
  const mm = minutes % 60;
  return { hh, mm };
}

// Build a timestamp from the row’s deliveryDate + interval.
// We construct as local time then convert to ISO.
// (DST edge cases exist; ERCOT provides DSTFlag in the row if you want to handle it later.)
function buildIsoFromDateAndInterval(dateStr: string, interval: number) {
  const [y, m, d] = dateStr.split("-").map(Number);
  const { hh, mm } = intervalToTime(interval);
  const dt = new Date(y, m - 1, d, hh, mm, 0, 0);
  return dt.toISOString();
}

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const date = searchParams.get("date");
  if (!date) return NextResponse.json({ error: "Missing date" }, { status: 400 });

  const targetDayStart = parseYmd(date);
  if (!targetDayStart) {
    return NextResponse.json({ error: "Invalid date (use YYYY-MM-DD)" }, { status: 400 });
  }

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const max = new Date(today);
  max.setDate(max.getDate() + 7);

  if (targetDayStart < today || targetDayStart > max) {
    return NextResponse.json({ error: "Date must be within the next 7 days" }, { status: 400 });
  }

  // Pull 45 days of history for seasonal baseline
  const histFrom = new Date(targetDayStart);
  histFrom.setDate(histFrom.getDate() - 45);

  // Query params based on what you used successfully in API Explorer.
  const raw = await ercotGetJson<any>(SPP_15MIN_ENDPOINT, {
    settlementPoint: "HB_WEST",
    deliveryDateFrom: histFrom.toISOString().slice(0, 10), // YYYY-MM-DD
    deliveryDateTo: targetDayStart.toISOString().slice(0, 10), // YYYY-MM-DD
    deliveryIntervalFrom: "1",
    deliveryIntervalTo: "96",
    DSTFlag: "false",
    size: "100000",
  });

  // ERCOT response wrapper variants
  const items: Row[] =
    raw?.items ??
    raw?.data ??
    raw?._embedded?.data ??
    raw?._embedded?.items ??
    [];

  // Rows are arrays like:
  // ["2026-02-10", 1, 1, "HB_WEST", "HU", -1.39, false]
  const hbHistory = items
    .map((r) => {
      if (!Array.isArray(r) || r.length < 6) return null;

      const deliveryDate = String(r[0] ?? "");
      const interval = Number(r[2]);
      const settlementPoint = String(r[3] ?? "").trim().toUpperCase();
      const value = Number(r[5]);

      if (!deliveryDate) return null;
      if (!Number.isFinite(interval) || interval < 1 || interval > 96) return null;
      if (settlementPoint !== "HB_WEST") return null;
      if (!Number.isFinite(value)) return null;

      const tsIso = buildIsoFromDateAndInterval(deliveryDate, interval);
      return { ts: new Date(tsIso), value, interval };
    })
    .filter(Boolean) as { ts: Date; value: number; interval: number }[];

  if (hbHistory.length === 0) {
    return NextResponse.json(
      {
        error:
          "No HB_WEST data returned after parsing rows. Verify query params in API Explorer and that date range contains data.",
      },
      { status: 502 },
    );
  }

  // Sort by time to keep the model sane
  hbHistory.sort((a, b) => a.ts.getTime() - b.ts.getTime());

  const points = buildSeasonalForecast(targetDayStart, hbHistory, 4);

  return NextResponse.json({
    settlementPoint: "HB_WEST",
    date,
    points,
    dataMode: "ercot-np6-905",
  });
}
