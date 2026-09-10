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

type CandlePayload = {
  open_time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  close_time: number;
};

type ScannerCandidate = {
  symbol: string;
  timeframe: string;
  score: number;
  quote_volume: number;
  last_price: number;
  rsi_14: number;
  macd: number;
  macd_signal: number;
  volume_ratio: number;
  ema_9: number;
  ema_21: number;
  ema_50: number;
  ema_200: number;
  reasons: string[];
};

type ScannerRun = {
  timestamp: string;
  engine: string;
  status: string;
  timeframe: string;
  min_quote_volume: number;
  input_markets: number;
  evaluated_markets: number;
  candidate_count: number;
  processing_ms: number;
  candidates: ScannerCandidate[];
};

type BinanceSymbol = { symbol: string; status: string; quoteAsset: string; isSpotTradingAllowed?: boolean };
type ExchangeInfo = { symbols: BinanceSymbol[] };
type Ticker24h = { symbol: string; quoteVolume: string };
type LogsResponse = { engine: string; logs: LogRow[] };
type ScannerLogsResponse = { engine: string; logs: ScannerRun[] };

const timeframes = ["1m", "5m", "15m", "1h", "4h", "1d"];
const MARKET_API = "https://data-api.binance.vision";
const HISTORY_LIMIT = 500;
const MIN_QUOTE_VOLUME = 10_000_000;
const SCAN_LIMIT = 30;
const ALLOWED_QUOTES = new Set(["USDT", "USDC", "FDUSD"]);

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

function candleRows(rows: (string | number)[][]): CandlePayload[] {
  return rows.map((row) => ({
    open_time: Number(row[0]), open: String(row[1]), high: String(row[2]), low: String(row[3]),
    close: String(row[4]), volume: String(row[5]), close_time: Number(row[6]),
  }));
}

async function fetchCandles(symbol: string, timeframe: string) {
  const response = await fetch(
    `${MARKET_API}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(timeframe)}&limit=${HISTORY_LIMIT}`,
    { cache: "no-store" },
  );
  if (!response.ok) throw new Error(`Unable to load candles for ${symbol}`);
  return candleRows((await response.json()) as (string | number)[][]);
}

export default function EngineWorkingLogPage() {
  const today = useMemo(() => localDateValue(new Date()), []);
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [timeframe, setTimeframe] = useState("15m");
  const [logs, setLogs] = useState<LogRow[]>([]);
  const [scannerLogs, setScannerLogs] = useState<ScannerRun[]>([]);
  const [loading, setLoading] = useState(true);
  const [scannerLoading, setScannerLoading] = useState(true);
  const [running, setRunning] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [scanProgress, setScanProgress] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [scannerError, setScannerError] = useState<string | null>(null);

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

  const loadScannerLogs = useCallback(async () => {
    setScannerLoading(true);
    try {
      const response = await fetch("/api/scanner/logs", { cache: "no-store" });
      if (!response.ok) throw new Error("Unable to load Scanner Engine logs");
      const data = (await response.json()) as ScannerLogsResponse;
      setScannerLogs(data.logs);
      setScannerError(null);
    } catch (err) {
      setScannerError(err instanceof Error ? err.message : "Unable to load Scanner Engine logs");
    } finally {
      setScannerLoading(false);
    }
  }, []);

  useEffect(() => { void loadLogs(); void loadScannerLogs(); }, [loadLogs, loadScannerLogs]);

  const runEngine = async () => {
    const normalized = symbol.trim().replace(/[/\-\s]/g, "").toUpperCase();
    if (!normalized) return;
    setRunning(true); setError(null);
    try {
      const candles = await fetchCandles(normalized, timeframe);
      const response = await fetch(`/api/indicators/run/${normalized}?timeframe=${timeframe}&limit=${HISTORY_LIMIT}`, {
        method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(candles),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail ?? "Indicator Engine run failed");
      }
      setSymbol(normalized);
      await loadLogs();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Indicator Engine run failed");
    } finally { setRunning(false); }
  };

  const runScanner = async () => {
    setScanning(true); setScannerError(null); setScanProgress("Loading Binance universe…");
    try {
      const [exchangeResponse, tickerResponse] = await Promise.all([
        fetch(`${MARKET_API}/api/v3/exchangeInfo`, { cache: "no-store" }),
        fetch(`${MARKET_API}/api/v3/ticker/24hr`, { cache: "no-store" }),
      ]);
      if (!exchangeResponse.ok || !tickerResponse.ok) throw new Error("Unable to load Binance scanner universe");
      const exchange = (await exchangeResponse.json()) as ExchangeInfo;
      const tickers = (await tickerResponse.json()) as Ticker24h[];
      const active = new Set(
        exchange.symbols
          .filter((item) => item.status === "TRADING" && item.isSpotTradingAllowed !== false && ALLOWED_QUOTES.has(item.quoteAsset))
          .map((item) => item.symbol),
      );
      const liquid = tickers
        .filter((item) => active.has(item.symbol) && Number(item.quoteVolume) >= MIN_QUOTE_VOLUME)
        .sort((a, b) => Number(b.quoteVolume) - Number(a.quoteVolume))
        .slice(0, SCAN_LIMIT);

      const markets: { symbol: string; quote_volume: number; candles: CandlePayload[] }[] = [];
      for (let offset = 0; offset < liquid.length; offset += 5) {
        const batch = liquid.slice(offset, offset + 5);
        setScanProgress(`Loading candles ${Math.min(offset + batch.length, liquid.length)}/${liquid.length}…`);
        const results = await Promise.allSettled(batch.map(async (item) => ({
          symbol: item.symbol,
          quote_volume: Number(item.quoteVolume),
          candles: await fetchCandles(item.symbol, timeframe),
        })));
        for (const result of results) if (result.status === "fulfilled") markets.push(result.value);
      }

      setScanProgress("Ranking candidates…");
      const response = await fetch(`/api/scanner/run?timeframe=${timeframe}&min_quote_volume=${MIN_QUOTE_VOLUME}`, {
        method: "POST", cache: "no-store", headers: { "content-type": "application/json" }, body: JSON.stringify(markets),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail ?? "Scanner Engine failed");
      }
      await loadScannerLogs();
      setScanProgress("");
    } catch (err) {
      setScannerError(err instanceof Error ? err.message : "Scanner Engine failed");
    } finally { setScanning(false); }
  };

  const resetToday = () => { setStartDate(today); setEndDate(today); };

  const downloadCsv = () => {
    const columns: (keyof LogRow)[] = ["timestamp", "engine", "symbol", "timeframe", "status", "ema_9", "ema_20", "ema_21", "ema_50", "ema_200", "rsi_14", "macd", "macd_signal", "macd_histogram", "avg_volume_20", "current_volume", "volume_ratio", "processing_ms", "error"];
    const escape = (value: unknown) => `"${String(value ?? "").replaceAll('"', '""')}"`;
    const csv = [columns.join(","), ...logs.map((row) => columns.map((column) => escape(row[column])).join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `indicator-engine-log-${startDate}-to-${endDate}.csv`; anchor.click(); URL.revokeObjectURL(url);
  };

  const downloadScannerCsv = () => {
    const candidates = scannerLogs.flatMap((run) => run.candidates.map((candidate) => ({ timestamp: run.timestamp, ...candidate })));
    const header = "timestamp,symbol,timeframe,score,quote_volume,last_price,rsi_14,macd,macd_signal,volume_ratio,reasons";
    const csv = [header, ...candidates.map((row) => [row.timestamp, row.symbol, row.timeframe, row.score, row.quote_volume, row.last_price, row.rsi_14, row.macd, row.macd_signal, row.volume_ratio, `"${row.reasons.join(" | ").replaceAll('"', '""')}"`].join(","))].join("\n");
    const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob); const anchor = document.createElement("a"); anchor.href = url; anchor.download = `scanner-engine-log-${today}.csv`; anchor.click(); URL.revokeObjectURL(url);
  };

  const latestScanner = scannerLogs[0];

  return (
    <div className="pageWrap">
      <div className="pageHeader">
        <div><p className="eyebrow">Engine Observability</p><h1>Engine Working Log</h1><p className="muted">Build one engine, inspect its real output, stabilize it, then move to the next engine.</p></div>
        <span className="modePill"><span />Indicator + Scanner active</span>
      </div>

      <section className="panel" style={{ padding: 18, marginBottom: 14 }}>
        <div className="panelHead" style={{ marginBottom: 14 }}><div><p className="eyebrow">1. Engine</p><h2>Indicator Engine Log</h2></div><button className="periodTag" type="button" onClick={resetToday}>Today</button></div>
        <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", marginBottom: 14 }}>
          <label style={labelStyle}>From<br /><input type="date" value={startDate} onChange={(event) => setStartDate(event.target.value)} style={inputStyle} /></label>
          <label style={labelStyle}>To<br /><input type="date" value={endDate} onChange={(event) => setEndDate(event.target.value)} style={inputStyle} /></label>
          <button type="button" onClick={() => void loadLogs()} style={buttonStyle}>Apply Period</button><button type="button" onClick={downloadCsv} disabled={!logs.length} style={buttonStyle}>Download CSV</button>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap", paddingTop: 14, borderTop: "1px solid #192231" }}>
          <label style={labelStyle}>Test Symbol<br /><input value={symbol} onChange={(event) => setSymbol(event.target.value.toUpperCase())} style={inputStyle} /></label>
          <label style={labelStyle}>Timeframe<br /><select value={timeframe} onChange={(event) => setTimeframe(event.target.value)} style={inputStyle}>{timeframes.map((item) => <option key={item}>{item}</option>)}</select></label>
          <button type="button" onClick={runEngine} disabled={running} style={runButtonStyle}>{running ? "Running…" : "Run Indicator Engine"}</button>
          <span className="muted">Browser loads candles; backend calculates EMA, RSI, MACD and volume metrics.</span>
        </div>
        {error && <p className="negative" style={{ marginBottom: 0 }}>{error}</p>}
      </section>

      <section className="panel" style={{ overflow: "auto", marginBottom: 14 }}>
        <div className="panelHead compact"><h2>Indicator Engine Runs</h2><span className="periodTag">{loading ? "Loading…" : `${logs.length} rows`}</span></div>
        <div style={{ minWidth: 1500 }}><div style={{ ...rowStyle, color: "#69768a", fontSize: 9, textTransform: "uppercase" }}><span>Time</span><span>Symbol</span><span>TF</span><span>Status</span><span>EMA 9</span><span>EMA 20</span><span>EMA 21</span><span>EMA 50</span><span>EMA 200</span><span>RSI</span><span>MACD</span><span>Signal</span><span>Hist</span><span>Vol Ratio</span><span>ms</span></div>
          {!loading && !logs.length && <div style={emptyStyle}>No Indicator Engine logs in this period.</div>}
          {logs.map((row, index) => <div key={`${row.timestamp}-${index}`} style={rowStyle} title={row.error ?? ""}><span>{new Date(row.timestamp).toLocaleString()}</span><strong>{row.symbol}</strong><span>{row.timeframe}</span><span className={row.status === "success" ? "positive" : "negative"}>{row.status}</span><span>{number(row.ema_9)}</span><span>{number(row.ema_20)}</span><span>{number(row.ema_21)}</span><span>{number(row.ema_50)}</span><span>{number(row.ema_200)}</span><span>{number(row.rsi_14, 2)}</span><span>{number(row.macd)}</span><span>{number(row.macd_signal)}</span><span>{number(row.macd_histogram)}</span><span>{number(row.volume_ratio, 2)}x</span><span>{number(row.processing_ms, 2)}</span></div>)}
        </div>
      </section>

      <section className="panel" style={{ padding: 18, marginBottom: 14 }}>
        <div className="panelHead" style={{ marginBottom: 14 }}><div><p className="eyebrow">2. Engine</p><h2>Scanner Engine Log</h2></div><span className="periodTag">v1 · shortlist only</span></div>
        <div style={{ display: "flex", gap: 10, alignItems: "end", flexWrap: "wrap" }}>
          <label style={labelStyle}>Timeframe<br /><select value={timeframe} onChange={(event) => setTimeframe(event.target.value)} style={inputStyle}>{timeframes.map((item) => <option key={item}>{item}</option>)}</select></label>
          <button type="button" onClick={runScanner} disabled={scanning} style={runButtonStyle}>{scanning ? "Scanning…" : "Run Scanner Engine"}</button>
          <button type="button" onClick={downloadScannerCsv} disabled={!scannerLogs.length} style={buttonStyle}>Download Scanner CSV</button>
          <span className="muted">Active USDT/USDC/FDUSD Spot pairs · 24h quote volume ≥ $10M · top {SCAN_LIMIT} liquid pairs · candidate score ≥ 50.</span>
        </div>
        {scanProgress && <p className="positive" style={{ marginBottom: 0 }}>{scanProgress}</p>}
        {scannerError && <p className="negative" style={{ marginBottom: 0 }}>{scannerError}</p>}
      </section>

      <section className="panel" style={{ overflow: "auto" }}>
        <div className="panelHead compact"><h2>Scanner Candidates</h2><span className="periodTag">{scannerLoading ? "Loading…" : latestScanner ? `${latestScanner.candidate_count} candidates / ${latestScanner.evaluated_markets} evaluated` : "0 runs"}</span></div>
        <div style={{ minWidth: 1100 }}>
          <div style={{ ...scannerRowStyle, color: "#69768a", fontSize: 9, textTransform: "uppercase" }}><span>Symbol</span><span>TF</span><span>Score</span><span>24h Quote Vol</span><span>Price</span><span>RSI</span><span>MACD</span><span>Signal</span><span>Vol Ratio</span><span>Reasons</span></div>
          {!scannerLoading && !latestScanner && <div style={emptyStyle}>No Scanner Engine run yet. Run Scanner Engine above.</div>}
          {latestScanner?.candidates.map((row) => <div key={row.symbol} style={scannerRowStyle}><strong>{row.symbol}</strong><span>{row.timeframe}</span><strong className={row.score >= 70 ? "positive" : "neutral"}>{row.score}</strong><span>${number(row.quote_volume, 0)}</span><span>{number(row.last_price)}</span><span>{number(row.rsi_14, 2)}</span><span>{number(row.macd)}</span><span>{number(row.macd_signal)}</span><span>{number(row.volume_ratio, 2)}x</span><span title={row.reasons.join(" · ")}>{row.reasons.join(" · ") || "—"}</span></div>)}
        </div>
      </section>
    </div>
  );
}

const labelStyle = { fontSize: 11, color: "#8f9bb0" } as const;
const inputStyle = { marginTop: 5, background: "#0b1118", color: "#dfe7f1", border: "1px solid #263242", borderRadius: 7, padding: "8px 10px" } as const;
const buttonStyle = { ...inputStyle, cursor: "pointer" } as const;
const runButtonStyle = { ...buttonStyle, background: "#173329", color: "#69e4b8", border: "1px solid #285845", fontWeight: 700 } as const;
const emptyStyle = { padding: 28, color: "#78859a", fontSize: 12 } as const;
const rowStyle = { display: "grid", gridTemplateColumns: "150px 90px 45px 70px repeat(5, 95px) 70px repeat(3, 95px) 80px 70px", gap: 10, padding: "10px 14px", borderBottom: "1px solid #171f2a", fontSize: 10, alignItems: "center" } as const;
const scannerRowStyle = { display: "grid", gridTemplateColumns: "100px 45px 55px 120px 100px 65px 90px 90px 75px minmax(320px, 1fr)", gap: 10, padding: "10px 14px", borderBottom: "1px solid #171f2a", fontSize: 10, alignItems: "center" } as const;
