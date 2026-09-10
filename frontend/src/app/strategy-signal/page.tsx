"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Candidate={
  symbol:string;side:"LONG"|"SHORT";score:number;quote_volume:number;last_price:number;
  structure_1h?:string;rsi_1h?:number;rvol_1h?:number;atr_pct_1h?:number;
  oi_change_1h_pct?:number;spread_pct?:number;reasons:string[];
};
type ScannerRun={timestamp:string;candidate_count:number;long_candidates:number;short_candidates:number;candidates:Candidate[]};
type ScannerLogsResponse={engine:string;logs:ScannerRun[]};
type ScannerWorkerStatus={running:boolean;last_top30:number;last_layer?:string;run_count:number};

type StrategyRow={
  symbol:string;side:"LONG"|"SHORT";status:"PASS"|"HOLD";score:number;scanner_score?:number;
  close_15m?:number;ema20_15m?:number;ema50_15m?:number;rsi_15m?:number;
  macd_histogram_15m?:number;rvol_15m?:number;atr_pct_15m?:number;
  reasons:string[];hold_reasons:string[];
};
type StrategyRun={
  timestamp:string;scanner_timestamp:string;input_count:number;pass_count:number;hold_count:number;
  long_pass:number;short_pass:number;processing_ms:number;rows:StrategyRow[];
};
type StrategyLogsResponse={engine:string;logs:StrategyRun[]};
type StrategyWorkerStatus={
  running:boolean;last_layer?:string;run_count:number;last_input_count:number;last_pass_count:number;
  last_hold_count:number;last_long_pass:number;last_short_pass:number;last_error?:string|null;
  waiting_for_scanner_cooldown?:boolean;scanner_retry_in_seconds?:number;
};

export default function StrategySignalPage(){
  const[scannerLogs,setScannerLogs]=useState<ScannerRun[]>([]);
  const[scannerWorker,setScannerWorker]=useState<ScannerWorkerStatus|null>(null);
  const[strategyLogs,setStrategyLogs]=useState<StrategyRun[]>([]);
  const[strategyWorker,setStrategyWorker]=useState<StrategyWorkerStatus|null>(null);
  const[error,setError]=useState<string|null>(null);

  const load=useCallback(async()=>{
    try{
      const[slr,swr,tlr,twr]=await Promise.all([
        fetch("/api/scanner/logs",{cache:"no-store"}),
        fetch("/api/scanner/worker/status",{cache:"no-store"}),
        fetch("/api/strategy/logs",{cache:"no-store"}),
        fetch("/api/strategy/worker/status",{cache:"no-store"})
      ]);
      if(!slr.ok||!swr.ok||!tlr.ok||!twr.ok)throw new Error("Unable to load Strategy & Signal state");

      const fresh=(await slr.json() as ScannerLogsResponse).logs??[];
      if(fresh.length){
        setScannerLogs(fresh);
        window.localStorage.setItem("rakib-scanner-latest",JSON.stringify(fresh[0]));
      }else{
        const cached=window.localStorage.getItem("rakib-scanner-latest");
        if(cached){try{setScannerLogs([JSON.parse(cached) as ScannerRun])}catch{setScannerLogs([])}}else setScannerLogs([]);
      }

      setScannerWorker(await swr.json() as ScannerWorkerStatus);
      setStrategyLogs((await tlr.json() as StrategyLogsResponse).logs??[]);
      setStrategyWorker(await twr.json() as StrategyWorkerStatus);
      setError(null);
    }catch(e){
      setError(e instanceof Error?e.message:"Unable to load Strategy & Signal state");
    }
  },[]);

  useEffect(()=>{
    const cached=window.localStorage.getItem("rakib-scanner-latest");
    if(cached){try{setScannerLogs([JSON.parse(cached) as ScannerRun])}catch{}}
    void load();
    const id=window.setInterval(()=>void load(),15000);
    return()=>window.clearInterval(id);
  },[load]);

  const latestScanner=scannerLogs[0];
  const top30=useMemo(()=>latestScanner?.candidates??[],[latestScanner]);
  const latestStrategy=strategyLogs[0];
  const strategyBySymbol=useMemo(()=>new Map((latestStrategy?.rows??[]).map(row=>[row.symbol,row])),[latestStrategy]);

  return <div className="pageWrap">
    <div className="pageHeader">
      <div>
        <p className="eyebrow">Downstream Trade Logic</p>
        <h1>Strategy & Signal</h1>
        <p className="muted">Scanner Top30 → 15m Strategy → 5m Signal. Strategy never creates a new symbol universe or flips Scanner bias.</p>
      </div>
      <span className="modePill"><span />{strategyWorker?.running?"15m Strategy worker active":"15m Strategy worker inactive"}</span>
    </div>

    <div className="statGrid">
      <div className="statCard"><span>Scanner Input</span><strong>{top30.length}</strong><small className="neutral">locked contracts from current 1H cycle</small></div>
      <div className="statCard"><span>15m Strategy PASS</span><strong>{strategyWorker?.last_pass_count??latestStrategy?.pass_count??0}</strong><small className="neutral">HOLD {strategyWorker?.last_hold_count??latestStrategy?.hold_count??0}</small></div>
      <div className="statCard"><span>15m LONG PASS</span><strong className="positive">{strategyWorker?.last_long_pass??latestStrategy?.long_pass??0}</strong><small className="neutral">Scanner LONG bias preserved</small></div>
      <div className="statCard"><span>15m SHORT PASS</span><strong className="negative">{strategyWorker?.last_short_pass??latestStrategy?.short_pass??0}</strong><small className="neutral">Scanner SHORT bias preserved</small></div>
    </div>

    <section className="panel" style={{padding:18,marginBottom:14}}>
      <div className="panelHead" style={{alignItems:"flex-start"}}>
        <div>
          <p className="eyebrow">Pipeline Boundary</p>
          <h2>Scanner → 15m Strategy → 5m Signal</h2>
          <p className="muted" style={{marginTop:6}}>15m checks EMA20/50 alignment, pullback, rejection candle, MACD momentum, RSI, volume and ATR quality. PASS needs score ≥70 plus hard structure/volatility gates.</p>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <span className="periodTag">Strategy runs {strategyWorker?.run_count??0}</span>
          <span className="periodTag">{strategyWorker?.last_layer??"waiting"}</span>
          <button onClick={()=>void load()} style={buttonStyle}>Refresh</button>
        </div>
      </div>

      <div style={flowGrid}>
        <div style={flowCard}><span className="eyebrow">Input</span><strong style={flowTitle}>1H Scanner Top30</strong><p className="muted">Locked symbol universe + LONG/SHORT bias.</p></div>
        <div style={arrow}>→</div>
        <div style={flowCard}><span className="eyebrow">Strategy Engine</span><strong style={flowTitle}>15m Setup PASS/HOLD</strong><p className="muted">Runs on each new closed 15m candle.</p><span className="periodTag" style={{marginTop:10,width:"max-content"}}>Implemented</span></div>
        <div style={arrow}>→</div>
        <div style={flowCard}><span className="eyebrow">Signal Layer</span><strong style={flowTitle}>5m Entry Signal</strong><p className="muted">Only 15m PASS symbols proceed.</p><span className="periodTag" style={{marginTop:10,width:"max-content"}}>Next engine</span></div>
      </div>
    </section>

    {strategyWorker?.waiting_for_scanner_cooldown&&<div className="panel" style={{padding:12,marginBottom:14}}><span className="muted">Strategy waiting for shared Binance cooldown · {strategyWorker.scanner_retry_in_seconds??0}s</span></div>}
    {strategyWorker?.last_error&&<div className="panel" style={{padding:12,marginBottom:14}}><span className="negative">Strategy error: {strategyWorker.last_error}</span></div>}

    <section className="panel" style={{overflow:"auto"}}>
      <div className="panelHead compact">
        <div>
          <h2>Current Scanner Top30 → 15m Strategy</h2>
          <p className="muted" style={{marginTop:5}}>{latestStrategy?("Strategy evaluated "+new Date(latestStrategy.timestamp).toLocaleString()):latestScanner?("Scanner locked "+new Date(latestScanner.timestamp).toLocaleString()):"Waiting for Scanner output"}</p>
        </div>
        <span className="periodTag">{latestStrategy?.pass_count??0} PASS</span>
      </div>
      <div style={{minWidth:1300}}>
        <div style={{...rowStyle,...headStyle}}>
          <span>Contract</span><span>Bias</span><span>Scanner</span><span>15m</span><span>Score</span><span>EMA20</span><span>EMA50</span><span>RSI</span><span>MACD Hist</span><span>RVOL</span><span>ATR%</span><span>Reason</span><span>5m Signal</span>
        </div>
        {!top30.length&&<div style={{padding:28,color:"#78859a",fontSize:12}}>No locked Scanner Top30 available yet.</div>}
        {top30.map(row=>{
          const st=strategyBySymbol.get(row.symbol);
          const reason=st?.status==="PASS"?(st.reasons?.join(" · ")||"PASS"):(st?.hold_reasons?.join(" · ")||"Waiting 15m evaluation");
          return <div key={row.symbol} style={rowStyle}>
            <strong>{row.symbol}</strong>
            <strong className={row.side==="LONG"?"positive":"negative"}>{row.side}</strong>
            <span>{row.score}</span>
            <strong className={st?.status==="PASS"?"positive":st?"neutral":"neutral"}>{st?.status??"WAIT"}</strong>
            <span>{st?.score??"—"}</span>
            <span>{fmt(st?.ema20_15m)}</span>
            <span>{fmt(st?.ema50_15m)}</span>
            <span>{fmt(st?.rsi_15m)}</span>
            <span>{fmt(st?.macd_histogram_15m,5)}</span>
            <span>{fmt(st?.rvol_15m)}x</span>
            <span>{fmt(st?.atr_pct_15m)}%</span>
            <span title={reason} style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{reason}</span>
            <span className="neutral">{st?.status==="PASS"?"Waiting 5m engine":"—"}</span>
          </div>;
        })}
      </div>
    </section>

    {error&&<p className="negative" style={{marginTop:12}}>{error}</p>}
  </div>
}

function fmt(v:number|undefined,d=2){
  return v===undefined||!Number.isFinite(v)?"—":v.toLocaleString(undefined,{maximumFractionDigits:d});
}

const buttonStyle={background:"#0b1118",color:"#dfe7f1",border:"1px solid #263242",borderRadius:7,padding:"8px 11px",cursor:"pointer"} as const;
const flowGrid={display:"grid",gridTemplateColumns:"1fr auto 1fr auto 1fr",gap:12,alignItems:"stretch",marginTop:18} as const;
const flowCard={border:"1px solid #1d2a39",borderRadius:10,padding:14,background:"#0a1018",display:"flex",flexDirection:"column",justifyContent:"center"} as const;
const flowTitle={display:"block",fontSize:15,margin:"7px 0"} as const;
const arrow={display:"grid",placeItems:"center",color:"#52d9aa",fontSize:22,fontWeight:800} as const;
const headStyle={color:"#69768a",fontSize:9,textTransform:"uppercase"} as const;
const rowStyle={display:"grid",gridTemplateColumns:"100px 65px 60px 65px 55px 90px 90px 60px 90px 65px 65px 320px 120px",gap:10,padding:"10px 14px",borderBottom:"1px solid #171f2a",fontSize:10,alignItems:"center"} as const;
