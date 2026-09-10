"use client";

export default function TradeExecutionPage(){
  return <div className="pageWrap">
    <div className="pageHeader">
      <div>
        <p className="eyebrow">Order Pipeline</p>
        <h1>Trade Execution</h1>
        <p className="muted">5m Signal → Risk Engine → Position Engine → Execution Engine → Trade Management.</p>
      </div>
      <span className="modePill"><span />Live trading disabled</span>
    </div>

    <div className="statGrid">
      <div className="statCard"><span>Signal Input</span><strong>—</strong><small className="neutral">waits for approved 5m signal</small></div>
      <div className="statCard"><span>Risk Approval</span><strong>—</strong><small className="neutral">Risk Engine not implemented yet</small></div>
      <div className="statCard"><span>Position Plan</span><strong>—</strong><small className="neutral">Position Engine not implemented yet</small></div>
      <div className="statCard"><span>Execution Status</span><strong>SAFE</strong><small className="neutral">no exchange order placement enabled</small></div>
    </div>

    <section className="panel" style={{padding:18,marginBottom:14}}>
      <div className="panelHead" style={{alignItems:"flex-start"}}>
        <div>
          <p className="eyebrow">Execution Boundary</p>
          <h2>Signal → Risk → Position → Order</h2>
          <p className="muted" style={{marginTop:6}}>This page is the execution workspace. No live order can be sent until each downstream engine is implemented and validated.</p>
        </div>
        <span className="periodTag">Planning mode</span>
      </div>

      <div style={flowGrid}>
        <div style={flowCard}>
          <span className="eyebrow">Input</span>
          <strong style={flowTitle}>5m Approved Signal</strong>
          <p className="muted">Symbol · LONG/SHORT · entry context · strategy score.</p>
        </div>
        <div style={arrow}>→</div>
        <div style={flowCard}>
          <span className="eyebrow">Risk Engine</span>
          <strong style={flowTitle}>Risk Approval</strong>
          <p className="muted">Account risk · stop distance · max loss · reject/approve.</p>
          <span className="periodTag" style={tagStyle}>Planned</span>
        </div>
        <div style={arrow}>→</div>
        <div style={flowCard}>
          <span className="eyebrow">Position Engine</span>
          <strong style={flowTitle}>Position Sizing</strong>
          <p className="muted">Quantity · leverage rule · margin requirement · final size.</p>
          <span className="periodTag" style={tagStyle}>Planned</span>
        </div>
        <div style={arrow}>→</div>
        <div style={flowCard}>
          <span className="eyebrow">Execution Engine</span>
          <strong style={flowTitle}>Order Placement</strong>
          <p className="muted">Entry order · exchange response · fill verification · failure handling.</p>
          <span className="periodTag" style={tagStyle}>Disabled</span>
        </div>
      </div>
    </section>

    <section className="panel" style={{padding:18}}>
      <div className="panelHead">
        <div>
          <p className="eyebrow">After Fill</p>
          <h2>Trade Management Handoff</h2>
        </div>
        <span className="periodTag">Future engine</span>
      </div>
      <div style={managementGrid}>
        <div style={miniCard}><strong>Stop Loss</strong><span className="muted">Initial SL placement and validation.</span></div>
        <div style={miniCard}><strong>Take Profit</strong><span className="muted">TP targets and partial exits.</span></div>
        <div style={miniCard}><strong>Break-even</strong><span className="muted">Move protection after favorable movement.</span></div>
        <div style={miniCard}><strong>Trailing / Close</strong><span className="muted">Trailing logic, emergency close and final reconciliation.</span></div>
      </div>
    </section>
  </div>
}

const flowGrid={display:"grid",gridTemplateColumns:"1fr auto 1fr auto 1fr auto 1fr",gap:12,alignItems:"stretch",marginTop:18,overflowX:"auto"} as const;
const flowCard={border:"1px solid #1d2a39",borderRadius:10,padding:14,background:"#0a1018",display:"flex",flexDirection:"column",justifyContent:"center",minWidth:190} as const;
const flowTitle={display:"block",fontSize:15,margin:"7px 0"} as const;
const arrow={display:"grid",placeItems:"center",color:"#52d9aa",fontSize:22,fontWeight:800} as const;
const tagStyle={marginTop:10,width:"max-content"} as const;
const managementGrid={display:"grid",gridTemplateColumns:"repeat(4,minmax(0,1fr))",gap:12,marginTop:18} as const;
const miniCard={border:"1px solid #1d2a39",borderRadius:10,padding:14,background:"#0a1018",display:"flex",flexDirection:"column",gap:7} as const;
