"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CandlePayload = { open_time:number; open:string; high:string; low:string; close:string; volume:string; close_time:number };
type BinanceSymbol = { symbol:string; status:string; quoteAsset:string; isSpotTradingAllowed?:boolean };
type ExchangeInfo = { symbols:BinanceSymbol[] };
type Ticker24h = { symbol:string; quoteVolume:string };
type Candidate = {
  symbol:string; timeframe:string; side:"LONG"|"SHORT"; score:number; long_score:number; short_score:number;
  quote_volume:number; last_price:number; rsi_14:number; macd:number; macd_signal:number; volume_ratio:number; reasons:string[];
};
type ScannerRun = {
  timestamp:string; status:string; timeframe:string; input_markets:number; evaluated_markets:number; candidate_count:number;
  long_candidates:number; short_candidates:number; skipped_liquidity?:number; skipped_stablecoin?:number; skipped_candles?:number;
  skipped_volume?:number; invalid_markets?:number; processing_ms:number; candidates:Candidate[];
};
type LogsResponse = { engine:string; logs:ScannerRun[] };

const MARKET_API = "https://data-api.binance.vision";
const HISTORY_LIMIT = 500;
const MIN_QUOTE_VOLUME = 10_000_000;
const SCAN_LIMIT = 30;
const AUTO_SCAN_SECONDS = 60;
const ALLOWED_QUOTES = new Set(["USDT", "USDC", "FDUSD"]);
const TIMEFRAMES = ["1m", "5m", "15m", "1h", "4h", "1d"];

function candleRows(rows:(string|number)[][]):CandlePayload[] {
  return rows.map((row) => ({ open_time:Number(row[0]), open:String(row[1]), high:String(row[2]), low:String(row[3]), close:String(row[4]), volume:String(row[5]), close_time:Number(row[6]) }));
}

async function fetchCandles(symbol:string, timeframe:string) {
  const response = await fetch(`${MARKET_API}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(timeframe)}&limit=${HISTORY_LIMIT}`, { cache:"no-store" });
  if (!response.ok) throw new Error(`Unable to load candles for ${symbol}`);
  return candleRows((await response.json()) as (string|number)[][]);
}

function fmt(value:number|undefined, digits=2) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits:digits });
}

export default function ScannerPage() {
  const [timeframe, setTimeframe] = useState("15m");
  const [logs, setLogs] = useState<ScannerRun[]>([]);
  const [scanning, setScanning] = useState(false);
  const [progress, setProgress] = useState("Idle");
  const [error, setError] = useState<string|null>(null);
  const [autoRun, setAutoRun] = useState(false);
  const [countdown, setCountdown] = useState(AUTO_SCAN_SECONDS);
  const runningRef = useRef(false);

  const latest = logs[0];

  const loadLogs = useCallback(async () => {
    try {
      const response = await fetch("/api/scanner/logs", { cache:"no-store" });
      if (!response.ok) throw new Error("Unable to load scanner logs");
      const data = (await response.json()) as LogsResponse;
      setLogs(data.logs);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Unable to load scanner logs");
    }
  }, []);

  useEffect(() => { void loadLogs(); }, [loadLogs]);

  const runScanner = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setScanning(true); setError(null); setProgress("Loading Binance universe");
    try {
      const [exchangeResponse, tickerResponse] = await Promise.all([
        fetch(`${MARKET_API}/api/v3/exchangeInfo`, { cache:"no-store" }),
        fetch(`${MARKET_API}/api/v3/ticker/24hr`, { cache:"no-store" }),
      ]);
      if (!exchangeResponse.ok || !tickerResponse.ok) throw new Error("Unable to load Binance scanner universe");
      const exchange = (await exchangeResponse.json()) as ExchangeInfo;
      const tickers = (await tickerResponse.json()) as Ticker24h[];
      const active = new Set(exchange.symbols.filter((item) => item.status === "TRADING" && item.isSpotTradingAllowed !== false && ALLOWED_QUOTES.has(item.quoteAsset)).map((item) => item.symbol));
      const liquid = tickers.filter((item) => active.has(item.symbol) && Number(item.quoteVolume) >= MIN_QUOTE_VOLUME).sort((a,b) => Number(b.quoteVolume)-Number(a.quoteVolume)).slice(0, SCAN_LIMIT);

      const markets:{symbol:string; quote_volume:number; candles:CandlePayload[]}[] = [];
      for (let offset=0; offset<liquid.length; offset+=5) {
        const batch = liquid.slice(offset, offset+5);
        setProgress(`Loading candles ${Math.min(offset+batch.length, liquid.length)}/${liquid.length}`);
        const results = await Promise.allSettled(batch.map(async (item) => ({ symbol:item.symbol, quote_volume:Number(item.quoteVolume), candles:await fetchCandles(item.symbol, timeframe) })));
        for (const result of results) if (result.status === "fulfilled") markets.push(result.value);
      }

      setProgress("Scoring LONG / SHORT candidates");
      const response = await fetch(`/api/scanner/run?timeframe=${timeframe}&min_quote_volume=${MIN_QUOTE_VOLUME}`, {
        method:"POST", cache:"no-store", headers:{"content-type":"application/json"}, body:JSON.stringify(markets),
      });
      if (!response.ok) {
        const body = await response.json().catch(() => ({}));
        throw new Error(body.detail ?? "Scanner Engine failed");
      }
      await loadLogs();
      setProgress("Scan complete");
      setCountdown(AUTO_SCAN_SECONDS);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Scanner Engine failed");
      setProgress("Scan failed");
    } finally {
      setScanning(false); runningRef.current = false;
    }
  }, [timeframe, loadLogs]);

  useEffect(() => {
    if (!autoRun) { setCountdown(AUTO_SCAN_SECONDS); return; }
    const timer = window.setInterval(() => {
      setCountdown((value) => {
        if (value <= 1) { void runScanner(); return AUTO_SCAN_SECONDS; }
        return value - 1;
      });
    }, 1000);
    return () => window.clearInterval(timer);
  }, [autoRun, runScanner]);

  const pipeline = useMemo(() => [
    ["1", "Universe", "Active Spot pairs"], ["2", "Liquidity", "≥ $10M / top 30"], ["3", "Candles", "500 bars / closed only"],
    ["4", "Volume", "≥ 1.5x vs prev 20"], ["5", "Direction", "LONG + SHORT score"], ["6", "Shortlist", "Score ≥ 50"],
  ], []);

  return (
    <div className="pageWrap">
      <div className="pageHeader">
        <div><p className="eyebrow">Market Intelligence</p><h1>Scanner</h1><p className="muted">Live opportunity shortlist. Full run history remains in Engine Working Log.</p></div>
        <span className="modePill"><span />{scanning ? "Scanner running" : autoRun ? "Auto scan active" : "Scanner ready"}</span>
      </div>

      <div className="statGrid">
        <div className="statCard"><span>Last Scan</span><strong>{latest ? new Date(latest.timestamp).toLocaleTimeString() : "—"}</strong><small className="neutral">{latest?.timeframe ?? timeframe} timeframe</small></div>
        <div className="statCard"><span>Candidates</span><strong>{latest?.candidate_count ?? 0}</strong><small className="neutral">{latest?.evaluated_markets ?? 0} evaluated</small></div>
        <div className="statCard"><span>LONG</span><strong className="positive">{latest?.long_candidates ?? 0}</strong><small className="neutral">bullish opportunities</small></div>
        <div className="statCard"><span>SHORT</span><strong className="negative">{latest?.short_candidates ?? 0}</strong><small className="neutral">bearish opportunities</small></div>
      </div>

      <section className="panel" style={{padding:18, marginBottom:14}}>
        <div className="panelHead" style={{alignItems:"flex-start"}}>
          <div><p className="eyebrow">Scanner Pipeline</p><h2>Opportunity Discovery Flow</h2><p className="muted" style={{marginTop:6}}>{progress}</p></div>
          <div style={{display:"flex", gap:8, alignItems:"center", flexWrap:"wrap", justifyContent:"flex-end"}}>
            <select value={timeframe} onChange={(e) => setTimeframe(e.target.value)} disabled={scanning} style={controlStyle}>{TIMEFRAMES.map((tf) => <option key={tf}>{tf}</option>)}</select>
            <button onClick={() => void runScanner()} disabled={scanning} style={runStyle}>{scanning ? "Scanning…" : "Run Now"}</button>
            <button onClick={() => { setAutoRun((v) => !v); setCountdown(AUTO_SCAN_SECONDS); }} style={autoRun ? autoOnStyle : controlStyle}>{autoRun ? "Auto Run ON" : "Auto Run OFF"}</button>
            <span className="periodTag">Next scan {autoRun ? `${countdown}s` : "—"}</span>
          </div>
        </div>
        <div style={{display:"grid", gridTemplateColumns:"repeat(6,minmax(0,1fr))", gap:10, marginTop:18}}>
          {pipeline.map(([step,title,desc]) => <div key={step} style={{border:"1px solid #1d2a39", borderRadius:10, padding:12, background:"#0a1018"}}><span className="eyebrow">Step {step}</span><strong style={{display:"block", margin:"7px 0 4px", fontSize:12}}>{title}</strong><span className="muted" style={{fontSize:10}}>{desc}</span></div>)}
        </div>
        {error && <p className="negative" style={{marginBottom:0}}>{error}</p>}
      </section>

      <section className="panel" style={{overflow:"auto"}}>
        <div className="panelHead compact"><div><h2>Last Scan Result</h2><p className="muted" style={{marginTop:5}}>{latest ? `${latest.candidate_count} candidates · ${latest.processing_ms} ms backend processing` : "No scanner run yet"}</p></div><span className="periodTag">{latest ? `${latest.long_candidates} LONG · ${latest.short_candidates} SHORT` : "Waiting"}</span></div>
        <div style={{minWidth:1250}}>
          <div style={{...rowStyle, color:"#69768a", fontSize:9, textTransform:"uppercase"}}><span>Symbol</span><span>TF</span><span>Side</span><span>Score</span><span>L/S</span><span>24h Quote Vol</span><span>Price</span><span>RSI</span><span>Vol Ratio</span><span>Reasons</span></div>
          {!latest && <div style={{padding:28, color:"#78859a", fontSize:12}}>Run Scanner to populate the latest result.</div>}
          {latest?.candidates.map((row) => <div key={`${row.symbol}-${row.side}`} style={rowStyle}><strong>{row.symbol}</strong><span>{row.timeframe}</span><strong className={row.side === "LONG" ? "positive" : "negative"}>{row.side}</strong><strong>{row.score}</strong><span>{row.long_score}/{row.short_score}</span><span>${fmt(row.quote_volume,0)}</span><span>{fmt(row.last_price,6)}</span><span>{fmt(row.rsi_14,2)}</span><span>{fmt(row.volume_ratio,2)}x</span><span title={row.reasons.join(" · ")}>{row.reasons.join(" · ") || "—"}</span></div>)}
        </div>
      </section>
    </div>
  );
}

const controlStyle = { background:"#0b1118", color:"#dfe7f1", border:"1px solid #263242", borderRadius:7, padding:"8px 10px", cursor:"pointer" } as const;
const runStyle = { ...controlStyle, background:"#173329", color:"#69e4b8", border:"1px solid #285845", fontWeight:700 } as const;
const autoOnStyle = { ...controlStyle, background:"#182d3c", color:"#77c8ff", border:"1px solid #29506a", fontWeight:700 } as const;
const rowStyle = { display:"grid", gridTemplateColumns:"105px 45px 65px 55px 65px 125px 100px 65px 75px minmax(380px,1fr)", gap:10, padding:"10px 14px", borderBottom:"1px solid #171f2a", fontSize:10, alignItems:"center" } as const;
