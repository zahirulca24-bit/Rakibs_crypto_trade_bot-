"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

type CandlePayload={open_time:number;open:string;high:string;low:string;close:string;volume:string;close_time:number};
type BinanceSymbol={symbol:string;status:string;quoteAsset:string;baseAsset:string;isSpotTradingAllowed?:boolean};
type ExchangeInfo={symbols:BinanceSymbol[]};
type Ticker24h={symbol:string;quoteVolume:string};
type Candidate={symbol:string;timeframe:string;side:"LONG"|"SHORT";score:number;long_score:number;short_score:number;quote_volume:number;last_price:number;rsi_14:number;macd:number;macd_signal:number;volume_ratio:number;reasons:string[]};
type StageDiag={passed:number;dropped:number;dropped_symbols:string[];passed_symbols:string[]};
type BackendStageDiag={passed:number;dropped:number;dropped_symbols:string[];passed_symbols?:string[]};
type PipelineDiag={backend_input?:BackendStageDiag;backend_safety?:BackendStageDiag;indicator_analysis?:BackendStageDiag;volume?:BackendStageDiag;direction?:BackendStageDiag;shortlist?:BackendStageDiag};
type ScannerRun={timestamp:string;status:string;timeframe:string;input_markets:number;prepared_markets?:number;evaluated_markets:number;candidate_count:number;long_candidates:number;short_candidates:number;processing_ms:number;pipeline?:PipelineDiag;candidates:Candidate[]};
type LogsResponse={engine:string;logs:ScannerRun[]};
type FrontPipeline={fullUniverse:StageDiag;activeSpot:StageDiag;allowedQuote:StageDiag;stableBase:StageDiag;uniqueBase:StageDiag;liquidity:StageDiag;top30:StageDiag};

const MARKET_API="https://data-api.binance.vision";
const HISTORY_LIMIT=500;
const MIN_QUOTE_VOLUME=10_000_000;
const SCAN_LIMIT=30;
const AUTO_SCAN_SECONDS=60;
const ALLOWED_QUOTES=new Set(["USDT","USDC","FDUSD"]);
const STABLE_BASES=new Set(["USDT","USDC","FDUSD","TUSD","USDP","DAI","USD1","USDE","PYUSD","BUSD"]);
const TIMEFRAMES=["1m","5m","15m","1h","4h","1d"];

function candleRows(rows:(string|number)[][]):CandlePayload[]{return rows.map(r=>({open_time:Number(r[0]),open:String(r[1]),high:String(r[2]),low:String(r[3]),close:String(r[4]),volume:String(r[5]),close_time:Number(r[6])}))}
async function fetchCandles(symbol:string,timeframe:string){const r=await fetch(`${MARKET_API}/api/v3/klines?symbol=${encodeURIComponent(symbol)}&interval=${encodeURIComponent(timeframe)}&limit=${HISTORY_LIMIT}`,{cache:"no-store"});if(!r.ok)throw new Error(`Unable to load candles for ${symbol}`);return candleRows(await r.json() as (string|number)[][])}
function fmt(v:number|undefined,d=2){return v===undefined||!Number.isFinite(v)?"—":v.toLocaleString(undefined,{maximumFractionDigits:d})}
function diag(previous:string[],passed:string[]):StageDiag{const keep=new Set(passed);const dropped=previous.filter(symbol=>!keep.has(symbol));return{passed:passed.length,dropped:dropped.length,dropped_symbols:dropped,passed_symbols:passed}}

export default function ScannerPage(){
 const[timeframe,setTimeframe]=useState("15m");
 const[logs,setLogs]=useState<ScannerRun[]>([]);
 const[scanning,setScanning]=useState(false);
 const[progress,setProgress]=useState("Idle");
 const[error,setError]=useState<string|null>(null);
 const[autoRun,setAutoRun]=useState(false);
 const[countdown,setCountdown]=useState(AUTO_SCAN_SECONDS);
 const[frontPipeline,setFrontPipeline]=useState<FrontPipeline|null>(null);
 const[selectedStage,setSelectedStage]=useState("Full Universe");
 const runningRef=useRef(false);
 const latest=logs[0];

 const loadLogs=useCallback(async()=>{try{const r=await fetch("/api/scanner/logs",{cache:"no-store"});if(!r.ok)throw new Error("Unable to load scanner logs");setLogs((await r.json() as LogsResponse).logs)}catch(e){setError(e instanceof Error?e.message:"Unable to load scanner logs")}},[]);
 useEffect(()=>{void loadLogs()},[loadLogs]);

 const runScanner=useCallback(async()=>{
  if(runningRef.current)return;
  runningRef.current=true;setScanning(true);setError(null);setProgress("Loading full Binance universe");
  try{
   const[er,tr]=await Promise.all([fetch(`${MARKET_API}/api/v3/exchangeInfo`,{cache:"no-store"}),fetch(`${MARKET_API}/api/v3/ticker/24hr`,{cache:"no-store"})]);
   if(!er.ok||!tr.ok)throw new Error("Unable to load Binance scanner universe");
   const exchange=await er.json() as ExchangeInfo;
   const tickers=await tr.json() as Ticker24h[];
   const tickerMap=new Map(tickers.map(t=>[t.symbol,Number(t.quoteVolume)]));

   const fullSymbols=exchange.symbols.map(s=>s.symbol);
   const activeRows=exchange.symbols.filter(s=>s.status==="TRADING"&&s.isSpotTradingAllowed!==false);
   const activeSymbols=activeRows.map(s=>s.symbol);
   const allowedRows=activeRows.filter(s=>ALLOWED_QUOTES.has(s.quoteAsset));
   const allowedSymbols=allowedRows.map(s=>s.symbol);
   const nonStableRows=allowedRows.filter(s=>!STABLE_BASES.has(s.baseAsset));
   const nonStableSymbols=nonStableRows.map(s=>s.symbol);

   const bestByBase=new Map<string,{symbol:string;baseAsset:string;quoteVolume:number}>();
   for(const s of nonStableRows){const q=tickerMap.get(s.symbol)??0;const current=bestByBase.get(s.baseAsset);if(!current||q>current.quoteVolume)bestByBase.set(s.baseAsset,{symbol:s.symbol,baseAsset:s.baseAsset,quoteVolume:q})}
   const uniqueRows=[...bestByBase.values()].sort((a,b)=>b.quoteVolume-a.quoteVolume);
   const uniqueSymbols=uniqueRows.map(x=>x.symbol);
   const liquidRows=uniqueRows.filter(x=>x.quoteVolume>=MIN_QUOTE_VOLUME);
   const liquidSymbols=liquidRows.map(x=>x.symbol);
   const topRows=liquidRows.slice(0,SCAN_LIMIT);
   const topSymbols=topRows.map(x=>x.symbol);

   setFrontPipeline({
    fullUniverse:{passed:fullSymbols.length,dropped:0,dropped_symbols:[],passed_symbols:fullSymbols},
    activeSpot:diag(fullSymbols,activeSymbols),allowedQuote:diag(activeSymbols,allowedSymbols),stableBase:diag(allowedSymbols,nonStableSymbols),
    uniqueBase:diag(nonStableSymbols,uniqueSymbols),liquidity:diag(uniqueSymbols,liquidSymbols),top30:diag(liquidSymbols,topSymbols),
   });

   const markets:{symbol:string;quote_volume:number;candles:CandlePayload[]}[]=[];
   for(let i=0;i<topRows.length;i+=5){const batch=topRows.slice(i,i+5);setProgress(`Loading candles for Indicator Engine ${Math.min(i+batch.length,topRows.length)}/${topRows.length}`);const results=await Promise.all(batch.map(async x=>{try{return{symbol:x.symbol,quote_volume:x.quoteVolume,candles:await fetchCandles(x.symbol,timeframe)}}catch{return{symbol:x.symbol,quote_volume:x.quoteVolume,candles:[] as CandlePayload[]}}}));markets.push(...results)}

   setProgress("Indicator Engine → Scanner shortlist");
   const r=await fetch(`/api/scanner/run?timeframe=${timeframe}&min_quote_volume=${MIN_QUOTE_VOLUME}`,{method:"POST",cache:"no-store",headers:{"content-type":"application/json"},body:JSON.stringify(markets)});
   if(!r.ok){const b=await r.json().catch(()=>({}));throw new Error(b.detail??"Scanner Engine failed")}
   await loadLogs();setProgress("Scan complete");setCountdown(AUTO_SCAN_SECONDS);
  }catch(e){setError(e instanceof Error?e.message:"Scanner Engine failed");setProgress("Scan failed")}
  finally{setScanning(false);runningRef.current=false}
 },[timeframe,loadLogs]);

 useEffect(()=>{if(!autoRun){setCountdown(AUTO_SCAN_SECONDS);return}const id=window.setInterval(()=>setCountdown(v=>{if(v<=1){void runScanner();return AUTO_SCAN_SECONDS}return v-1}),1000);return()=>window.clearInterval(id)},[autoRun,runScanner]);

 const stages=useMemo(()=>{
  const p=latest?.pipeline;
  const topSymbols=frontPipeline?.top30.passed_symbols??[];
  const indicatorPassed=p?.indicator_analysis?.passed_symbols??[];
  const indicatorDiag:StageDiag|null=p?.indicator_analysis?diag(topSymbols,indicatorPassed):null;
  const shortlistSymbols=latest?.candidates.map(c=>c.symbol)??[];
  const scannerDropped=Array.from(new Set([...(p?.volume?.dropped_symbols??[]),...(p?.direction?.dropped_symbols??[])]));
  const scannerDiag:StageDiag|null=indicatorDiag&&latest?{passed:shortlistSymbols.length,dropped:Math.max(0,indicatorDiag.passed-shortlistSymbols.length),dropped_symbols:scannerDropped,passed_symbols:shortlistSymbols}:null;

  return[
   {title:"Full Universe",rule:"All Binance symbols",diag:frontPipeline?.fullUniverse??null},
   {title:"Active Spot",rule:"Trading + Spot enabled",diag:frontPipeline?.activeSpot??null},
   {title:"Allowed Quote",rule:"USDT / USDC / FDUSD",diag:frontPipeline?.allowedQuote??null},
   {title:"No Stable Base",rule:"Remove stablecoin base assets",diag:frontPipeline?.stableBase??null},
   {title:"Unique Asset",rule:"Highest-volume pair per base",diag:frontPipeline?.uniqueBase??null},
   {title:"Liquidity",rule:"24h quote volume ≥ $10M",diag:frontPipeline?.liquidity??null},
   {title:"Top 30",rule:"Top 30 unique liquid assets",diag:frontPipeline?.top30??null},
   {title:"Indicator Analysis",rule:"Indicator Engine · closed candles · EMA/RSI/MACD/volume",diag:indicatorDiag},
   {title:"Scanner Shortlist",rule:"Volume + direction + score filters",diag:scannerDiag},
  ];
 },[latest,frontPipeline]);

 const activeStage=stages.find(s=>s.title===selectedStage)??stages[0];const dropped=activeStage.diag?.dropped_symbols??[];const passedSymbols=activeStage.diag?.passed_symbols??[];

 return <div className="pageWrap">
  <div className="pageHeader"><div><p className="eyebrow">Market Intelligence</p><h1>Scanner</h1><p className="muted">Full-universe funnel → top 30 unique assets → Indicator Engine → Scanner shortlist.</p></div><span className="modePill"><span />{scanning?"Scanner running":autoRun?"Auto scan active":"Scanner ready"}</span></div>
  <div className="statGrid"><div className="statCard"><span>Last Scan</span><strong>{latest?new Date(latest.timestamp).toLocaleTimeString():"—"}</strong><small className="neutral">{latest?.timeframe??timeframe} timeframe</small></div><div className="statCard"><span>Top Universe</span><strong>{frontPipeline?.top30.passed??0}</strong><small className="neutral">max 30 unique assets</small></div><div className="statCard"><span>LONG</span><strong className="positive">{latest?.long_candidates??0}</strong><small className="neutral">bullish opportunities</small></div><div className="statCard"><span>SHORT</span><strong className="negative">{latest?.short_candidates??0}</strong><small className="neutral">bearish opportunities</small></div></div>
  <section className="panel" style={{padding:18,marginBottom:14}}><div className="panelHead" style={{alignItems:"flex-start"}}><div><p className="eyebrow">Scanner Pipeline</p><h2>Full Funnel Trace</h2><p className="muted" style={{marginTop:6}}>{progress}</p></div><div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",justifyContent:"flex-end"}}><select value={timeframe} onChange={e=>setTimeframe(e.target.value)} disabled={scanning} style={controlStyle}>{TIMEFRAMES.map(tf=><option key={tf}>{tf}</option>)}</select><button onClick={()=>void runScanner()} disabled={scanning} style={runStyle}>{scanning?"Scanning…":"Run Now"}</button><button onClick={()=>{setAutoRun(v=>!v);setCountdown(AUTO_SCAN_SECONDS)}} style={autoRun?autoOnStyle:controlStyle}>{autoRun?"Auto Run ON":"Auto Run OFF"}</button><span className="periodTag">Next scan {autoRun?`${countdown}s`:"—"}</span></div></div>
   <div style={pipelineWrap}>{stages.map((s,i)=><button key={s.title} onClick={()=>setSelectedStage(s.title)} style={{...pipelineCard,...(s.title===selectedStage?pipelineSelected:{})}}><span className="eyebrow">Step {i+1}</span><strong style={{display:"block",margin:"7px 0 5px",fontSize:12}}>{s.title}</strong><span className="muted" style={{fontSize:9}}>{s.rule}</span><div style={{display:"flex",gap:10,marginTop:10,fontSize:10}}><span className="positive">Pass {s.diag?.passed??"—"}</span><span className="negative">Drop {s.diag?.dropped??"—"}</span></div></button>)}</div>
   <div style={tracePanel}><div style={{display:"flex",justifyContent:"space-between",gap:12,alignItems:"center",flexWrap:"wrap"}}><div><strong>{activeStage.title} diagnostics</strong><div className="muted" style={{fontSize:10,marginTop:4}}>{activeStage.rule}</div></div><span className="periodTag">Pass {activeStage.diag?.passed??0} · Drop {activeStage.diag?.dropped??0}</span></div><div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginTop:12}}><div><div className="positive" style={{fontSize:10,fontWeight:700,marginBottom:7}}>PASSED SYMBOLS</div><div style={symbolBox}>{passedSymbols.length?passedSymbols.join(" · "):"None"}</div></div><div><div className="negative" style={{fontSize:10,fontWeight:700,marginBottom:7}}>DROPPED / STUCK HERE</div><div style={symbolBox}>{dropped.length?dropped.join(" · "):"None"}</div></div></div></div>{error&&<p className="negative" style={{marginBottom:0}}>{error}</p>}</section>
  <section className="panel" style={{overflow:"auto"}}><div className="panelHead compact"><div><h2>Last Scan Result</h2><p className="muted" style={{marginTop:5}}>{latest?`${latest.candidate_count} candidates · ${latest.processing_ms} ms backend processing`:"No scanner run yet"}</p></div><span className="periodTag">{latest?`${latest.long_candidates} LONG · ${latest.short_candidates} SHORT`:"Waiting"}</span></div><div style={{minWidth:1250}}><div style={{...rowStyle,color:"#69768a",fontSize:9,textTransform:"uppercase"}}><span>Symbol</span><span>TF</span><span>Side</span><span>Score</span><span>L/S</span><span>24h Quote Vol</span><span>Price</span><span>RSI</span><span>Vol Ratio</span><span>Reasons</span></div>{!latest&&<div style={{padding:28,color:"#78859a",fontSize:12}}>Run Scanner to populate the latest result.</div>}{latest?.candidates.map(r=><div key={`${r.symbol}-${r.side}`} style={rowStyle}><strong>{r.symbol}</strong><span>{r.timeframe}</span><strong className={r.side==="LONG"?"positive":"negative"}>{r.side}</strong><strong>{r.score}</strong><span>{r.long_score}/{r.short_score}</span><span>${fmt(r.quote_volume,0)}</span><span>{fmt(r.last_price,6)}</span><span>{fmt(r.rsi_14,2)}</span><span>{fmt(r.volume_ratio,2)}x</span><span title={r.reasons.join(" · ")}>{r.reasons.join(" · ")||"—"}</span></div>)}</div></section>
 </div>
}

const controlStyle={background:"#0b1118",color:"#dfe7f1",border:"1px solid #263242",borderRadius:7,padding:"8px 10px",cursor:"pointer"} as const;
const runStyle={...controlStyle,background:"#173329",color:"#69e4b8",border:"1px solid #285845",fontWeight:700} as const;
const autoOnStyle={...controlStyle,background:"#182d3c",color:"#77c8ff",border:"1px solid #29506a",fontWeight:700} as const;
const pipelineWrap={display:"grid",gridTemplateColumns:"repeat(9,minmax(125px,1fr))",gap:10,marginTop:18,overflowX:"auto",paddingBottom:4} as const;
const pipelineCard={textAlign:"left",border:"1px solid #1d2a39",borderRadius:10,padding:12,background:"#0a1018",color:"#e8edf6",cursor:"pointer",minWidth:125} as const;
const pipelineSelected={border:"1px solid #3b8068",background:"#102019"} as const;
const tracePanel={marginTop:12,border:"1px solid #1d2a39",borderRadius:10,padding:14,background:"#090f16"} as const;
const symbolBox={minHeight:54,maxHeight:120,overflow:"auto",border:"1px solid #192331",borderRadius:8,padding:10,color:"#9aa7ba",fontSize:10,lineHeight:1.7} as const;
const rowStyle={display:"grid",gridTemplateColumns:"105px 45px 65px 55px 65px 125px 100px 65px 75px minmax(380px,1fr)",gap:10,padding:"10px 14px",borderBottom:"1px solid #171f2a",fontSize:10,alignItems:"center"} as const;
