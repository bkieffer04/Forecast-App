"use client";

import Image from "next/image";
import React, { useEffect, useMemo, useState } from "react";
import { LineChart, Line, XAxis, Tooltip, ResponsiveContainer, Legend } from "recharts";

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

type ApiError = { error?: string };

function addDays(d: Date, days: number) {
  const x = new Date(d);
  x.setDate(x.getDate() + days);
  x.setHours(0, 0, 0, 0);
  return x;
}

function dayLabel(d: Date) {
  return d.toLocaleDateString([], { weekday: "short" });
}

function monthDay(d: Date) {
  return d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function InfoTip({ text }: { text: string }) {
  return (
    <span className="tip">
      <span className="tipIcon" aria-label="Info" role="img" tabIndex={0}>
        ⓘ
      </span>
      <span className="tipBubble" role="tooltip">
        {text}
      </span>
    </span>
  );
}

type StatRow = {
  label: React.ReactNode;
  value: React.ReactNode;
};

function StatCard({
  title,
  hint,
  rows,
}: {
  title: string;
  hint?: React.ReactNode;
  rows: StatRow[];
}) {
  return (
    <div className="statCard">
      <div className="statLabel">{title}</div>
      {hint ? <div className="statHint">{hint}</div> : null}

      {rows.map((r, i) => (
        <div className="statValueRow" key={i}>
          <span>{r.label}</span>
          <span className="num">{r.value}</span>
        </div>
      ))}
    </div>
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

  const days = useMemo(() => Array.from({ length: 7 }, (_, i) => addDays(today, i)), [today]);

  const isSmall = typeof window !== "undefined" && window.innerWidth < 640;

  useEffect(() => {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    let cancelled = false;

    (async () => {
      setErr(null);
      try {
        const resp = await fetch(`/api/forecast?date=${date}`, {
          signal: controller.signal,
          cache: "no-store",
        });

        const json: unknown = await resp.json();

        if (!resp.ok) {
          const msg =
            typeof json === "object" && json !== null && "error" in json
              ? String((json as ApiError).error ?? "Request failed")
              : "Request failed";
          throw new Error(msg);
        }

        // At this point, we expect ApiResp.
        if (!cancelled) setData(json as ApiResp);
      } catch (e: unknown) {
        if (!cancelled) {
          if (e instanceof DOMException && e.name === "AbortError") {
            setErr("Request timed out");
          } else if (e instanceof Error) {
            setErr(e.message);
          } else {
            setErr("Unknown error");
          }
        }
      } finally {
        clearTimeout(timeout);
      }
    })();

    return () => {
      cancelled = true;
      clearTimeout(timeout);
      controller.abort();
    };
  }, [date]);

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
          {err && <span className="badge badgeError">{err}</span>}
          <span className="badge">Region: HB_WEST</span>
          {data?.dataMode && <span className="badge">Mode: {data.dataMode}</span>}
        </div>
      </div>

      {data && (
        <>
          <div className="statsGrid">
            <StatCard
              title="Forecast stats"
              hint={`${data.date} • 96 points`}
              rows={[
                { label: "Min", value: fmt(data.stats.forecast.min) },
                { label: "Max", value: fmt(data.stats.forecast.max) },
                { label: "Avg", value: fmt(data.stats.forecast.avg) },
                {
                  label: (
                    <>
                      Std{" "}
                      <InfoTip text="Standard deviation: how much the values typically vary from the average. Higher = more spread/volatility." />
                    </>
                  ),
                  value: fmt(data.stats.forecast.std),
                },
              ]}
            />

            <StatCard
              title="Last Week Actuals"
              hint={`${data.actuals.date} • ${data.backtest.actualCount} points`}
              rows={[
                { label: "Min", value: fmt(data.stats.actuals.min) },
                { label: "Max", value: fmt(data.stats.actuals.max) },
                { label: "Avg", value: fmt(data.stats.actuals.avg) },
                {
                  label: (
                    <>
                      Std{" "}
                      <InfoTip text="Standard deviation: typical variation from the average. This helps describe volatility." />
                    </>
                  ),
                  value: fmt(data.stats.actuals.std),
                },
              ]}
            />

            <StatCard
              title="Backtest"
              hint={data.backtest.date}
              rows={[
                {
                  label: (
                    <>
                      MAE{" "}
                      <InfoTip text="Mean Absolute Error: average absolute difference between forecast and actual. Lower is better." />
                    </>
                  ),
                  value: fmt(data.backtest.mae),
                },
                {
                  label: (
                    <>
                      MAPE{" "}
                      <InfoTip text="Mean Absolute Percentage Error: average percent error. Lower is better. Can be misleading when actuals are near zero." />
                    </>
                  ),
                  value: data.backtest.mape == null ? "n/a" : `${data.backtest.mape.toFixed(2)}%`,
                },
                { label: "Notes", value: "Actuals vs seasonal baseline" },
              ]}
            />
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
                  <Tooltip
                    formatter={(v: unknown) =>
                      typeof v === "number" ? v.toFixed(2) : String(v)
                    }
                  />
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

      <footer className="footer">Branding assets belong to Jupiter Power; used for interview demo.</footer>
    </main>
  );
}
