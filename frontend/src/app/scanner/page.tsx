"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type StageDiag={passed:number;dropped:number;passed_symbols:string[];dropped_symbols:string[]};
type Pipeline={scan_pool?:StageDiag;trend_1h?:StageDiag;participation?:StageDiag;top_30?:StageDiag};
type Candidate={symbol:string;side:"LONG"|"SHORT";score:number;quote_volume:number;last_price:number;structure_1h?:string;ema20_1h?:number;ema50_1h?:number;ema200_1h?:number;rsi_1h?:number;rvol_1h?:number;atr_pct_1h?:number;oi_change_1h_pct?:number;spread_pct?:number;reasons:string[]};
type ScannerRun={timestamp:string;engine:string;version?:string;status:string;market?:string;timeframe?:string;candidate_count:number;long_candidates:number;short_candidates:number;pipeline?:Pipeline;processing_ms:number;candidates:Candidate[]};
type LogsResponse={engine:string;logs:ScannerRun[]};
type WorkerStatus={running:boolean;interval_seconds:number;architecture?:string;schedule?:{scanner:string};scan_pool_limit:number;top_limit:number;min_quote_volume:number;last_started_at?:string|null;last_finished_at?:string|null;last_error?:string|null;last_candidate_count:number;last_long_candidates:number;last_short_candidates:number;last_scan_pool:number;last_trend_passed:number;last_top30:number;last_layer?:string;rate_limited?:boolean;retry_in_seconds?:number;next_scan_in_seconds?:number;run_count:number};

function fmt(v:number|undefined,d=2){return v===undefined||!Number.isFinite(v)?"—":v.toLocaleString(undefined,{maximumFractionDigits:d})}
function duration(seconds:number){const s=Math.max(0,Math.floor(seconds));const h=Math.floor(s/3600);const m=Math.floor((s%3600)/60);const r=s%60;return h>0?(h+"h "+String(m).padStart(2,"0")+"m "+String(r).padStart(2,"0")+"s"):(m+"m "+String(r).padStart(2,"0")+"s")}

export default function ScannerPage(){
 const[logs,setLogs]=useState<ScannerRun[]>([]);
 const[worker,setWorker]=useState<WorkerStatus|null>(null);
 const[scanning,setScanning]=useState(false);
 const[error,setError]=useState<string|null>(null);
 const[selectedStage,setSelectedStage]=useState("1H Trend");
 const[cooldown,setCooldown]=useState(0);
 const[nextScan,setNextScan]=useState(0);
 const latest=logs[0];

 const load=useCallback(async()=>{
  try{
   const[lr,wr]=await Promise.all([fetch("/api/scanner/logs",{cache:"no-store"}),fetch("/api/scanner/worker/status",{cache:"no-store"})]);
   if(!lr.ok||!wr.ok)throw new Error("Unable to load Futures Scanner state");
   const fresh=(await lr.json() as LogsResponse).logs??[];
   if(fresh.length){setLogs(fresh);window.localStorage.setItem("rakib-scanner-latest",JSON.stringify(fresh[0]))}
   else{const cached=window.localStorage.getItem("rakib-scanner-latest");if(cached){try{setLogs([JSON.parse(cached) as ScannerRun])}catch{setLogs([])}}else setLogs([])}
   const ws=await wr.json() as WorkerStatus;
   setWorker(ws);
   setCooldown(ws.retry_in_seconds??0);
   setNextScan(ws.next_scan_in_seconds??0);
   setError(null);
  }catch(e){setError(e instanceof Error?e.message:"Unable to load scanner")}
 },[]);

 useEffect(()=>{const cached=window.localStorage.getItem("rakib-scanner-latest");if(cached){try{setLogs([JSON.parse(cached) as ScannerRun])}catch{}}void load();const id=window.setInterval(()=>void load(),15000);return()=>window.clearInterval(id)},[load]);
 useEffect(()=>{const id=window.setInterval(()=>{setCooldown(v=>Math.max(0,v-1));setNextScan(v=>Math.max(0,v-1))},1000);return()=>window.clearInterval(id)},[]);

 const runNow=useCallback(async()=>{
  if(scanning||worker?.rate_limited)return;
  setScanning(true);setError(null);
  try{
   const r=await fetch("/api/scanner/run",{method:"POST",cache:"no-store"});
   if(!r.ok){const b=await r.json().catch(()=>({}));throw new Error(b.detail??"1H Futures Scanner failed")}
   await load();
  }catch(e){setError(e instanceof Error?e.message:"1H Futures Scanner failed")}
  finally{setScanning(false)}
 },[scanning,worker?.rate_limited,load]);

 const stages=useMemo(()=>[
  {title:"Scan Pool",rule:"Max 200 liquid unique USD-M perpetuals",diag:latest?.pipeline?.scan_pool??null},
  {title:"1H Trend",rule:"HH/HL or LH/LL + EMA20/50/200",diag:latest?.pipeline?.trend_1h??null},
  {title:"1H Quality",rule:"RVOL + ATR% + RSI + OI change + spread",diag:latest?.pipeline?.participation??null},
  {title:"Top 30",rule:"Rank strongest 1H trend/quality contracts",diag:latest?.pipeline?.top_30??null},
 ],[latest]);

 const active=stages.find(s=>s.title===selectedStage)??stages[0];
 const passed=active.diag?.passed_symbols??[];
 const dropped=active.diag?.dropped_symbols??[];

 return <div className="pageWrap">
  <div className="pageHeader">
   <div><p className="eyebrow">Binance USD-M Futures</p><h1>Scanner</h1><p className="muted">Scanner is 1H only: Scan Pool → Trend → Quality → Top 30. Strategy starts after this boundary.</p></div>
   <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",justifyContent:"flex-end"}}>\n    <span className="modePill"><span />{worker?.running?"Auto 1H active":"Auto 1H inactive"}</span>\n    <button onClick={()=>void runNow()} disabled={scanning||worker?.rate_limited} style={manualRunStyle}>{worker?.rate_limited?"Manual Scan · Cooldown":scanning?"Manual Scan · Running…":"Manual Scan"}</button>\n   </div>
  </div>

  <div className="statGrid">
   <div className="statCard"><span>Last 1H Scan</span><strong>{latest?new Date(latest.timestamp).toLocaleTimeString():"—"}</strong><small className="neutral">Top30 locks for current 1H cycle</small></div>
   <div className="statCard"><span>Scan Pool</span><strong>{latest?.pipeline?.scan_pool?.passed??worker?.last_scan_pool??0}</strong><small className="neutral">max 200 liquid perpetuals</small></div>
   <div className="statCard"><span>LONG Bias</span><strong className="positive">{latest?.long_candidates??0}</strong><small className="neutral">inside Scanner Top30</small></div>
   <div className="statCard"><span>SHORT Bias</span><strong className="negative">{latest?.short_candidates??0}</strong><small className="neutral">inside Scanner Top30</small></div>
  </div>

  <section className="panel" style={{padding:18,marginBottom:14}}>
   <div className="panelHead" style={{alignItems:"flex-start"}}>
    <div><p className="eyebrow">1H Scanner Pipeline</p><h2>Scanner Ends at Top 30</h2><p className="muted" style={{marginTop:6}}>First successful run → Top30 locked → next new 1H candle refreshes Scanner universe.</p></div>
    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
     <span className="periodTag">Runs {worker?.run_count??0}</span>
     <span className="periodTag">{worker?.last_layer??"startup"}</span>
     {worker?.rate_limited?<span className="periodTag">Retry in {duration(cooldown)}</span>:<span className="periodTag">Next 1H scan {duration(nextScan)}</span>}
     <span className="periodTag">Top30 {worker?.last_top30??latest?.pipeline?.top_30?.passed??0}</span>
     <button onClick={()=>void runNow()} disabled={scanning||worker?.rate_limited} style={manualRunStyle}>{worker?.rate_limited?"Cooldown":scanning?"Scanning…":"Run 1H Now"}</button>
     <button onClick={()=>void load()} style={controlStyle}>Refresh</button>
    </div>
   </div>

   <div style={pipelineWrap}>
    {stages.map((s,i)=><button key={s.title} onClick={()=>setSelectedStage(s.title)} style={{...pipelineCard,...(s.title===selectedStage?pipelineSelected:{})}}>
     <span className="eyebrow">Step {i+1}</span><strong style={{display:"block",margin:"7px 0 5px",fontSize:12}}>{s.title}</strong><span className="muted" style={{fontSize:9}}>{s.rule}</span>
     <div style={{display:"flex",gap:10,marginTop:10,fontSize:10}}><span className="positive">Pass {s.diag?.passed??"—"}</span><span className="negative">Drop {s.diag?.dropped??"—"}</span></div>
    </button>)}
   </div>

   <div style={tracePanel}>
    <div style={{display:"flex",justifyContent:"space-between",gap:12,alignItems:"center",flexWrap:"wrap"}}>
     <div><strong>{active.title} diagnostics</strong><div className="muted" style={{fontSize:10,marginTop:4}}>{active.rule}</div></div>
     <span className="periodTag">Pass {active.diag?.passed??0} · Drop {active.diag?.dropped??0}</span>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:12}}>
     <div><div className="positive" style={labelStyle}>PASSED CONTRACTS</div><div style={symbolBox}>{passed.length?passed.join(" · "):"None"}</div></div>
     <div><div className="negative" style={labelStyle}>DROPPED / HOLD HERE</div><div style={symbolBox}>{dropped.length?dropped.join(" · "):"None"}</div></div>
    </div>
   </div>

   {worker?.rate_limited?<p className="muted" style={{marginBottom:0}}>Binance cooldown active · first 1H Scanner run will retry automatically in {duration(cooldown)}.</p>:worker?.last_error&&<p className="negative" style={{marginBottom:0}}>Worker: {worker.last_error}</p>}
   {error&&<p className="negative" style={{marginBottom:0}}>{error}</p>}
  </section>

  <section className="panel" style={{overflow:"auto"}}>
   <div className="panelHead compact">
    <div><h2>Locked Top 30 for Current 1H Cycle</h2><p className="muted" style={{marginTop:5}}>{latest?(latest.candidate_count+" contracts · "+latest.processing_ms+" ms"):"No successful 1H scan yet"}</p></div>
    <span className="periodTag">{latest?(latest.long_candidates+" LONG bias · "+latest.short_candidates+" SHORT bias"):"Waiting"}</span>
   </div>
   <div style={{minWidth:1450}}>
    <div style={{...rowStyle,color:"#69768a",fontSize:9,textTransform:"uppercase"}}><span>Contract</span><span>Bias</span><span>Score</span><span>1H Structure</span><span>EMA20</span><span>EMA50</span><span>EMA200</span><span>RSI</span><span>RVOL</span><span>ATR%</span><span>OI Δ 1H</span><span>Spread</span><span>24h Quote Vol</span><span>Price</span><span>Reasons</span></div>
    {!latest?.candidates.length&&<div style={{padding:28,color:"#78859a",fontSize:12}}>Waiting for first successful 1H Scanner run.</div>}
    {latest?.candidates.map(c=><div key={c.symbol+"-"+c.side} style={rowStyle}>
     <strong>{c.symbol}</strong><strong className={c.side==="LONG"?"positive":"negative"}>{c.side}</strong><strong>{c.score}</strong><span>{c.structure_1h??"—"}</span><span>{fmt(c.ema20_1h,6)}</span><span>{fmt(c.ema50_1h,6)}</span><span>{fmt(c.ema200_1h,6)}</span><span>{fmt(c.rsi_1h,2)}</span><span>{fmt(c.rvol_1h,2)}x</span><span>{fmt(c.atr_pct_1h,2)}%</span><span className={(c.oi_change_1h_pct??0)>=0?"positive":"negative"}>{fmt(c.oi_change_1h_pct,2)}%</span><span>{fmt(c.spread_pct,4)}%</span><span>{"$"}{fmt(c.quote_volume,0)}</span><span>{fmt(c.last_price,6)}</span><span title={c.reasons.join(" · ")}>{c.reasons.join(" · ")||"—"}</span>
    </div>)}
   </div>
  </section>
 </div>
}

const controlStyle={background:"#0b1118",color:"#dfe7f1",border:"1px solid #263242",borderRadius:7,padding:"8px 10px",cursor:"pointer"} as const;
const manualRunStyle={...controlStyle,background:"#173329",color:"#69e4b8",border:"1px solid #285845",fontWeight:700} as const;
const pipelineWrap={display:"grid",gridTemplateColumns:"repeat(4,minmax(180px,1fr))",gap:10,marginTop:18,overflowX:"auto",paddingBottom:4} as const;
const pipelineCard={textAlign:"left",border:"1px solid #1d2a39",borderRadius:10,padding:12,background:"#0a1018",color:"#e8edf6",cursor:"pointer",minWidth:180} as const;
const pipelineSelected={border:"1px solid #3b8068",background:"#102019"} as const;
const tracePanel={marginTop:12,border:"1px solid #1d2a39",borderRadius:10,padding:14,background:"#090f16"} as const;
const symbolBox={minHeight:54,maxHeight:120,overflow:"auto",border:"1px solid #192331",borderRadius:8,padding:10,color:"#9aa7ba",fontSize:10,lineHeight:1.7} as const;
const labelStyle={fontSize:10,fontWeight:700,marginBottom:7} as const;
const rowStyle={display:"grid",gridTemplateColumns:"100px 60px 55px 90px 85px 85px 85px 60px 65px 65px 75px 70px 120px 90px minmax(360px,1fr)",gap:9,padding:"10px 14px",borderBottom:"1px solid #171f2a",fontSize:10,alignItems:"center"} as const;
