"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CandlePayload={open_time:number;open:string;high:string;low:string;close:string;volume:string;close_time:number};
type FuturesSymbol={symbol:string;status:string;quoteAsset:string;baseAsset:string;contractType:string};
type ExchangeInfo={symbols:FuturesSymbol[]};
type Ticker24h={symbol:string;quoteVolume:string};
type Candidate={symbol:string;timeframe:string;side:"LONG"|"SHORT";score:number;long_score:number;short_score:number;quote_volume:number;last_price:number;rsi_14:number;macd:number;macd_signal:number;volume_ratio:number;reasons:string[]};
type BackendStageDiag={passed:number;dropped:number;dropped_symbols:string[];passed_symbols?:string[]};
type PipelineDiag={backend_input?:BackendStageDiag;backend_safety?:BackendStageDiag;indicator_analysis?:BackendStageDiag;volume?:BackendStageDiag;direction?:BackendStageDiag;shortlist?:BackendStageDiag};
type ScannerRun={timestamp:string;status:string;timeframe:string;min_volume_ratio?:number;input_markets:number;prepared_markets?:number;evaluated_markets:number;candidate_count:number;long_candidates:number;short_candidates:number;processing_ms:number;pipeline?:PipelineDiag;candidates:Candidate[]};
type LogsResponse={engine:string;logs:ScannerRun[]};
type StageDiag={passed:number;dropped:number;dropped_symbols:string[];passed_symbols:string[]};
type FrontPipeline={uniqueBase:StageDiag;scanPool:StageDiag;liquidity:StageDiag;top30:StageDiag};
type PoolRow={symbol:string;baseAsset:string;quoteVolume:number};
type ValidationRow={timeframe:string;indicator:number;volume:number;direction:number;final:number;long:number;short:number;status:"running"|"done"|"error"};

const FUTURES_API="https://fapi.binance.com";
const HISTORY_LIMIT=500;
const MIN_QUOTE_VOLUME=10_000_000;
const SCAN_POOL_LIMIT=200;
const SCAN_LIMIT=30;
const AUTO_SCAN_SECONDS=60;
const VALIDATION_TFS=["5m","15m","1h"];
const VOLUME_THRESHOLDS=[1,1.1,1.2,1.3,1.5];
const ALLOWED_QUOTES=new Set(["USDT","USDC"]);
const STABLE_BASES=new Set(["USDT","USDC","FDUSD","TUSD","USDP","DAI","USD1","USDE","PYUSD","BUSD"]);
const TIMEFRAMES=["1m","5m","15m","1h","4h","1d"];

function candleRows(rows:(string|number)[][]):CandlePayload[]{return rows.map(r=>({open_time:Number(r[0]),open:String(r[1]),high:String(r[2]),low:String(r[3]),close:String(r[4]),volume:String(r[5]),close_time:Number(r[6])}))}
async function fetchCandles(symbol:string,timeframe:string){const r=await fetch(`${FUTURES_API}/fapi/v1/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(timeframe)}&limit=${HISTORY_LIMIT}`,{cache:"no-store"});if(!r.ok)throw new Error(`Unable to load futures candles for ${symbol}`);return candleRows(await r.json() as (string|number)[][])}
function fmt(v:number|undefined,d=2){return v===undefined||!Number.isFinite(v)?"—":v.toLocaleString(undefined,{maximumFractionDigits:d})}
function diag(previous:string[],passed:string[]):StageDiag{const keep=new Set(passed);const dropped=previous.filter(symbol=>!keep.has(symbol));return{passed:passed.length,dropped:dropped.length,dropped_symbols:dropped,passed_symbols:passed}}

export default function ScannerPage(){
 const[timeframe,setTimeframe]=useState("15m");
 const[minVolumeRatio,setMinVolumeRatio]=useState(1.2);
 const[logs,setLogs]=useState<ScannerRun[]>([]);
 const[scanning,setScanning]=useState(false);
 const[validating,setValidating]=useState(false);
 const[validationRows,setValidationRows]=useState<ValidationRow[]>([]);
 const[progress,setProgress]=useState("Idle");
 const[error,setError]=useState<string|null>(null);
 const[autoRun,setAutoRun]=useState(false);
 const[countdown,setCountdown]=useState(AUTO_SCAN_SECONDS);
 const[frontPipeline,setFrontPipeline]=useState<FrontPipeline|null>(null);
 const[selectedStage,setSelectedStage]=useState("Scan Pool");
 const runningRef=useRef(false);
 const latest=logs[0];

 const loadLogs=useCallback(async()=>{try{const r=await fetch("/api/scanner/logs",{cache:"no-store"});if(!r.ok)throw new Error("Unable to load scanner logs");setLogs((await r.json() as LogsResponse).logs)}catch(e){setError(e instanceof Error?e.message:"Unable to load scanner logs")}},[]);
 useEffect(()=>{void loadLogs()},[loadLogs]);

 const buildUniverse=useCallback(async()=>{
  const[er,tr]=await Promise.all([fetch(`${FUTURES_API}/fapi/v1/exchangeInfo`,{cache:"no-store"}),fetch(`${FUTURES_API}/fapi/v1/ticker/24hr`,{cache:"no-store"})]);
  if(!er.ok||!tr.ok)throw new Error("Unable to load Binance USD-M Futures universe");
  const exchange=await er.json() as ExchangeInfo;
  const tickers=await tr.json() as Ticker24h[];
  const tickerMap=new Map(tickers.map(t=>[t.symbol,Number(t.quoteVolume)]));
  const perpetualRows=exchange.symbols.filter(s=>s.status==="TRADING"&&s.contractType==="PERPETUAL"&&ALLOWED_QUOTES.has(s.quoteAsset)&&!STABLE_BASES.has(s.baseAsset));
  const bestByBase=new Map<string,PoolRow>();
  for(const s of perpetualRows){const q=tickerMap.get(s.symbol)??0;const current=bestByBase.get(s.baseAsset);if(!current||q>current.quoteVolume)bestByBase.set(s.baseAsset,{symbol:s.symbol,baseAsset:s.baseAsset,quoteVolume:q})}
  const uniqueRows=[...bestByBase.values()].sort((a,b)=>b.quoteVolume-a.quoteVolume);
  const uniqueSymbols=uniqueRows.map(x=>x.symbol);
  const scanPoolRows=uniqueRows.slice(0,SCAN_POOL_LIMIT);
  const scanPoolSymbols=scanPoolRows.map(x=>x.symbol);
  const liquidRows=scanPoolRows.filter(x=>x.quoteVolume>=MIN_QUOTE_VOLUME);
  const liquidSymbols=liquidRows.map(x=>x.symbol);
  const topRows=liquidRows.slice(0,SCAN_LIMIT);
  const topSymbols=topRows.map(x=>x.symbol);
  setFrontPipeline({
   uniqueBase:{passed:uniqueSymbols.length,dropped:0,dropped_symbols:[],passed_symbols:uniqueSymbols},
   scanPool:diag(uniqueSymbols,scanPoolSymbols),
   liquidity:diag(scanPoolSymbols,liquidSymbols),
   top30:diag(liquidSymbols,topSymbols),
  });
  return topRows;
 },[]);

 const scanTopRows=useCallback(async(topRows:PoolRow[],tf:string)=>{
  const markets:{symbol:string;quote_volume:number;candles:CandlePayload[]}[]=[];
  for(let i=0;i<topRows.length;i+=5){
   const batch=topRows.slice(i,i+5);
   setProgress(`${tf}: Futures indicator data ${Math.min(i+batch.length,topRows.length)}/${topRows.length}`);
   const results=await Promise.all(batch.map(async x=>{try{return{symbol:x.symbol,quote_volume:x.quoteVolume,candles:await fetchCandles(x.symbol,tf)}}catch{return{symbol:x.symbol,quote_volume:x.quoteVolume,candles:[] as CandlePayload[]}}}));
   markets.push(...results);
  }
  const r=await fetch(`/api/scanner/run?timeframe=${tf}&min_quote_volume=${MIN_QUOTE_VOLUME}&min_volume_ratio=${minVolumeRatio}`,{method:"POST",cache:"no-store",headers:{"content-type":"application/json"},body:JSON.stringify(markets)});
  if(!r.ok){const b=await r.json().catch(()=>({}));throw new Error(b.detail??`Scanner Engine failed for ${tf}`)}
  return await r.json() as ScannerRun;
 },[minVolumeRatio]);

 const runScanner=useCallback(async()=>{
  if(runningRef.current)return;
  runningRef.current=true;setScanning(true);setError(null);setProgress("Building Binance USD-M perpetual futures universe");
  try{const topRows=await buildUniverse();setProgress(`Futures Indicator Engine → ${minVolumeRatio.toFixed(1)}x volume filter`);await scanTopRows(topRows,timeframe);await loadLogs();setProgress("Futures scan complete");setCountdown(AUTO_SCAN_SECONDS)}
  catch(e){setError(e instanceof Error?e.message:"Futures Scanner failed");setProgress("Scan failed")}
  finally{setScanning(false);runningRef.current=false}
 },[timeframe,minVolumeRatio,loadLogs,buildUniverse,scanTopRows]);

 const runValidation=useCallback(async()=>{
  if(runningRef.current)return;
  runningRef.current=true;setScanning(true);setValidating(true);setAutoRun(false);setError(null);setValidationRows(VALIDATION_TFS.map(tf=>({timeframe:tf,indicator:0,volume:0,direction:0,final:0,long:0,short:0,status:"running"})));
  try{setProgress(`Building shared Futures Top-30 · volume gate ${minVolumeRatio.toFixed(1)}x`);const topRows=await buildUniverse();for(const tf of VALIDATION_TFS){setProgress(`Validating Futures ${tf} at ${minVolumeRatio.toFixed(1)}x`);try{const result=await scanTopRows(topRows,tf);setValidationRows(rows=>rows.map(row=>row.timeframe===tf?{timeframe:tf,indicator:result.pipeline?.indicator_analysis?.passed??0,volume:result.pipeline?.volume?.passed??0,direction:result.pipeline?.direction?.passed??0,final:result.candidate_count,long:result.long_candidates,short:result.short_candidates,status:"done"}:row))}catch{setValidationRows(rows=>rows.map(row=>row.timeframe===tf?{...row,status:"error"}:row))}}await loadLogs();setProgress("Futures 3-timeframe validation complete")}
  catch(e){setError(e instanceof Error?e.message:"Validation failed");setProgress("Validation failed")}
  finally{setValidating(false);setScanning(false);runningRef.current=false}
 },[minVolumeRatio,buildUniverse,scanTopRows,loadLogs]);

 useEffect(()=>{if(!autoRun){setCountdown(AUTO_SCAN_SECONDS);return}const id=window.setInterval(()=>setCountdown(v=>{if(v<=1){void runScanner();return AUTO_SCAN_SECONDS}return v-1}),1000);return()=>window.clearInterval(id)},[autoRun,runScanner]);

 const stages=useMemo(()=>{
  const p=latest?.pipeline;
  const topSymbols=frontPipeline?.top30.passed_symbols??[];
  const indicatorPassed=p?.indicator_analysis?.passed_symbols??[];
  const indicatorDiag:StageDiag|null=p?.indicator_analysis?diag(topSymbols,indicatorPassed):null;
  const volumePassed=p?.volume?.passed_symbols??[];
  const volumeDiag:StageDiag|null=p?.volume&&indicatorDiag?diag(indicatorPassed,volumePassed):null;
  const directionPassed=p?.direction?.passed_symbols??[];
  const directionDiag:StageDiag|null=p?.direction&&volumeDiag?diag(volumePassed,directionPassed):null;
  const shortlistPassed=p?.shortlist?.passed_symbols??latest?.candidates.map(c=>c.symbol)??[];
  const shortlistDiag:StageDiag|null=p?.shortlist&&directionDiag?diag(directionPassed,shortlistPassed):null;
  return[
   {title:"Unique Futures",rule:"USD-M perpetual · highest-volume contract per base",diag:frontPipeline?.uniqueBase??null},
   {title:"Scan Pool",rule:"Top 200 unique perpetual futures",diag:frontPipeline?.scanPool??null},
   {title:"Liquidity",rule:"24h futures quote volume ≥ $10M",diag:frontPipeline?.liquidity??null},
   {title:"Top 30",rule:"Top 30 liquid perpetual contracts",diag:frontPipeline?.top30??null},
   {title:"Indicator Analysis",rule:"Futures closed candles · EMA/RSI/MACD/volume",diag:indicatorDiag},
   {title:"Volume Filter",rule:`Latest closed volume ≥ ${minVolumeRatio.toFixed(1)}x previous 20 avg`,diag:volumeDiag},
   {title:"Direction Filter",rule:"RSI + MACD + LONG/SHORT alignment",diag:directionDiag},
   {title:"Final Shortlist",rule:"Executable Futures LONG/SHORT candidates",diag:shortlistDiag},
  ];
 },[latest,frontPipeline,minVolumeRatio]);

 const activeStage=stages.find(s=>s.title===selectedStage)??stages[0];
 const dropped=activeStage.diag?.dropped_symbols??[];
 const passedSymbols=activeStage.diag?.passed_symbols??[];

 return <div className="pageWrap">
  <div className="pageHeader"><div><p className="eyebrow">Binance USD-M Futures</p><h1>Scanner</h1><p className="muted">Perpetual futures only → max 200 unique contracts → top 30 → Indicator Engine → Volume → Direction → Final LONG/SHORT shortlist.</p></div><span className="modePill"><span />{validating?"Validating Futures 5m · 15m · 1h":scanning?"Futures scanner running":autoRun?"Auto scan active":"Futures scanner ready"}</span></div>
  <div className="statGrid"><div className="statCard"><span>Last Scan</span><strong>{latest?new Date(latest.timestamp).toLocaleTimeString():"—"}</strong><small className="neutral">{latest?.timeframe??timeframe} futures timeframe</small></div><div className="statCard"><span>Futures Scan Pool</span><strong>{frontPipeline?.scanPool.passed??0}</strong><small className="neutral">max 200 perpetual contracts</small></div><div className="statCard"><span>LONG</span><strong className="positive">{latest?.long_candidates??0}</strong><small className="neutral">futures long opportunities</small></div><div className="statCard"><span>SHORT</span><strong className="negative">{latest?.short_candidates??0}</strong><small className="neutral">futures short opportunities</small></div></div>
  <section className="panel" style={{padding:18,marginBottom:14}}><div className="panelHead" style={{alignItems:"flex-start"}}><div><p className="eyebrow">Futures Scanner Pipeline</p><h2>USD-M Perpetual Funnel</h2><p className="muted" style={{marginTop:6}}>{progress}</p></div><div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",justifyContent:"flex-end"}}><select value={timeframe} onChange={e=>setTimeframe(e.target.value)} disabled={scanning} style={controlStyle}>{TIMEFRAMES.map(tf=><option key={tf}>{tf}</option>)}</select><select value={minVolumeRatio} onChange={e=>setMinVolumeRatio(Number(e.target.value))} disabled={scanning} style={controlStyle}>{VOLUME_THRESHOLDS.map(v=><option key={v} value={v}>Vol ≥ {v.toFixed(1)}x</option>)}</select><button onClick={()=>void runScanner()} disabled={scanning} style={runStyle}>{scanning&&!validating?"Scanning…":"Run Now"}</button><button onClick={()=>void runValidation()} disabled={scanning} style={validateStyle}>{validating?"Validating…":"Validate 5m · 15m · 1h"}</button><button onClick={()=>{setAutoRun(v=>!v);setCountdown(AUTO_SCAN_SECONDS)}} disabled={scanning} style={autoRun?autoOnStyle:controlStyle}>{autoRun?"Auto Run ON":"Auto Run OFF"}</button><span className="periodTag">Next scan {autoRun?`${countdown}s`:"—"}</span></div></div>
   <div style={pipelineWrap}>{stages.map((s,i)=><button key={s.title} onClick={()=>setSelectedStage(s.title)} style={{...pipelineCard,...(s.title===selectedStage?pipelineSelected:{})}}><span className="eyebrow">Step {i+1}</span><strong style={{display:"block",margin:"7px 0 5px",fontSize:12}}>{s.title}</strong><span className="muted" style={{fontSize:9}}>{s.rule}</span><div style={{display:"flex",gap:10,marginTop:10,fontSize:10}}><span className="positive">Pass {s.diag?.passed??"—"}</span><span className="negative">Drop {s.diag?.dropped??"—"}</span></div></button>)}</div>
   <div style={tracePanel}><div style={{display:"flex",justifyContent:"space-between",gap:12,alignItems:"center",flexWrap:"wrap"}}><div><strong>{activeStage.title} diagnostics</strong><div className="muted" style={{fontSize:10,marginTop:4}}>{activeStage.rule}</div></div><span className="periodTag">Pass {activeStage.diag?.passed??0} · Drop {activeStage.diag?.dropped??0}</span></div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:12}}><div><div className="positive" style={{fontSize:10,fontWeight:700,marginBottom:7}}>PASSED CONTRACTS</div><div style={symbolBox}>{passedSymbols.length?passedSymbols.join(" · "):"None"}</div></div><div><div className="negative" style={{fontSize:10,fontWeight:700,marginBottom:7}}>DROPPED / STUCK HERE</div><div style={symbolBox}>{dropped.length?dropped.join(" · "):"None"}</div></div></div></div>{error&&<p className="negative" style={{marginBottom:0}}>{error}</p>}</section>
  {validationRows.length>0&&<section className="panel" style={{padding:16,marginBottom:14}}><div className="panelHead compact"><div><h2>Futures 3-Timeframe Validation</h2><p className="muted" style={{marginTop:5}}>Same USD-M Futures Top-30 universe · volume gate {minVolumeRatio.toFixed(1)}x.</p></div><span className="periodTag">{validating?"Running":"Complete"}</span></div><div style={validationGrid}>{validationRows.map(v=><div key={v.timeframe} style={validationCard}><div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}><strong style={{fontSize:16}}>{v.timeframe}</strong><span className="periodTag">{v.status}</span></div><div style={validationMetrics}><span>Indicator <b>{v.indicator}</b></span><span>Volume <b>{v.volume}</b></span><span>Direction <b>{v.direction}</b></span><span>Final <b>{v.final}</b></span></div><div style={{display:"flex",gap:14,marginTop:10,fontSize:11}}><span className="positive">LONG {v.long}</span><span className="negative">SHORT {v.short}</span></div></div>)}</div></section>}
  <section className="panel" style={{overflow:"auto"}}><div className="panelHead compact"><div><h2>Last Futures Scan Result</h2><p className="muted" style={{marginTop:5}}>{latest?`${latest.candidate_count} candidates · ${latest.processing_ms} ms backend · vol ≥ ${(latest.min_volume_ratio??minVolumeRatio).toFixed(1)}x`:"No futures scan yet"}</p></div><span className="periodTag">{latest?`${latest.long_candidates} LONG · ${latest.short_candidates} SHORT`:"Waiting"}</span></div><div style={{minWidth:1250}}><div style={{...rowStyle,color:"#69768a",fontSize:9,textTransform:"uppercase"}}><span>Contract</span><span>TF</span><span>Side</span><span>Score</span><span>L/S</span><span>24h Quote Vol</span><span>Price</span><span>RSI</span><span>Vol Ratio</span><span>Reasons</span></div>{!latest&&<div style={{padding:28,color:"#78859a",fontSize:12}}>Run Futures Scanner to populate the latest result.</div>}{latest?.candidates.map(r=><div key={`${r.symbol}-${r.side}`} style={rowStyle}><strong>{r.symbol}</strong><span>{r.timeframe}</span><strong className={r.side==="LONG"?"positive":"negative"}>{r.side}</strong><strong>{r.score}</strong><span>{r.long_score}/{r.short_score}</span><span>${fmt(r.quote_volume,0)}</span><span>{fmt(r.last_price,6)}</span><span>{fmt(r.rsi_14,2)}</span><span>{fmt(r.volume_ratio,2)}x</span><span title={r.reasons.join(" · ")}>{r.reasons.join(" · ")||"—"}</span></div>)}</div></section>
 </div>
}

const controlStyle={background:"#0b1118",color:"#dfe7f1",border:"1px solid #263242",borderRadius:7,padding:"8px 10px",cursor:"pointer"} as const;
const runStyle={...controlStyle,background:"#173329",color:"#69e4b8",border:"1px solid #285845",fontWeight:700} as const;
const validateStyle={...controlStyle,background:"#1a2338",color:"#9fc4ff",border:"1px solid #31496f",fontWeight:700} as const;
const autoOnStyle={...controlStyle,background:"#182d3c",color:"#77c8ff",border:"1px solid #29506a",fontWeight:700} as const;
const pipelineWrap={display:"grid",gridTemplateColumns:"repeat(8,minmax(125px,1fr))",gap:10,marginTop:18,overflowX:"auto",paddingBottom:4} as const;
const pipelineCard={textAlign:"left",border:"1px solid #1d2a39",borderRadius:10,padding:12,background:"#0a1018",color:"#e8edf6",cursor:"pointer",minWidth:125} as const;
const pipelineSelected={border:"1px solid #3b8068",background:"#102019"} as const;
const tracePanel={marginTop:12,border:"1px solid #1d2a39",borderRadius:10,padding:14,background:"#090f16"} as const;
const symbolBox={minHeight:54,maxHeight:120,overflow:"auto",border:"1px solid #192331",borderRadius:8,padding:10,color:"#9aa7ba",fontSize:10,lineHeight:1.7} as const;
const validationGrid={display:"grid",gridTemplateColumns:"repeat(3,minmax(0,1fr))",gap:12,marginTop:12} as const;
const validationCard={border:"1px solid #1d2a39",borderRadius:10,padding:14,background:"#0a1018"} as const;
const validationMetrics={display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:8,marginTop:12,fontSize:10,color:"#8794a8"} as const;
const rowStyle={display:"grid",gridTemplateColumns:"105px 45px 65px 55px 65px 125px 100px 65px 75px minmax(380px,1fr)",gap:10,padding:"10px 14px",borderBottom:"1px solid #171f2a",fontSize:10,alignItems:"center"} as const;