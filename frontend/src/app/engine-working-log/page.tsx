"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type LogRow = {
  timestamp: string;
  engine: string;
  symbol: string;
  timeframe: string;
  status: string;
  ema_9?: number;
  ema_20?: number;
  ema_21?: number;
  ema_50?: number;
  ema_200?: number;
  rsi_14?: number;
  macd?: number;
  macd_signal?: number;
  macd_histogram?: number;
  avg_volume_20?: number;
  current_volume?: number;
  volume_ratio?: number;
  processing_ms?: number;
  error?: string;
};

type LogsResponse = { engine: string; logs: LogRow[] };

const timeframes = ["1m", "5m", "15m", "1h", "4h", "1d"];

function localDateValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function number(value: number | undefined, digits = 4) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

export default function EngineWorkingLogPage() {
  const today = useMemo(() => localDateValue(new Date()), []);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [timeframe, setTimeframe] = useState("15m");
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadLogs = useCallback(async () => {
    setLoading(true);
    try {
      const start = new Date(`${startDate}T00:00:00`);
      const end = new Date(`${endDate}T23:59:59.999`);
      const params = new URLSearchParams({ start: start.toISOString(), end: end.toISOString() });
      const response = await fetch(`/api/indicators/logs?${params}`, { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load Indicator Engine logs");
      const data = (await response.json()) as LogsResponse;
      setLogs(data.logs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load logs");
    } finally {
      setLoading(false);
    }
  }, [startDate, endDate]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  const runEngine = async () => {
    const normalized = symbol.trim().replace(/[/\-\s]/g, "").toUpperCase();
    if (!normalized) return;
    setRunning(true);
    setError(null);
    try {
      const response = await fetch(`/api/indicators/run/${normalized}?timeframe=${timeframe}&limit=500`, {
        method: "POST",
        cache: "no-store",
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail ?? "Indicator Engine run failed");
      }
      setSymbol(normalized);
      await loadLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Indicator Engine run failed");
    } finally {
      setRunning(false);
    }
  };

  const resetToday = () => {
    setStartDate(today);
    setEndDate(today);
  };

  const downloadCsv = () => {
    const columns: (keyof LogRow)[] = [
      "timestamp", "engine", "symbol", "timeframe", "status", "ema_9", "ema_20", "ema_21", "ema_50", "ema_200",
      "rsi_14", "macd", "macd_signal", "macd_histogram", "avg_volume_20", "current_volume", "volume_ratio", "processing_ms", "error",
    ];
    const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [columns.join(","), ...logs.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `indicator-engine-log-${startDate}-to-${endDate}.csv`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="pageWrap">
      <div className="pageHeader">
        <div>
          <p className="eyebrow">Engine Observability</p>
          <h1>Engine Working Log</h1>
          <p className="muted">Build one engine, inspect its real output, stabilize it, then move to the next engine.</p>
        </div>
        <span className="modePill"><span />Indicator Engine active</span>
      </div>

      <section className="panel" style={{ padding: 18, marginBottom: 14 }}>
        <div className="panelHead" style={{ marginBottom: 14 }}>
          <div>
            <p className="eyebrow">1. Engine</p>
            <h2>Indicator Engine Log</h2>
          </div>
          <button className="periodTag" type="button" onClick={resetToday}>Today</button>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", marginBottom: 14 }}>
          <label style={{ fontSize: 11, color: "#8f9bb0" }}>From<br /><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} style={inputStyle} /></label>
          <label style={{ fontSize: 11, color: "#8f9bb0" }}>To<br /><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} style={inputStyle} /></label>
          <button type="button" onClick={() => void loadLogs()} style={buttonStyle}>Apply Period</button>
          <button type="button" onClick={downloadCsv} disabled={!logs.length} style={buttonStyle}>Download CSV</button>
        </div>

        <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", paddingTop: 14, borderTop: "1px solid #192231" }}>
          <label style={{ fontSize: 11, color: "#8f9bb0" }}>Test Symbol<br /><input value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} style={inputStyle} /></label>
          <label style={{ fontSize: 11, color: "#8f9bb0" }}>Timeframe<br /><select value={timeframe} onChange={(event) => setTimeframe(event.target.value)} style={inputStyle}>{timeframes.map((item) => <option key={item}>{item}</option>)}</select></label>
          <button type="button" onClick={runEngine} disabled={running} style={runButtonStyle}>{running ? "Running…" : "Run Indicator Engine"}</button>
          <span className="muted">Each run calculates EMA 9/20/21/50/200, RSI 14, MACD 12/26/9 and volume metrics.</span>
        </div>
        {error && <p className="negative" style={{ marginBottom: 0 }}>{error}</p>}
      </section>

      <section className="panel" style={{ overflow: "auto" }}>
        <div className="panelHead compact"><h2>Indicator Engine Runs</h2><span className="periodTag">{loading ? "Loading…" : `${logs.length} rows`}</span></div>
        <div style={{ minWidth: 1500 }}>
          <div style={{ ...rowStyle, color: "#69768a", fontSize: 9, textTransform: "uppercase" }}>
            <span>Time</span><span>Symbol</span><span>TF</span><span>Status</span><span>EMA 9</span><span>EMA 20</span><span>EMA 21</span><span>EMA 50</span><span>EMA 200</span><span>RSI</span><span>MACD</span><span>Signal</span><span>Hist</span><span>Vol Ratio</span><span>ms</span>
          </div>
          {!loading && !logs.length && <div style={{ padding: 28, color: "#78859a", fontSize: 12 }}>No Indicator Engine logs in this period. Run the engine above to generate a real test log.</div>}
          {logs.map((row, index) => (
            <div key={`${row.timestamp}-${index}`} style={rowStyle} title={row.error ?? ""}>
              <span>{new Date(row.timestamp).toLocaleString()}</span><strong>{row.symbol}</strong><span>{row.timeframe}</span><span className={row.status === "success" ? "positive" : "negative"}>{row.status}</span>
              <span>{number(row.ema_9)}</span><span>{number(row.ema_20)}</span><span>{number(row.ema_21)}</span><span>{number(row.ema_50)}</span><span>{number(row.ema_200)}</span>
              <span>{number(row.rsi_14, 2)}</span><span>{number(row.macd)}</span><span>{number(row.macd_signal)}</span><span>{number(row.macd_histogram)}</span><span>{number(row.volume_ratio, 2)}x</span><span>{number(row.processing_ms, 2)}</span>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

const inputStyle = { marginTop: 5, background: "#0b1118", color: "#dfe7f1", border: "1px solid #263242", borderRadius: 7, padding: "8px 10px" } as const;
const buttonStyle = { ...inputStyle, cursor: "pointer" } as const;
const runButtonStyle = { ...buttonStyle, background: "#173329", color: "#69e4b8", border: "1px solid #285845", fontWeight: 700 } as const;
const rowStyle = { display: "grid", gridTemplateColumns: "150px 90px 45px 70px repeat(5, 95px) 70px repeat(3, 95px) 80px 70px", gap: 10, padding: "10px 14px", borderBottom: "1px solid #171f2a", fontSize: 10, alignItems: "center" } as const;
