"use client";

import { useEffect, useMemo, useState } from "react";

type Ticker = {
  symbol: string;
  last_price: string;
  price_change: string;
  price_change_percent: string;
  high_price: string;
  low_price: string;
  volume: string;
  quote_volume: string;
};

type Candle = {
  open_time: number;
  open: string;
  high: string;
  low: string;
  close: string;
  volume: string;
  close_time: number;
};

type KlinesResponse = {
  symbol: string;
  interval: string;
  candles: Candle[];
};

type BookLevel = { price: string; quantity: string };
type OrderBook = {
  symbol: string;
  last_update_id: number;
  bids: BookLevel[];
  asks: BookLevel[];
};

const symbol = "BTCUSDT";

function formatNumber(value: string | number | undefined, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

async function getJson<T>(url: string): Promise<T> {
  const response = await fetch(url, { cache: "no-store" });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.detail ?? "Market data request failed");
  }
  return response.json();
}

export default function MarketWatchPage() {
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [klines, setKlines] = useState<KlinesResponse | null>(null);
  const [orderBook, setOrderBook] = useState<OrderBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;

    const loadFastData = async () => {
      try {
        const [tickerData, bookData] = await Promise.all([
          getJson<Ticker>(`/api/market/ticker/${symbol}`),
          getJson<OrderBook>(`/api/market/orderbook/${symbol}?limit=20`),
        ]);
        if (!active) return;
        setTicker(tickerData);
        setOrderBook(bookData);
        setError(null);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Unable to load market data");
      } finally {
        if (active) setLoading(false);
      }
    };

    const loadCandles = async () => {
      try {
        const candleData = await getJson<KlinesResponse>(
          `/api/market/klines/${symbol}?interval=1h&limit=24`,
        );
        if (active) setKlines(candleData);
      } catch (err) {
        if (active) setError(err instanceof Error ? err.message : "Unable to load candles");
      }
    };

    loadFastData();
    loadCandles();
    const fastTimer = window.setInterval(loadFastData, 5000);
    const candleTimer = window.setInterval(loadCandles, 30000);

    return () => {
      active = false;
      window.clearInterval(fastTimer);
      window.clearInterval(candleTimer);
    };
  }, []);

  const candles = klines?.candles ?? [];
  const maxRange = useMemo(
    () => Math.max(...candles.map((candle) => Number(candle.high) - Number(candle.low)), 1),
    [candles],
  );

  const asks = (orderBook?.asks ?? []).slice(0, 6).reverse();
  const bids = (orderBook?.bids ?? []).slice(0, 6);
  const change = Number(ticker?.price_change_percent ?? 0);
  const priceClass = change >= 0 ? "positive" : "negative";

  return (
    <div className="terminalPage">
      <div className="terminalTopbar">
        <div>
          <p className="eyebrow">Spot Market · Live Binance Data</p>
          <div className="pairTitle">
            <span className="coinBadge">₿</span>
            <h1>BTC/USDT</h1>
            <span className={priceClass}>{ticker ? `${change >= 0 ? "+" : ""}${formatNumber(change)}%` : "—"}</span>
          </div>
          {error && <p className="negative">{error}</p>}
        </div>
        <div className="tickerStats">
          <div><span>Last price</span><strong className={priceClass}>{loading ? "Loading…" : formatNumber(ticker?.last_price)}</strong></div>
          <div><span>24h high</span><strong>{formatNumber(ticker?.high_price)}</strong></div>
          <div><span>24h low</span><strong>{formatNumber(ticker?.low_price)}</strong></div>
          <div><span>24h volume</span><strong>{formatNumber(ticker?.volume, 4)} BTC</strong></div>
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
            <div className="maLabel"><span>Live 1H candles</span><span>{candles.length} bars</span></div>
            <div className="candles" aria-label="Live BTC hourly candlestick chart">
              {candles.map((candle) => {
                const open = Number(candle.open);
                const close = Number(candle.close);
                const range = Number(candle.high) - Number(candle.low);
                const height = Math.max(28, 30 + (range / maxRange) * 120);
                const body = Math.max(8, Math.min(height - 4, Math.abs(close - open) / Math.max(range, 1) * height));
                const up = close >= open;
                return (
                  <div key={candle.open_time} className={`candle ${up ? "up" : "down"}`} style={{ height: `${height}px` }}>
                    <i style={{ height: `${body}px` }} />
                  </div>
                );
              })}
            </div>
            <div className="priceMarker">{formatNumber(ticker?.last_price)}</div>
          </div>
          <div className="indicatorPanel">
            <div className="indicatorHead"><strong>Data status</strong><span>{error ? "Degraded" : "Live"}</span></div>
            <div className="rsiChart"><div className="rsiLine" /></div>
          </div>
        </section>

        <aside className="panel orderBookPanel">
          <div className="panelHead compact"><h2>Order Book</h2><span className="periodTag">Live</span></div>
          <div className="bookHeader"><span>Price (USDT)</span><span>Amount (BTC)</span><span>Total</span></div>
          <div className="bookRows asks">
            {asks.map((row) => <div className="bookRow" key={`ask-${row.price}`}><span>{formatNumber(row.price)}</span><span>{formatNumber(row.quantity, 5)}</span><span>{formatNumber(Number(row.price) * Number(row.quantity), 0)}</span></div>)}
          </div>
          <div className="spreadRow"><strong className={priceClass}>{formatNumber(ticker?.last_price)}</strong><span>≈ ${formatNumber(ticker?.last_price)}</span></div>
          <div className="bookRows bids">
            {bids.map((row) => <div className="bookRow" key={`bid-${row.price}`}><span>{formatNumber(row.price)}</span><span>{formatNumber(row.quantity, 5)}</span><span>{formatNumber(Number(row.price) * Number(row.quantity), 0)}</span></div>)}
          </div>
        </aside>

        <section className="panel positionsPanel">
          <div className="positionsTabs"><button className="selected">Positions (Demo)</button><button>Open Orders</button><button>Order History</button><button>Trade History</button></div>
          <div className="positionTable">
            <div className="positionRow positionHead"><span>Symbol</span><span>Side</span><span>Size</span><span>Entry Price</span><span>Mark Price</span><span>Unrealized PnL</span><span>ROE</span></div>
            <div className="positionRow"><strong>BTCUSDT</strong><span className="longBadge">LONG</span><span>Demo</span><span>—</span><span>{formatNumber(ticker?.last_price)}</span><strong>—</strong><span>—</span></div>
            <div className="positionRow"><span>Account positions stay demo until authenticated account integration is added.</span></div>
          </div>
        </section>
      </div>
    </div>
  );
}
