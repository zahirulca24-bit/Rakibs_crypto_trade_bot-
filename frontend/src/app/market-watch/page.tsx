const asks = [
  ["67,910.4", "0.184", "12,497"], ["67,902.8", "0.095", "6,451"], ["67,895.2", "0.321", "21,792"],
  ["67,887.6", "0.142", "9,639"], ["67,880.1", "0.267", "18,125"], ["67,872.5", "0.118", "8,011"]
];
const bids = [
  ["67,842.1", "0.214", "14,519"], ["67,834.5", "0.132", "8,954"], ["67,826.9", "0.288", "19,530"],
  ["67,819.4", "0.174", "11,800"], ["67,811.8", "0.356", "24,141"], ["67,804.2", "0.149", "10,103"]
];

const candles = [42,58,35,67,51,74,62,88,70,96,81,108,92,116,101,129,111,138,124,151,135,162,143,174];

export default function MarketWatchPage() {
  return (
    <div className="terminalPage">
      <div className="terminalTopbar">
        <div>
          <p className="eyebrow">Spot Market</p>
          <div className="pairTitle"><span className="coinBadge">₿</span><h1>BTC/USDT</h1><span className="positive">+1.82%</span></div>
        </div>
        <div className="tickerStats">
          <div><span>Last price</span><strong className="positive">67,842.10</strong></div>
          <div><span>24h high</span><strong>68,410.00</strong></div>
          <div><span>24h low</span><strong>66,204.60</strong></div>
          <div><span>24h volume</span><strong>18.34K BTC</strong></div>
        </div>
      </div>

      <div className="terminalGrid">
        <section className="panel chartPanel">
          <div className="chartToolbar">
            <div className="toolbarGroup"><button>15m</button><button className="selected">1H</button><button>4H</button><button>1D</button></div>
            <div className="toolbarGroup"><button>Indicators</button><button>⚙</button><button>⛶</button></div>
          </div>
          <div className="priceChart">
            <div className="chartGrid terminalChartGrid" />
            <div className="maLabel"><span>MA(7) 67,512.4</span><span>MA(25) 67,184.9</span></div>
            <div className="candles" aria-label="Mock BTC candlestick chart">
              {candles.map((height, i) => {
                const up = i % 4 !== 1;
                const body = Math.max(18, height * 0.42);
                return <div key={i} className={`candle ${up ? "up" : "down"}`} style={{height: `${height}px`}}><i style={{height: `${body}px`}} /></div>;
              })}
            </div>
            <div className="priceMarker">67,842.10</div>
          </div>
          <div className="indicatorPanel">
            <div className="indicatorHead"><strong>RSI (14)</strong><span>61.42</span></div>
            <div className="rsiChart"><div className="rsiLine" /></div>
          </div>
        </section>

        <aside className="panel orderBookPanel">
          <div className="panelHead compact"><h2>Order Book</h2><span className="periodTag">0.1</span></div>
          <div className="bookHeader"><span>Price (USDT)</span><span>Amount (BTC)</span><span>Total</span></div>
          <div className="bookRows asks">
            {asks.map((row) => <div className="bookRow" key={row[0]}><span>{row[0]}</span><span>{row[1]}</span><span>{row[2]}</span></div>)}
          </div>
          <div className="spreadRow"><strong className="positive">67,842.10</strong><span>≈ $67,842.10</span></div>
          <div className="bookRows bids">
            {bids.map((row) => <div className="bookRow" key={row[0]}><span>{row[0]}</span><span>{row[1]}</span><span>{row[2]}</span></div>)}
          </div>
        </aside>

        <section className="panel positionsPanel">
          <div className="positionsTabs"><button className="selected">Positions (2)</button><button>Open Orders</button><button>Order History</button><button>Trade History</button></div>
          <div className="positionTable">
            <div className="positionRow positionHead"><span>Symbol</span><span>Side</span><span>Size</span><span>Entry Price</span><span>Mark Price</span><span>Unrealized PnL</span><span>ROE</span></div>
            <div className="positionRow"><strong>BTCUSDT</strong><span className="longBadge">LONG</span><span>0.084 BTC</span><span>66,920.40</span><span>67,842.10</span><strong className="positive">+$77.42</strong><span className="positive">+3.28%</span></div>
            <div className="positionRow"><strong>ETHUSDT</strong><span className="shortBadge">SHORT</span><span>1.20 ETH</span><span>3,521.20</span><span>3,486.72</span><strong className="positive">+$41.38</strong><span className="positive">+1.63%</span></div>
          </div>
        </section>
      </div>
    </div>
  );
}
