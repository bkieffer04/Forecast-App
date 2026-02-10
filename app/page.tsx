"use client";

import { useEffect, useMemo, useState } from "react";
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from "recharts";

type ApiResp = {
  settlementPoint: "HB_WEST";
  date: string;
  points: { ts: string; value: number }[];
  metrics: { backtestDays: number; mae: number; mape: number | null };
  dataMode?: string;
};

function ymd(d: Date) {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
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

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      setErr(null);
      try {
        const resp = await fetch(`/api/forecast?date=${date}`);
        const json = await resp.json();
        if (!resp.ok) throw new Error(json.error ?? "Request failed");
        if (!cancelled) setData(json);
      } catch (e: any) {
        if (!cancelled) setErr(e.message ?? String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [date]);

  const min = ymd(today);
  const maxD = new Date(today);
  maxD.setDate(maxD.getDate() + 7);
  const max = ymd(maxD);

  const chartData = (data?.points ?? []).map((p) => ({
    ...p,
    t: new Date(p.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }),
  }));

  return (
    <main style={{ maxWidth: 980, margin: "0 auto", padding: 20, fontFamily: "system-ui" }}>
      <h1 style={{ fontSize: 22, marginBottom: 8 }}>ERCOT HB_WEST 15-Minute Forecast</h1>

      <div style={{ display: "flex", gap: 12, alignItems: "center", marginBottom: 16 }}>
        <label>
          Date (next 7 days):{" "}
          <input
            type="date"
            min={min}
            max={max}
            value={date}
            onChange={(e) => setDate(e.target.value)}
          />
        </label>
        {loading && <span>Loading…</span>}
        {err && <span style={{ color: "crimson" }}>{err}</span>}
        {data?.dataMode && <span style={{ opacity: 0.7 }}>Mode: {data.dataMode}</span>}
      </div>

      {data && (
        <>
          <div style={{ width: "100%", height: 260, border: "1px solid #ddd", borderRadius: 8, padding: 8 }}>
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartData}>
                <XAxis dataKey="t" interval={11} />
                <YAxis />
                <Tooltip />
                <Line type="monotone" dataKey="value" dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>

          <h2 style={{ fontSize: 16, marginTop: 18 }}>96 intervals</h2>
          <div style={{ maxHeight: 360, overflow: "auto", border: "1px solid #ddd", borderRadius: 8 }}>
            <table style={{ width: "100%", borderCollapse: "collapse" }}>
              <thead>
                <tr>
                  <th style={{ textAlign: "left", padding: 8, borderBottom: "1px solid #eee" }}>Timestamp</th>
                  <th style={{ textAlign: "right", padding: 8, borderBottom: "1px solid #eee" }}>Forecast</th>
                </tr>
              </thead>
              <tbody>
                {data.points.map((p) => (
                  <tr key={p.ts}>
                    <td style={{ padding: 8, borderBottom: "1px solid #f3f3f3" }}>
                      {new Date(p.ts).toLocaleString()}
                    </td>
                    <td style={{ padding: 8, textAlign: "right", borderBottom: "1px solid #f3f3f3" }}>
                      {p.value.toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </main>
  );
}
