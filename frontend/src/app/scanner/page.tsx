"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type StageDiag={passed:number;dropped:number;passed_symbols:string[];dropped_symbols:string[]};
type Pipeline={scan_pool?:StageDiag;trend_1h?:StageDiag;participation?:StageDiag;top_30?:StageDiag};
type Candidate={symbol:string;side:"LONG"|"SHORT";score:number;quote_volume:number;last_price:number;structure_1h?:string;ema20_1h?:number;ema50_1h?:number;ema200_1h?:number;rsi_1h?:number;rvol_1h?:number;atr_pct_1h?:number;oi_change_1h_pct?:number;spread_pct?:number;reasons:string[]};
type ScannerRun={timestamp:string;engine:string;version?:string;status:string;candidate_count:number;long_candidates:number;short_candidates:number;pipeline?:Pipeline;processing_ms:number;candidates:Candidate[]};
type ScannerLogsResponse={engine:string;logs:ScannerRun[]};
type ScannerWorkerStatus={running:boolean;last_error?:string|null;last_layer?:string;rate_limited?:boolean;retry_in_seconds?:number;next_scan_in_seconds?:number;run_count:number;last_scan_pool:number;last_top30:number};

type StrategyRow={symbol:string;side:"LONG"|"SHORT";status:"PASS"|"HOLD";score:number;scanner_score?:number;rsi_15m?:number;macd_histogram_15m?:number;rvol_15m?:number;atr_pct_15m?:number;reasons?:string[];hold_reasons?:string[]};
type StrategyRun={timestamp:string;input_count:number;pass_count:number;hold_count:number;long_pass:number;short_pass:number;processing_ms:number;rows:StrategyRow[]};
type StrategyLogsResponse={engine:string;logs:StrategyRun[]};
type StrategyWorkerStatus={running:boolean;last_error?:string|null;last_layer?:string;run_count:number;last_input_count:number;last_pass_count:number;last_hold_count:number};

type EntryRow={symbol:string;side:"LONG"|"SHORT";status:"ENTRY"|"HOLD";score:number;strategy_score?:number;close_5m?:number;ema9_5m?:number;ema20_5m?:number;ema50_5m?:number;rsi_5m?:number;macd_histogram_5m?:number;rvol_5m?:number;atr_pct_5m?:number;reasons?:string[];hold_reasons?:string[]};
type EntryRun={timestamp:string;input_count:number;entry_count:number;hold_count:number;long_entry:number;short_entry:number;processing_ms:number;rows:EntryRow[]};
type EntryLogsResponse={engine:string;logs:EntryRun[]};
type EntryWorkerStatus={running:boolean;last_error?:string|null;last_layer?:string;run_count:number;last_input_count:number;last_entry_count:number;last_hold_count:number};

function fmt(v:number|undefined,d=2){return v===undefined||!Number.isFinite(v)?"—":v.toLocaleString(undefined,{maximumFractionDigits:d})}
function duration(seconds:number){const s=Math.max(0,Math.floor(seconds));const h=Math.floor(s/3600);const m=Math.floor((s%3600)/60);const r=s%60;return h>0?(h+"h "+String(m).padStart(2,"0")+"m "+String(r).padStart(2,"0")+"s"):(m+"m "+String(r).padStart(2,"0")+"s")}
function diagFromRows(rows:{symbol:string;status:string}[],passStatus:string):StageDiag{
 const passed=rows.filter(row=>row.status===passStatus).map(row=>row.symbol);
 const dropped=rows.filter(row=>row.status!==passStatus).map(row=>row.symbol);
 return {passed:passed.length,dropped:dropped.length,passed_symbols:passed,dropped_symbols:dropped};
}

export default function ScannerPage(){
 const[logs,setLogs]=useState<ScannerRun[]>([]);
 const[worker,setWorker]=useState<ScannerWorkerStatus|null>(null);
 const[strategyLogs,setStrategyLogs]=useState<StrategyRun[]>([]);
 const[strategyWorker,setStrategyWorker]=useState<StrategyWorkerStatus|null>(null);
 const[entryLogs,setEntryLogs]=useState<EntryRun[]>([]);
 const[entryWorker,setEntryWorker]=useState<EntryWorkerStatus|null>(null);
 const[scanning,setScanning]=useState(false);
 const[error,setError]=useState<string|null>(null);
 const[selectedStage,setSelectedStage]=useState("1H Trend");
 const[cooldown,setCooldown]=useState(0);
 const[nextScan,setNextScan]=useState(0);

 const latest=logs[0];
 const latestStrategy=strategyLogs[0];
 const latestEntry=entryLogs[0];

 const load=useCallback(async()=>{
  try{
   const[scannerLogsResponse,scannerStatusResponse,strategyLogsResponse,strategyStatusResponse,entryLogsResponse,entryStatusResponse]=await Promise.all([
    fetch("/api/scanner/logs",{cache:"no-store"}),
    fetch("/api/scanner/worker/status",{cache:"no-store"}),
    fetch("/api/strategy/logs",{cache:"no-store"}),
    fetch("/api/strategy/worker/status",{cache:"no-store"}),
    fetch("/api/entry/logs",{cache:"no-store"}),
    fetch("/api/entry/worker/status",{cache:"no-store"}),
   ]);
   if(!scannerLogsResponse.ok||!scannerStatusResponse.ok||!strategyLogsResponse.ok||!strategyStatusResponse.ok||!entryLogsResponse.ok||!entryStatusResponse.ok){
    throw new Error("Unable to load Scanner pipeline state");
   }

   const fresh=(await scannerLogsResponse.json() as ScannerLogsResponse).logs??[];
   if(fresh.length){
    setLogs(fresh);
    window.localStorage.setItem("rakib-scanner-latest",JSON.stringify(fresh[0]));
   }else{
    const cached=window.localStorage.getItem("rakib-scanner-latest");
    if(cached){try{setLogs([JSON.parse(cached) as ScannerRun])}catch{setLogs([])}}else setLogs([]);
   }

   const scannerStatus=await scannerStatusResponse.json() as ScannerWorkerStatus;
   setWorker(scannerStatus);
   setCooldown(scannerStatus.retry_in_seconds??0);
   setNextScan(scannerStatus.next_scan_in_seconds??0);
   setStrategyLogs((await strategyLogsResponse.json() as StrategyLogsResponse).logs??[]);
   setStrategyWorker(await strategyStatusResponse.json() as StrategyWorkerStatus);
   setEntryLogs((await entryLogsResponse.json() as EntryLogsResponse).logs??[]);
   setEntryWorker(await entryStatusResponse.json() as EntryWorkerStatus);
   setError(null);
  }catch(e){
   setError(e instanceof Error?e.message:"Unable to load Scanner pipeline");
  }
 },[]);

 useEffect(()=>{
  const cached=window.localStorage.getItem("rakib-scanner-latest");
  if(cached){try{setLogs([JSON.parse(cached) as ScannerRun])}catch{}}
  void load();
  const id=window.setInterval(()=>void load(),15000);
  return()=>window.clearInterval(id);
 },[load]);

 useEffect(()=>{
  const id=window.setInterval(()=>{
   setCooldown(v=>Math.max(0,v-1));
   setNextScan(v=>Math.max(0,v-1));
  },1000);
  return()=>window.clearInterval(id);
 },[]);

 const runNow=useCallback(async()=>{
  if(scanning||worker?.rate_limited)return;
  setScanning(true);
  setError(null);
  try{
   const response=await fetch("/api/scanner/run",{method:"POST",cache:"no-store"});
   if(!response.ok){
    const body=await response.json().catch(()=>({}));
    throw new Error(body.detail??"1H Futures Scanner failed");
   }
   await load();
  }catch(e){
   setError(e instanceof Error?e.message:"1H Futures Scanner failed");
  }finally{
   setScanning(false);
  }
 },[scanning,worker?.rate_limited,load]);

 const strategyDiag=useMemo(()=>diagFromRows(latestStrategy?.rows??[],"PASS"),[latestStrategy]);
 const entryDiag=useMemo(()=>diagFromRows(latestEntry?.rows??[],"ENTRY"),[latestEntry]);

 const stages=useMemo(()=>[
  {title:"Scan Pool",rule:"Max 200 liquid unique USD-M perpetuals",diag:latest?.pipeline?.scan_pool??null},
  {title:"1H Trend",rule:"HH/HL or LH/LL + EMA20/50/200",diag:latest?.pipeline?.trend_1h??null},
  {title:"1H Quality",rule:"RVOL + ATR% + RSI + OI change + spread",diag:latest?.pipeline?.participation??null},
  {title:"Top 30",rule:"Rank strongest 1H trend/quality contracts",diag:latest?.pipeline?.top_30??null},
  {title:"15m Setup",rule:"Existing Strategy Engine PASS / HOLD",diag:latestStrategy?strategyDiag:null},
  {title:"5m Entry",rule:"15m PASS only → ENTRY / HOLD",diag:latestEntry?entryDiag:null},
 ],[latest,latestStrategy,latestEntry,strategyDiag,entryDiag]);

 const active=stages.find(stage=>stage.title===selectedStage)??stages[0];
 const passed=active.diag?.passed_symbols??[];
 const dropped=active.diag?.dropped_symbols??[];

 return <div className="pageWrap">
  <div className="pageHeader">
   <div>
    <p className="eyebrow">Binance USD-M Futures</p>
    <h1>Scanner</h1>
    <p className="muted">1H max 200 → filtered Top 30 → 15m Setup → 5m Entry. Final Scanner flow ends at the 5m Entry result.</p>
   </div>
   <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",justifyContent:"flex-end"}}>
    <span className="modePill"><span />{worker?.running?"Auto 1H active":"Auto 1H inactive"}</span>
    <span className="periodTag">{strategyWorker?.running?"15m active":"15m inactive"}</span>
    <span className="periodTag">{entryWorker?.running?"5m active":"5m inactive"}</span>
    <button onClick={()=>void runNow()} disabled={scanning||worker?.rate_limited} style={manualRunStyle}>
     {worker?.rate_limited?"Manual Scan · Cooldown":scanning?"Manual Scan · Running…":"Manual Scan"}
    </button>
   </div>
  </div>

  <div className="statGrid">
   <div className="statCard"><span>Scan Pool</span><strong>{latest?.pipeline?.scan_pool?.passed??worker?.last_scan_pool??0}</strong><small className="neutral">max 200 symbols</small></div>
   <div className="statCard"><span>1H Top 30</span><strong>{latest?.candidate_count??worker?.last_top30??0}</strong><small className="neutral">filtered 1H output</small></div>
   <div className="statCard"><span>15m PASS</span><strong className="positive">{latestStrategy?.pass_count??strategyWorker?.last_pass_count??0}</strong><small className="neutral">setup confirmed</small></div>
   <div className="statCard"><span>5m ENTRY</span><strong className="positive">{latestEntry?.entry_count??entryWorker?.last_entry_count??0}</strong><small className="neutral">final Scanner result</small></div>
  </div>

  <section className="panel" style={{padding:18,marginBottom:14}}>
   <div className="panelHead" style={{alignItems:"flex-start"}}>
    <div>
     <p className="eyebrow">Scanner Pipeline</p>
     <h2>1H → Top 30 → 15m Setup → 5m Entry</h2>
     <p className="muted" style={{marginTop:6}}>1H auto scan runs every hour. Manual Scan remains available; downstream 15m and 5m workers consume the latest upstream result.</p>
    </div>
    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
     <span className="periodTag">1H Runs {worker?.run_count??0}</span>
     <span className="periodTag">15m Runs {strategyWorker?.run_count??0}</span>
     <span className="periodTag">5m Runs {entryWorker?.run_count??0}</span>
     {worker?.rate_limited?<span className="periodTag">Retry in {duration(cooldown)}</span>:<span className="periodTag">Next 1H scan {duration(nextScan)}</span>}
     <button onClick={()=>void runNow()} disabled={scanning||worker?.rate_limited} style={manualRunStyle}>
      {worker?.rate_limited?"Cooldown":scanning?"Scanning…":"Run 1H Now"}
     </button>
     <button onClick={()=>void load()} style={controlStyle}>Refresh</button>
    </div>
   </div>

   <div style={pipelineWrap}>
    {stages.map((stage,index)=><button
     key={stage.title}
     onClick={()=>setSelectedStage(stage.title)}
     style={{...pipelineCard,...(stage.title===selectedStage?pipelineSelected:{})}}
    >
     <span className="eyebrow">Step {index+1}</span>
     <strong style={{display:"block",margin:"7px 0 5px",fontSize:12}}>{stage.title}</strong>
     <span className="muted" style={{fontSize:9}}>{stage.rule}</span>
     <div style={{display:"flex",gap:10,marginTop:10,fontSize:10}}>
      <span className="positive">Pass {stage.diag?.passed??"—"}</span>
      <span className="negative">Hold/Drop {stage.diag?.dropped??"—"}</span>
     </div>
    </button>)}
   </div>

   <div style={tracePanel}>
    <div style={{display:"flex",justifyContent:"space-between",gap:12,alignItems:"center",flexWrap:"wrap"}}>
     <div><strong>{active.title} diagnostics</strong><div className="muted" style={{fontSize:10,marginTop:4}}>{active.rule}</div></div>
     <span className="periodTag">Pass {active.diag?.passed??0} · Hold/Drop {active.diag?.dropped??0}</span>
    </div>
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:12}}>
     <div><div className="positive" style={labelStyle}>PASSED CONTRACTS</div><div style={symbolBox}>{passed.length?passed.join(" · "):"None"}</div></div>
     <div><div className="negative" style={labelStyle}>HOLD / DROPPED HERE</div><div style={symbolBox}>{dropped.length?dropped.join(" · "):"None"}</div></div>
    </div>
   </div>

   {worker?.rate_limited?<p className="muted" style={{marginBottom:0}}>Binance cooldown active · Scanner will retry automatically in {duration(cooldown)}.</p>:worker?.last_error&&<p className="negative" style={{marginBottom:0}}>1H Worker: {worker.last_error}</p>}
   {strategyWorker?.last_error&&<p className="negative" style={{marginBottom:0}}>15m Worker: {strategyWorker.last_error}</p>}
   {entryWorker?.last_error&&<p className="negative" style={{marginBottom:0}}>5m Worker: {entryWorker.last_error}</p>}
   {error&&<p className="negative" style={{marginBottom:0}}>{error}</p>}
  </section>

  <section className="panel" style={{overflow:"auto",marginBottom:14}}>
   <div className="panelHead compact">
    <div><h2>Current 1H Top 30</h2><p className="muted" style={{marginTop:5}}>{latest?(latest.candidate_count+" contracts · "+latest.processing_ms+" ms"):"No successful 1H scan yet"}</p></div>
    <span className="periodTag">{latest?(latest.long_candidates+" LONG · "+latest.short_candidates+" SHORT"):"Waiting"}</span>
   </div>
   <div style={{minWidth:1450}}>
    <div style={{...top30RowStyle,color:"#69768a",fontSize:9,textTransform:"uppercase"}}><span>Contract</span><span>Bias</span><span>Score</span><span>1H Structure</span><span>EMA20</span><span>EMA50</span><span>EMA200</span><span>RSI</span><span>RVOL</span><span>ATR%</span><span>OI Δ 1H</span><span>Spread</span><span>24h Quote Vol</span><span>Price</span><span>Reasons</span></div>
    {!latest?.candidates.length&&<div style={emptyStyle}>Waiting for a successful 1H Scanner run.</div>}
    {latest?.candidates.map(candidate=><div key={candidate.symbol+"-"+candidate.side} style={top30RowStyle}>
     <strong>{candidate.symbol}</strong>
     <strong className={candidate.side==="LONG"?"positive":"negative"}>{candidate.side}</strong>
     <strong>{candidate.score}</strong>
     <span>{candidate.structure_1h??"—"}</span>
     <span>{fmt(candidate.ema20_1h,6)}</span>
     <span>{fmt(candidate.ema50_1h,6)}</span>
     <span>{fmt(candidate.ema200_1h,6)}</span>
     <span>{fmt(candidate.rsi_1h,2)}</span>
     <span>{fmt(candidate.rvol_1h,2)}x</span>
     <span>{fmt(candidate.atr_pct_1h,2)}%</span>
     <span className={(candidate.oi_change_1h_pct??0)>=0?"positive":"negative"}>{fmt(candidate.oi_change_1h_pct,2)}%</span>
     <span>{fmt(candidate.spread_pct,4)}%</span>
     <span>{"$"}{fmt(candidate.quote_volume,0)}</span>
     <span>{fmt(candidate.last_price,6)}</span>
     <span title={candidate.reasons.join(" · ")}>{candidate.reasons.join(" · ")||"—"}</span>
    </div>)}
   </div>
  </section>

  <section className="panel" style={{overflow:"auto",marginBottom:14}}>
   <div className="panelHead compact">
    <div><h2>15m Setup</h2><p className="muted" style={{marginTop:5}}>Existing Strategy Engine · Top30 only · PASS / HOLD</p></div>
    <span className="periodTag">{latestStrategy?(latestStrategy.pass_count+" PASS · "+latestStrategy.hold_count+" HOLD"):"Waiting"}</span>
   </div>
   <div style={{minWidth:1040}}>
    <div style={{...strategyRowStyle,color:"#69768a",fontSize:9,textTransform:"uppercase"}}><span>Contract</span><span>Bias</span><span>Status</span><span>Score</span><span>RSI</span><span>MACD Hist</span><span>RVOL</span><span>ATR%</span><span>Reason</span></div>
    {!latestStrategy?.rows.length&&<div style={emptyStyle}>Waiting for 15m setup results.</div>}
    {latestStrategy?.rows.map((row,index)=>{
     const reason=(row.status==="PASS"?row.reasons:row.hold_reasons)?.join(" · ")??"";
     return <div key={row.symbol+"-"+index} style={strategyRowStyle}>
      <strong>{row.symbol}</strong>
      <span className={row.side==="LONG"?"positive":"negative"}>{row.side}</span>
      <strong className={row.status==="PASS"?"positive":"neutral"}>{row.status}</strong>
      <span>{row.score}</span>
      <span>{fmt(row.rsi_15m,2)}</span>
      <span>{fmt(row.macd_histogram_15m,6)}</span>
      <span>{fmt(row.rvol_15m,2)}x</span>
      <span>{fmt(row.atr_pct_15m,2)}%</span>
      <span title={reason}>{reason||"—"}</span>
     </div>;
    })}
   </div>
  </section>

  <section className="panel" style={{overflow:"auto"}}>
   <div className="panelHead compact">
    <div><h2>5m Entry Result</h2><p className="muted" style={{marginTop:5}}>Only 15m PASS symbols reach this final Scanner stage.</p></div>
    <span className="periodTag">{latestEntry?(latestEntry.entry_count+" ENTRY · "+latestEntry.hold_count+" HOLD"):"Waiting"}</span>
   </div>
   <div style={{minWidth:1280}}>
    <div style={{...entryRowStyle,color:"#69768a",fontSize:9,textTransform:"uppercase"}}><span>Contract</span><span>Bias</span><span>Status</span><span>Score</span><span>Price</span><span>EMA9</span><span>EMA20</span><span>EMA50</span><span>RSI</span><span>MACD Hist</span><span>RVOL</span><span>ATR%</span><span>Reason</span></div>
    {!latestEntry?.rows.length&&<div style={emptyStyle}>Waiting for 15m PASS symbols and a 5m Entry evaluation.</div>}
    {latestEntry?.rows.map((row,index)=>{
     const reason=(row.status==="ENTRY"?row.reasons:row.hold_reasons)?.join(" · ")??"";
     return <div key={row.symbol+"-"+index} style={entryRowStyle}>
      <strong>{row.symbol}</strong>
      <span className={row.side==="LONG"?"positive":"negative"}>{row.side}</span>
      <strong className={row.status==="ENTRY"?"positive":"neutral"}>{row.status}</strong>
      <span>{row.score}</span>
      <span>{fmt(row.close_5m,6)}</span>
      <span>{fmt(row.ema9_5m,6)}</span>
      <span>{fmt(row.ema20_5m,6)}</span>
      <span>{fmt(row.ema50_5m,6)}</span>
      <span>{fmt(row.rsi_5m,2)}</span>
      <span>{fmt(row.macd_histogram_5m,6)}</span>
      <span>{fmt(row.rvol_5m,2)}x</span>
      <span>{fmt(row.atr_pct_5m,2)}%</span>
      <span title={reason}>{reason||"—"}</span>
     </div>;
    })}
   </div>
  </section>
 </div>
}

const controlStyle={background:"#0b1118",color:"#dfe7f1",border:"1px solid #263242",borderRadius:7,padding:"8px 10px",cursor:"pointer"} as const;
const manualRunStyle={...controlStyle,background:"#173329",color:"#69e4b8",border:"1px solid #285845",fontWeight:700} as const;
const pipelineWrap={display:"grid",gridTemplateColumns:"repeat(6,minmax(180px,1fr))",gap:10,marginTop:18,overflowX:"auto",paddingBottom:4} as const;
const pipelineCard={textAlign:"left",border:"1px solid #1d2a39",borderRadius:10,padding:12,background:"#0a1018",color:"#e8edf6",cursor:"pointer",minWidth:180} as const;
const pipelineSelected={border:"1px solid #3b8068",background:"#102019"} as const;
const tracePanel={marginTop:12,border:"1px solid #1d2a39",borderRadius:10,padding:14,background:"#090f16"} as const;
const symbolBox={minHeight:54,maxHeight:120,overflow:"auto",border:"1px solid #192331",borderRadius:8,padding:10,color:"#9aa7ba",fontSize:10,lineHeight:1.7} as const;
const labelStyle={fontSize:10,fontWeight:700,marginBottom:7} as const;
const emptyStyle={padding:28,color:"#78859a",fontSize:12} as const;
const top30RowStyle={display:"grid",gridTemplateColumns:"100px 60px 55px 90px 85px 85px 85px 60px 65px 65px 75px 70px 120px 90px minmax(360px,1fr)",gap:9,padding:"10px 14px",borderBottom:"1px solid #171f2a",fontSize:10,alignItems:"center"} as const;
const strategyRowStyle={display:"grid",gridTemplateColumns:"100px 70px 70px 60px 70px 95px 70px 70px minmax(360px,1fr)",gap:10,padding:"9px 14px",borderBottom:"1px solid #171f2a",fontSize:10,alignItems:"center"} as const;
const entryRowStyle={display:"grid",gridTemplateColumns:"100px 70px 70px 60px 90px 85px 85px 85px 65px 95px 65px 65px minmax(360px,1fr)",gap:9,padding:"9px 14px",borderBottom:"1px solid #171f2a",fontSize:10,alignItems:"center"} as const;
