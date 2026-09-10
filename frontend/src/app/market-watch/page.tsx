"use client";

import { useEffect, useMemo, useState } from "react";

type Ticker = {
  symbol: string;
  last_price: string;
  price_change_percent: string;
  high_price: string;
  low_price: string;
  volume: string;
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

type BookLevel = { price: string; quantity: string };
type OrderBook = { bids: BookLevel[]; asks: BookLevel[] };

const symbol = "BTCUSDT";
const wsSymbol = symbol.toLowerCase();
const streamUrl = `wss://stream.binance.com:9443/stream?streams=${wsSymbol}@ticker/${wsSymbol}@kline_1h/${wsSymbol}@depth20@1000ms`;

function formatNumber(value: string | number | undefined, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export default function MarketWatchPage() {
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [orderBook, setOrderBook] = useState<OrderBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const loadHistory = async () => {
      try {
        const response = await fetch(
          `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=1h&limit=24`,
          { cache: "no-store" },
        );
        if (!response.ok) throw new Error("Unable to load candle history");
        const rows = await response.json();
        if (!active) return;
        setCandles(
          rows.map((row: (string | number)[]) => ({
            open_time: Number(row[0]),
            open: String(row[1]),
            high: String(row[2]),
            low: String(row[3]),
            close: String(row[4]),
            volume: String(row[5]),
            close_time: Number(row[6]),
          })),
        );
      } catch {
        if (active) setError("Live stream connected, but candle history is unavailable.");
      }
    };

    const connect = () => {
      socket = new WebSocket(streamUrl);

      socket.onopen = () => {
        if (!active) return;
        setConnected(true);
        setError(null);
      };

      socket.onmessage = (event) => {
        if (!active) return;
        const message = JSON.parse(event.data);
        const data = message.data;
        if (!data) return;

        if (data.e === "24hrTicker") {
          setTicker({
            symbol: data.s,
            last_price: data.c,
            price_change_percent: data.P,
            high_price: data.h,
            low_price: data.l,
            volume: data.v,
          });
          return;
        }

        if (data.e === "kline") {
          const kline = data.k;
          const nextCandle: Candle = {
            open_time: Number(kline.t),
            open: String(kline.o),
            high: String(kline.h),
            low: String(kline.l),
            close: String(kline.c),
            volume: String(kline.v),
            close_time: Number(kline.T),
          };
          setCandles((current) => {
            const existingIndex = current.findIndex((item) => item.open_time === nextCandle.open_time);
            if (existingIndex >= 0) {
              const next = [...current];
              next[existingIndex] = nextCandle;
              return next.slice(-24);
            }
            return [...current, nextCandle].slice(-24);
          });
          return;
        }

        if (Array.isArray(data.bids) && Array.isArray(data.asks)) {
          setOrderBook({
            bids: data.bids.map(([price, quantity]: [string, string]) => ({ price, quantity })),
            asks: data.asks.map(([price, quantity]: [string, string]) => ({ price, quantity })),
          });
        }
      };

      socket.onerror = () => {
        if (active) setError("Binance WebSocket connection error. Reconnecting…");
      };

      socket.onclose = () => {
        if (!active) return;
        setConnected(false);
        reconnectTimer = window.setTimeout(connect, 3000);
      };
    };

    loadHistory();
    connect();

    return () => {
      active = false;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, []);

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
          <p className="eyebrow">Spot Market · Binance WebSocket</p>
          <div className="pairTitle">
            <span className="coinBadge">₿</span>
            <h1>BTC/USDT</h1>
            <span className={priceClass}>{ticker ? `${change >= 0 ? "+" : ""}${formatNumber(change)}%` : "—"}</span>
          </div>
          {error && <p className="negative">{error}</p>}
        </div>
        <div className="tickerStats">
          <div><span>Last price</span><strong className={priceClass}>{formatNumber(ticker?.last_price)}</strong></div>
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
            <div className="indicatorHead"><strong>Data status</strong><span>{connected ? "Live WebSocket" : "Connecting…"}</span></div>
            <div className="rsiChart"><div className="rsiLine" /></div>
          </div>
        </section>

        <aside className="panel orderBookPanel">
          <div className="panelHead compact"><h2>Order Book</h2><span className="periodTag">WS Live</span></div>
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
