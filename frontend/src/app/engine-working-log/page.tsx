"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type IndicatorLog={timestamp:string;engine:string;symbol:string;timeframe:string;status:string;ema_9?:number;ema_20?:number;ema_21?:number;ema_50?:number;ema_200?:number;rsi_14?:number;macd?:number;macd_signal?:number;macd_histogram?:number;volume_ratio?:number;processing_ms?:number;error?:string};
type Candidate={symbol:string;timeframe:string;side:"LONG"|"SHORT";score:number;long_score:number;short_score:number;quote_volume:number;last_price:number;rsi_14:number;macd:number;macd_signal:number;volume_ratio:number;reasons:string[]};
type ScannerRun={timestamp:string;engine:string;status:string;timeframe:string;min_volume_ratio?:number;candidate_count:number;long_candidates?:number;short_candidates?:number;processing_ms:number;candidates:Candidate[]};
type WorkerStatus={running:boolean;interval_seconds:number;timeframe:string;scan_pool_limit:number;scan_limit:number;min_quote_volume:number;min_volume_ratio:number;last_started_at?:string|null;last_finished_at?:string|null;last_error?:string|null;last_candidate_count:number;last_long_candidates:number;last_short_candidates:number;run_count:number};
type CandlePayload={open_time:number;open:string;high:string;low:string;close:string;volume:string;close_time:number};

const FUTURES_API="https://fapi.binance.com";
const HISTORY_LIMIT=500;
const TIMEFRAMES=["1m","5m","15m","1h","4h","1d"];

function localDateValue(date:Date){const y=date.getFullYear();const m=String(date.getMonth()+1).padStart(2,"0");const d=String(date.getDate()).padStart(2,"0");return`${y}-${m}-${d}`}
function n(v:number|undefined,d=4){return v===undefined||!Number.isFinite(v)?"—":v.toLocaleString(undefined,{maximumFractionDigits:d})}
function csvDownload(filename:string,rows:(string|number|null|undefined)[][]){const esc=(v:unknown)=>`"${String(v??"").replaceAll('"','""')}"`;const csv=rows.map(r=>r.map(esc).join(",")).join("\n");const blob=new Blob([csv],{type:"text/csv;charset=utf-8"});const url=URL.createObjectURL(blob);const a=document.createElement("a");a.href=url;a.download=filename;a.click();URL.revokeObjectURL(url)}
async function fetchFuturesCandles(symbol:string,timeframe:string){const r=await fetch(`${FUTURES_API}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(timeframe)}&limit=${HISTORY_LIMIT}`,{cache:"no-store"});if(!r.ok)throw new Error("Unable to load futures candles");const rows=await r.json() as (string|number)[][];return rows.map(x=>({open_time:Number(x[0]),open:String(x[1]),high:String(x[2]),low:String(x[3]),close:String(x[4]),volume:String(x[5]),close_time:Number(x[6])})) as CandlePayload[]}

export default function EngineWorkingLogPage(){
 const today=useMemo(()=>localDateValue(new Date()),[]);
 const[startDate,setStartDate]=useState(today);const[endDate,setEndDate]=useState(today);const[symbol,setSymbol]=useState("BTCUSDT");const[timeframe,setTimeframe]=useState("15m");
 const[indicatorLogs,setIndicatorLogs]=useState<IndicatorLog[]>([]);const[scannerLogs,setScannerLogs]=useState<ScannerRun[]>([]);const[worker,setWorker]=useState<WorkerStatus|null>(null);const[runningIndicator,setRunningIndicator]=useState(false);const[error,setError]=useState<string|null>(null);

 const loadIndicator=useCallback(async()=>{try{const start=new Date(`${startDate}T00:00:00`).toISOString();const end=new Date(`${endDate}T23:59:59.999`).toISOString();const r=await fetch(`/api/indicators/logs?${new URLSearchParams({start,end})}`,{cache:"no-store"});if(!r.ok)throw new Error("Unable to load Indicator Engine logs");setIndicatorLogs((await r.json()).logs??[])}catch(e){setError(e instanceof Error?e.message:"Indicator log error")}},[startDate,endDate]);
 const loadScanner=useCallback(async()=>{try{const[lr,wr]=await Promise.all([fetch("/api/scanner/logs",{cache:"no-store"}),fetch("/api/scanner/worker/status",{cache:"no-store"})]);if(!lr.ok||!wr.ok)throw new Error("Unable to load Scanner worker/logs");setScannerLogs((await lr.json()).logs??[]);setWorker(await wr.json())}catch(e){setError(e instanceof Error?e.message:"Scanner log error")}},[]);
 useEffect(()=>{void loadIndicator();void loadScanner();const id=window.setInterval(()=>void loadScanner(),15000);return()=>window.clearInterval(id)},[loadIndicator,loadScanner]);

 const runIndicator=async()=>{const s=symbol.trim().replace(/[/\-\s]/g,"").toUpperCase();if(!s)return;setRunningIndicator(true);setError(null);try{const candles=await fetchFuturesCandles(s,timeframe);const r=await fetch(`/api/indicators/run/${s}?timeframe=${timeframe}&limit=${HISTORY_LIMIT}`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(candles)});if(!r.ok){const b=await r.json().catch(()=>({}));throw new Error(b.detail??"Indicator Engine failed")}setSymbol(s);await loadIndicator()}catch(e){setError(e instanceof Error?e.message:"Indicator Engine failed")}finally{setRunningIndicator(false)}};

 const downloadIndicator=()=>csvDownload(`indicator-engine-${startDate}-to-${endDate}.csv`,[["timestamp","symbol","timeframe","status","ema9","ema20","ema21","ema50","ema200","rsi14","macd","signal","histogram","volume_ratio","ms","error"],...indicatorLogs.map(x=>[x.timestamp,x.symbol,x.timeframe,x.status,x.ema_9,x.ema_20,x.ema_21,x.ema_50,x.ema_200,x.rsi_14,x.macd,x.macd_signal,x.macd_histogram,x.volume_ratio,x.processing_ms,x.error])]);
 const downloadScanner=()=>csvDownload(`futures-scanner-${today}.csv`,[["timestamp","symbol","timeframe","side","score","long_score","short_score","quote_volume","last_price","rsi14","macd","signal","volume_ratio","reasons"],...scannerLogs.flatMap(run=>run.candidates.map(c=>[run.timestamp,c.symbol,c.timeframe,c.side,c.score,c.long_score,c.short_score,c.quote_volume,c.last_price,c.rsi_14,c.macd,c.macd_signal,c.volume_ratio,c.reasons.join(" | ")]))]);
 const latest=scannerLogs[0];

 return <div className="pageWrap">
  <div className="pageHeader"><div><p className="eyebrow">Engine Observability</p><h1>Engine Working Log</h1><p className="muted">Each engine stays compact. Open only the engine log you want to inspect.</p></div><span className="modePill"><span />{worker?.running?"Scanner worker active":"Scanner worker inactive"}</span></div>
  {error&&<div className="panel" style={{padding:12,marginBottom:12}}><span className="negative">{error}</span></div>}

  <details className="panel" style={detailsStyle}>
   <summary style={summaryStyle}><div><p className="eyebrow">1. Engine</p><strong>Indicator Engine</strong><div className="muted" style={{fontSize:10,marginTop:4}}>{indicatorLogs.length} log rows · USD-M futures candles</div></div><span className="periodTag">Open log ▾</span></summary>
   <div style={bodyStyle}>
    <div style={toolbarStyle}><label style={labelStyle}>From<br/><input type="date" value={startDate} onChange={e=>setStartDate(e.target.value)} style={inputStyle}/></label><label style={labelStyle}>To<br/><input type="date" value={endDate} onChange={e=>setEndDate(e.target.value)} style={inputStyle}/></label><button style={buttonStyle} onClick={()=>void loadIndicator()}>Apply</button><button style={buttonStyle} onClick={downloadIndicator} disabled={!indicatorLogs.length}>Download CSV</button></div>
    <div style={toolbarStyle}><label style={labelStyle}>Test Contract<br/><input value={symbol} onChange={e=>setSymbol(e.target.value.toUpperCase())} style={inputStyle}/></label><label style={labelStyle}>TF<br/><select value={timeframe} onChange={e=>setTimeframe(e.target.value)} style={inputStyle}>{TIMEFRAMES.map(tf=><option key={tf}>{tf}</option>)}</select></label><button style={runStyle} disabled={runningIndicator} onClick={()=>void runIndicator()}>{runningIndicator?"Running…":"Run Indicator"}</button></div>
    <div style={{overflow:"auto"}}><div style={{minWidth:1320}}><div style={{...indicatorRow,...headStyle}}><span>Time</span><span>Symbol</span><span>TF</span><span>Status</span><span>EMA9</span><span>EMA21</span><span>EMA50</span><span>EMA200</span><span>RSI</span><span>MACD</span><span>Signal</span><span>Vol</span><span>ms</span></div>{indicatorLogs.slice(0,100).map((x,i)=><div key={`${x.timestamp}-${i}`} style={indicatorRow}><span>{new Date(x.timestamp).toLocaleString()}</span><strong>{x.symbol}</strong><span>{x.timeframe}</span><span className={x.status==="success"?"positive":"negative"}>{x.status}</span><span>{n(x.ema_9)}</span><span>{n(x.ema_21)}</span><span>{n(x.ema_50)}</span><span>{n(x.ema_200)}</span><span>{n(x.rsi_14,2)}</span><span>{n(x.macd)}</span><span>{n(x.macd_signal)}</span><span>{n(x.volume_ratio,2)}x</span><span>{n(x.processing_ms,2)}</span></div>)}</div></div>
   </div>
  </details>

  <details className="panel" open style={detailsStyle}>
   <summary style={summaryStyle}><div><p className="eyebrow">2. Engine</p><strong>Futures Scanner Engine</strong><div className="muted" style={{fontSize:10,marginTop:4}}>{worker?.running?`Python loop every ${worker.interval_seconds}s · ${worker.timeframe}`:"Worker not running"}</div></div><span className="periodTag">Open log ▾</span></summary>
   <div style={bodyStyle}>
    <div style={{display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:10,marginBottom:12}}><div style={miniCard}><span>Worker</span><strong className={worker?.running?"positive":"negative"}>{worker?.running?"RUNNING":"STOPPED"}</strong></div><div style={miniCard}><span>Runs</span><strong>{worker?.run_count??0}</strong></div><div style={miniCard}><span>Last result</span><strong>{worker?.last_candidate_count??latest?.candidate_count??0}</strong><small>{worker?.last_long_candidates??latest?.long_candidates??0} LONG · {worker?.last_short_candidates??latest?.short_candidates??0} SHORT</small></div><div style={miniCard}><span>Last finish</span><strong style={{fontSize:11}}>{worker?.last_finished_at?new Date(worker.last_finished_at).toLocaleString():"—"}</strong></div></div>
    {worker?.last_error&&<div className="negative" style={{marginBottom:10,fontSize:11}}>Worker error: {worker.last_error}</div>}
    <div style={{...toolbarStyle,justifyContent:"space-between"}}><span className="muted">Latest scanner runs and candidates. Backend loop keeps scanning while the Render service is awake.</span><div style={{display:"flex",gap:8}}><button style={buttonStyle} onClick={()=>void loadScanner()}>Refresh</button><button style={buttonStyle} onClick={downloadScanner} disabled={!scannerLogs.length}>Download CSV</button></div></div>
    <div style={{overflow:"auto"}}><div style={{minWidth:1100}}><div style={{...scannerRow,...headStyle}}><span>Time</span><span>TF</span><span>Candidates</span><span>LONG</span><span>SHORT</span><span>Vol Gate</span><span>ms</span></div>{scannerLogs.slice(0,50).map((x,i)=><div key={`${x.timestamp}-${i}`} style={scannerRow}><span>{new Date(x.timestamp).toLocaleString()}</span><span>{x.timeframe}</span><strong>{x.candidate_count}</strong><span className="positive">{x.long_candidates??0}</span><span className="negative">{x.short_candidates??0}</span><span>{n(x.min_volume_ratio,2)}x</span><span>{n(x.processing_ms,2)}</span></div>)}</div></div>
   </div>
  </details>
 </div>
}

const detailsStyle={marginBottom:12,overflow:"hidden"} as const;
const summaryStyle={display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,padding:"16px 18px",cursor:"pointer",listStyle:"none"} as const;
const bodyStyle={padding:"0 18px 18px",borderTop:"1px solid #192231"} as const;
const toolbarStyle={display:"flex",gap:10,alignItems:"end",flexWrap:"wrap",paddingTop:14,marginBottom:12} as const;
const labelStyle={fontSize:10,color:"#8390a5"} as const;
const inputStyle={marginTop:5,background:"#0b1118",color:"#dfe7f1",border:"1px solid #263242",borderRadius:7,padding:"8px 10px"} as const;
const buttonStyle={background:"#0b1118",color:"#dfe7f1",border:"1px solid #263242",borderRadius:7,padding:"8px 11px",cursor:"pointer"} as const;
const runStyle={...buttonStyle,background:"#173329",color:"#69e4b8",border:"1px solid #285845",fontWeight:700} as const;
const miniCard={border:"1px solid #1d2a39",borderRadius:9,padding:12,background:"#0a1018",display:"flex",flexDirection:"column",gap:5,fontSize:10} as const;
const headStyle={color:"#69768a",fontSize:9,textTransform:"uppercase"} as const;
const indicatorRow={display:"grid",gridTemplateColumns:"150px 95px 45px 65px 80px 80px 80px 80px 60px 85px 85px 65px 55px",gap:8,padding:"9px 10px",borderBottom:"1px solid #171f2a",fontSize:10,alignItems:"center"} as const;
const scannerRow={display:"grid",gridTemplateColumns:"180px 70px 100px 80px 80px 100px 80px",gap:10,padding:"10px",borderBottom:"1px solid #171f2a",fontSize:10,alignItems:"center"} as const;
