"use client";

import { useCallback, useEffect, useMemo, useState } from "react";

type Candidate={
  symbol:string;
  side:"LONG"|"SHORT";
  score:number;
  quote_volume:number;
  last_price:number;
  structure_1h?:string;
  rsi_1h?:number;
  rvol_1h?:number;
  atr_pct_1h?:number;
  oi_change_1h_pct?:number;
  spread_pct?:number;
  reasons:string[];
};

type ScannerRun={
  timestamp:string;
  candidate_count:number;
  long_candidates:number;
  short_candidates:number;
  candidates:Candidate[];
};

type LogsResponse={engine:string;logs:ScannerRun[]};
type WorkerStatus={running:boolean;last_top30:number;last_layer?:string;run_count:number};

export default function StrategySignalPage(){
  const[logs,setLogs]=useState<ScannerRun[]>([]);
  const[worker,setWorker]=useState<WorkerStatus|null>(null);
  const[error,setError]=useState<string|null>(null);

  const load=useCallback(async()=>{
    try{
      const[lr,wr]=await Promise.all([
        fetch("/api/scanner/logs",{cache:"no-store"}),
        fetch("/api/scanner/worker/status",{cache:"no-store"})
      ]);
      if(!lr.ok||!wr.ok)throw new Error("Unable to load Scanner Top30");
      setLogs((await lr.json() as LogsResponse).logs??[]);
      setWorker(await wr.json() as WorkerStatus);
      setError(null);
    }catch(e){
      setError(e instanceof Error?e.message:"Unable to load Strategy & Signal state");
    }
  },[]);

  useEffect(()=>{
    void load();
    const id=window.setInterval(()=>void load(),15000);
    return()=>window.clearInterval(id);
  },[load]);

  const latest=logs[0];
  const top30=useMemo(()=>latest?.candidates??[],[latest]);

  return <div className="pageWrap">
    <div className="pageHeader">
      <div>
        <p className="eyebrow">Downstream Trade Logic</p>
        <h1>Strategy & Signal</h1>
        <p className="muted">Scanner Top30 → 15m Strategy → 5m Signal. Strategy and Signal do not create a new symbol universe.</p>
      </div>
      <span className="modePill"><span />{worker?.running?"Scanner feed active":"Scanner feed inactive"}</span>
    </div>

    <div className="statGrid">
      <div className="statCard">
        <span>Scanner Input</span>
        <strong>{top30.length}</strong>
        <small className="neutral">locked contracts from current 1H cycle</small>
      </div>
      <div className="statCard">
        <span>15m Strategy PASS</span>
        <strong>—</strong>
        <small className="neutral">engine not implemented yet</small>
      </div>
      <div className="statCard">
        <span>5m LONG Signal</span>
        <strong className="positive">—</strong>
        <small className="neutral">waits for Strategy PASS</small>
      </div>
      <div className="statCard">
        <span>5m SHORT Signal</span>
        <strong className="negative">—</strong>
        <small className="neutral">waits for Strategy PASS</small>
      </div>
    </div>

    <section className="panel" style={{padding:18,marginBottom:14}}>
      <div className="panelHead" style={{alignItems:"flex-start"}}>
        <div>
          <p className="eyebrow">Pipeline Boundary</p>
          <h2>Scanner → Strategy → Signal</h2>
          <p className="muted" style={{marginTop:6}}>Only Scanner Top30 is accepted as input. 15m owns setup validation; 5m owns signal timing.</p>
        </div>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
          <span className="periodTag">Scanner runs {worker?.run_count??0}</span>
          <span className="periodTag">{worker?.last_layer??"waiting"}</span>
          <button onClick={()=>void load()} style={buttonStyle}>Refresh</button>
        </div>
      </div>

      <div style={flowGrid}>
        <div style={flowCard}>
          <span className="eyebrow">Input</span>
          <strong style={flowTitle}>1H Scanner Top30</strong>
          <p className="muted">Locked bias + quality score + 1H context.</p>
        </div>
        <div style={arrow}>→</div>
        <div style={flowCard}>
          <span className="eyebrow">Strategy Engine</span>
          <strong style={flowTitle}>15m Setup</strong>
          <p className="muted">EMA20/50 structure · pullback/rejection · MACD · RSI · volume · ATR quality.</p>
          <span className="periodTag" style={{marginTop:10,width:"max-content"}}>Planned</span>
        </div>
        <div style={arrow}>→</div>
        <div style={flowCard}>
          <span className="eyebrow">Signal Layer</span>
          <strong style={flowTitle}>5m Entry Signal</strong>
          <p className="muted">Only 15m PASS symbols proceed. Risk & Position engines attach here later.</p>
          <span className="periodTag" style={{marginTop:10,width:"max-content"}}>Planned</span>
        </div>
      </div>
    </section>

    <section className="panel" style={{overflow:"auto"}}>
      <div className="panelHead compact">
        <div>
          <h2>Current Scanner Top30 Input</h2>
          <p className="muted" style={{marginTop:5}}>{latest?("Locked at "+new Date(latest.timestamp).toLocaleString()):"Waiting for Scanner output"}</p>
        </div>
        <span className="periodTag">{top30.length} contracts</span>
      </div>
      <div style={{minWidth:1050}}>
        <div style={{...rowStyle,...headStyle}}>
          <span>Contract</span><span>Bias</span><span>Score</span><span>1H Structure</span><span>RSI</span><span>RVOL</span><span>ATR%</span><span>OI Δ 1H</span><span>Spread</span><span>Strategy</span><span>Signal</span>
        </div>
        {!top30.length&&<div style={{padding:28,color:"#78859a",fontSize:12}}>No locked Scanner Top30 available yet.</div>}
        {top30.map(row=><div key={row.symbol} style={rowStyle}>
          <strong>{row.symbol}</strong>
          <strong className={row.side==="LONG"?"positive":"negative"}>{row.side}</strong>
          <span>{row.score}</span>
          <span>{row.structure_1h??"—"}</span>
          <span>{fmt(row.rsi_1h)}</span>
          <span>{fmt(row.rvol_1h)}x</span>
          <span>{fmt(row.atr_pct_1h)}%</span>
          <span>{fmt(row.oi_change_1h_pct)}%</span>
          <span>{fmt(row.spread_pct,4)}%</span>
          <span className="neutral">Waiting 15m engine</span>
          <span className="neutral">Waiting 5m engine</span>
        </div>)}
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
const rowStyle={display:"grid",gridTemplateColumns:"100px 65px 55px 95px 65px 65px 65px 80px 75px 145px 145px",gap:10,padding:"10px 14px",borderBottom:"1px solid #171f2a",fontSize:10,alignItems:"center"} as const;
