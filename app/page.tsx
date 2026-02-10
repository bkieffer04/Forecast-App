"use client";

import Image from "next/image";
import { useEffect, useMemo, useState } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from "recharts";

type ApiResp = {
  settlementPoint: "HB_WEST";
  date: string;
  dataMode?: string;

  forecast: { ts: string; value: number }[];

  actuals: {
    date: string;
    points: { ts: string; value: number; interval: number }[];
  };

  stats: {
    forecast: { min: number; max: number; avg: number; std: number };
    actuals: { min: number; max: number; avg: number; std: number };
  };

  backtest: {
    date: string;
    mae: number;
    mape: number | null;
    actualCount: number;
  };
};

function addDays(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  x.setHours(0, 0, 0, 0);
  return x;
}

function dayLabel(d: Date) {
  return d.toLocaleDateString([], { weekday: "short" }); // Mon, Tue...
}

function monthDay(d: Date) {
  return d.toLocaleDateString([], { month: "short", day: "numeric" }); // Feb 10
}

const fmt2 = (v: number | null | undefined) =>
  typeof v === "number" && Number.isFinite(v) ? v.toFixed(2) : "—";


function parseYmd(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  if (!y || !m || !d) return null;
  const dt = new Date(y, m - 1, d);
  dt.setHours(0, 0, 0, 0);
  return dt;
}

function InfoTip({ text }: { text: string }) {
  return (
    <span className="tip">
      <span className="tipIcon" aria-label="Info" role="img" tabIndex={0}>
        ⓘ
      </span>
      <span className="tipBubble" role="tooltip">{text}</span>
    </span>
  );
}


function ymd(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

function fmt(n: number) {
  if (!Number.isFinite(n)) return "n/a";
  return n.toFixed(2);
}

export default function Page() {
  const today = useMemo(() => {
    const d = new Date();
    d.setHours(0, 0, 0, 0);
    return d;
  }, []);

  const [date, setDate] = useState(ymd(today));
  const [data, setData] = useState<ApiResp | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const days = useMemo(() => {
  return Array.from({ length: 7 }, (_, i) => addDays(today, i));
}, [today]);

  const selected = useMemo(() => parseYmd(date), [date]);
  
  const isSmall = typeof window !== "undefined" && window.innerWidth < 640;



  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);

    let cancelled = false;

    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const resp = await fetch(`/api/forecast?date=${date}`, {
          signal: controller.signal,
          cache: "no-store",
        });

        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error ?? "Request failed");
        if (!cancelled) setData(json);
      } catch (e: any) {
        if (!cancelled) {
          setErr(e.name === "AbortError" ? "Request timed out" : (e.message ?? String(e)));
        }
      } finally {
        clearTimeout(timeout);
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [date]);

  const min = ymd(today);
  const maxD = new Date(today);
  maxD.setDate(maxD.getDate() + 7);
  const max = ymd(maxD);

  // Align actuals by index (good enough for demo); we can align by interval later if needed.
  const chartData = (data?.forecast ?? []).map((p, i) => {
    const actual = data?.actuals?.points?.[i];
    return {
      t: new Date(p.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
      forecast: p.value,
      actual: actual ? actual.value : null,
    };
  });

  return (
    <main className="container">
      <header className="header">
        <div className="brandRow">
          <Image
            src="/brand/jupiter-logo-white.png"
            alt="Jupiter Power"
            width={180}
            height={60}
            priority
          />
          <div className="brandText">
            <div className="brandTitle">ERCOT 15-Minute Forecast</div>
            <div className="brandSubtitle">
              NP6-905-CD settlement point prices. Forecast is a seasonal baseline from recent history.
            </div>
          </div>
        </div>
      </header>

      <div className="controls">
        <div className="dateRow">
  <div className="dateRowLabel">Date (next 7 days)</div>
  <div className="dateBubbles" role="tablist" aria-label="Select date">
    {days.map((d) => {
      const value = ymd(d);
      const active = value === date;

      return (
        <button
          key={value}
          type="button"
          className={`dateBubble ${active ? "dateBubbleActive" : ""}`}
          onClick={() => setDate(value)}
          aria-pressed={active}
          title={value}
        >
          <div className="dateDow">{dayLabel(d)}</div>
          <div className="dateMd">{monthDay(d)}</div>
        </button>
      );
    })}
  </div>
</div>
<div className="badgeColumn">
  {loading && <span className="badge badgeLoading">Loading…</span>}
  {err && <span className="badge badgeError">{err}</span>}
  <span className="badge">Region: HB_WEST</span>
  {data?.dataMode && <span className="badge">Mode: {data.dataMode}</span>}
</div>

       
      </div>

      {data && (
        <>
          <div className="statsGrid">
            <div className="statCard">
              <div className="statLabel">Forecast stats</div>
              <div className="statValueRow">
                <span>Min</span><span className="num">{fmt(data.stats.forecast.min)}</span>
              </div>
              <div className="statValueRow">
                <span>Max</span><span className="num">{fmt(data.stats.forecast.max)}</span>
              </div>
              <div className="statValueRow">
                <span>Avg</span><span className="num">{fmt(data.stats.forecast.avg)}</span>
              </div>
              <div className="statValueRow">
                <span>
                Std <InfoTip text="Standard deviation: how much the values typically vary from the average. Higher = more spread/volatility." />
              </span>
              <span className="num">{fmt(data.stats.forecast.std)}</span>
              </div>

            </div>

            <div className="statCard">
              <div className="statLabel">Actuals</div>
              <div className="statHint">{data.actuals.date} • {data.backtest.actualCount} points</div>
              <div className="statValueRow">
                <span>Min</span><span className="num">{fmt(data.stats.actuals.min)}</span>
              </div>
              <div className="statValueRow">
                <span>Max</span><span className="num">{fmt(data.stats.actuals.max)}</span>
              </div>
              <div className="statValueRow">
                <span>Avg</span><span className="num">{fmt(data.stats.actuals.avg)}</span>
              </div>
              <div className="statValueRow">
                <span>
                  Std <InfoTip text="Standard deviation: typical variation from the average. This helps describe volatility." />
                </span>
                <span className="num">{fmt(data.stats.actuals.std)}</span>
              </div>
              

            </div>

            <div className="statCard">
              <div className="statLabel">Backtest</div>
              <div className="statHint">{data.backtest.date}</div>
              <div className="statValueRow">
                <span>
                  MAE <InfoTip text="Mean Absolute Error: average absolute difference between forecast and actual. Lower is better." />
                </span>
                <span className="num">{fmt(data.backtest.mae)}</span>
              </div>
              <div className="statValueRow">
                <span>
                  MAPE <InfoTip text="Mean Absolute Percentage Error: average percent error. Lower is better. Can be misleading when actuals are near zero." />
                </span>
                <span className="num">
                  {data.backtest.mape == null ? "n/a" : `${data.backtest.mape.toFixed(2)}%`}
                </span>
              </div>
              <div className="statHint">Actuals vs seasonal baseline</div>
            </div>
          </div>

          <div className="surface chartSurface">
            <div className="surfaceHeader">
              <div className="surfaceTitle">Forecast vs Actuals</div>
              <div className="surfaceSub">
                Actuals are the same weekday from last week ({data.actuals.date}).
              </div>

            </div>

            <div className="chartWrap">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData} margin={{ left: 10, right: 10, top: 10, bottom: 0 }}>
                  <XAxis
                    dataKey="t"
                    interval={isSmall ? 23 : "preserveStartEnd"}
                    minTickGap={isSmall ? 48 : 32}
                  />
                  
                  <Tooltip formatter={(v) => (typeof v === "number" ? v.toFixed(2) : String(v))}/>
                  <Legend />
                  <Line type="monotone" dataKey="forecast" dot={false} stroke="var(--jp-accent)" />
                  <Line type="monotone" dataKey="actual" dot={false} stroke="rgba(74,163,255,0.9)" />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <h2 className="sectionTitle">96 intervals</h2>
          <div className="surface tableWrap">
            <table className="table">
              <thead>
                <tr>
                  <th className="th">Timestamp</th>
                  <th className="th thRight">Forecast</th>
                </tr>
              </thead>
              <tbody>
                {data.forecast.map((p) => (
                  <tr className="row" key={p.ts}>
                    <td className="td">{new Date(p.ts).toLocaleString()}</td>
                    <td className="td tdRight">{p.value.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}

      <footer className="footer">
        Branding assets belong to Jupiter Power; used for interview demo.
      </footer>
    </main>
  );
}
