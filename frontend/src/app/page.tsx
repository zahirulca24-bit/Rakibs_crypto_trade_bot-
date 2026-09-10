const stats = [
  { label: "Portfolio Balance", value: "$24,860.40", meta: "+2.84% today", tone: "positive" },
  { label: "Available Balance", value: "$12,420.10", meta: "49.95% free", tone: "neutral" },
  { label: "Open Positions", value: "04", meta: "2 long · 2 short", tone: "neutral" },
  { label: "Today PnL", value: "+$684.20", meta: "+2.75%", tone: "positive" }
];

const markets = [
  { symbol: "BTC/USDT", price: "67,842.10", change: "+1.82%", volume: "$1.24B" },
  { symbol: "ETH/USDT", price: "3,486.72", change: "+0.94%", volume: "$684.2M" },
  { symbol: "SOL/USDT", price: "154.38", change: "+3.41%", volume: "$312.7M" },
  { symbol: "BNB/USDT", price: "592.64", change: "-0.38%", volume: "$198.5M" }
];

export default function DashboardPage() {
  return (
    <div className="pageWrap">
      <header className="pageHeader">
        <div>
          <p className="eyebrow">Overview</p>
          <h1>Dashboard</h1>
          <p className="muted">Trading account summary and quick market snapshot.</p>
        </div>
        <div className="modePill"><span /> Paper Mode</div>
      </header>

      <section className="statGrid">
        {stats.map((item) => (
          <article className="statCard" key={item.label}>
            <span>{item.label}</span>
            <strong>{item.value}</strong>
            <small className={item.tone}>{item.meta}</small>
          </article>
        ))}
      </section>

      <section className="dashboardGrid">
        <article className="panel accountPanel">
          <div className="panelHead">
            <div><p className="eyebrow">Performance</p><h2>Account Summary</h2></div>
            <span className="periodTag">7D</span>
          </div>
          <div className="performanceChart">
            <div className="chartGrid" />
            <svg viewBox="0 0 760 230" preserveAspectRatio="none" aria-label="Portfolio performance chart">
              <defs>
                <linearGradient id="area" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6ee7b7" stopOpacity="0.25" />
                  <stop offset="100%" stopColor="#6ee7b7" stopOpacity="0" />
                </linearGradient>
              </defs>
              <path className="areaPath" d="M0 188 C70 176,92 151,145 161 S240 127,295 139 S390 93,445 108 S535 68,590 80 S680 42,760 50 L760 230 L0 230 Z" />
              <path className="linePath" d="M0 188 C70 176,92 151,145 161 S240 127,295 139 S390 93,445 108 S535 68,590 80 S680 42,760 50" />
            </svg>
          </div>
          <div className="metricRow">
            <div><span>Win rate</span><strong>68.4%</strong></div>
            <div><span>Total trades</span><strong>38</strong></div>
            <div><span>Best trade</span><strong className="positive">+$312.80</strong></div>
            <div><span>Max drawdown</span><strong>-4.2%</strong></div>
          </div>
        </article>

        <article className="panel watchPanel">
          <div className="panelHead">
            <div><p className="eyebrow">Live snapshot</p><h2>Market Watch</h2></div>
            <a href="/market-watch" className="textLink">Open terminal →</a>
          </div>
          <div className="marketTable">
            <div className="tableRow tableHead"><span>Pair</span><span>Price</span><span>24h</span><span>Volume</span></div>
            {markets.map((market) => (
              <div className="tableRow" key={market.symbol}>
                <strong>{market.symbol}</strong>
                <span>{market.price}</span>
                <span className={market.change.startsWith("+") ? "positive" : "negative"}>{market.change}</span>
                <span>{market.volume}</span>
              </div>
            ))}
          </div>
        </article>
      </section>
    </div>
  );
}
