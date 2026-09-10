"use client";

import { useEffect, useMemo, useState } from "react";
import RealCandlestickChart, { type ChartCandle } from "@/components/RealCandlestickChart";

type Ticker = {
  symbol: string;
  last_price: string;
  price_change_percent: string;
  high_price: string;
  low_price: string;
  volume: string;
};

type Candle = ChartCandle & {
  volume: string;
  close_time: number;
};

type BookLevel = { price: string; quantity: string };
type OrderBook = { bids: BookLevel[]; asks: BookLevel[] };
type BinanceSymbol = {
  symbol: string;
  baseAsset: string;
  quoteAsset: string;
  status: string;
  isSpotTradingAllowed?: boolean;
};

type ExchangeInfo = { symbols: BinanceSymbol[] };
type Interval = "1m" | "5m" | "15m" | "1h" | "4h" | "1d";

const HISTORY_LIMIT = 500;
const MARKET_API = "https://data-api.binance.vision";
const STREAM_API = "wss://data-stream.binance.vision/stream";
const intervals: { value: Interval; label: string }[] = [
  { value: "1m", label: "1m" },
  { value: "5m", label: "5m" },
  { value: "15m", label: "15m" },
  { value: "1h", label: "1H" },
  { value: "4h", label: "4H" },
  { value: "1d", label: "1D" },
];

function formatNumber(value: string | number | undefined, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return "—";
  return number.toLocaleString(undefined, {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

export default function MarketWatchPage() {
  const [symbol, setSymbol] = useState("BTCUSDT");
  const [symbolInput, setSymbolInput] = useState("BTCUSDT");
  const [universe, setUniverse] = useState<BinanceSymbol[]>([]);
  const [interval, setIntervalValue] = useState<Interval>("1h");
  const [ticker, setTicker] = useState<Ticker | null>(null);
  const [candles, setCandles] = useState<Candle[]>([]);
  const [orderBook, setOrderBook] = useState<OrderBook | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [connected, setConnected] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(true);

  useEffect(() => {
    let active = true;
    fetch(`${MARKET_API}/api/v3/exchangeInfo`, { cache: "no-store" })
      .then((response) => {
        if (!response.ok) throw new Error("Unable to load Binance symbol universe");
        return response.json() as Promise<ExchangeInfo>;
      })
      .then((data) => {
        if (!active) return;
        const symbols = data.symbols
          .filter((item) => item.status === "TRADING" && item.isSpotTradingAllowed !== false)
          .sort((a, b) => a.symbol.localeCompare(b.symbol));
        setUniverse(symbols);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Unable to load symbols");
      });
    return () => {
      active = false;
    };
  }, []);

  useEffect(() => {
    let active = true;
    setHistoryLoading(true);
    setCandles([]);

    fetch(`${MARKET_API}/api/v3/klines?symbol=${symbol}&interval=${interval}&limit=${HISTORY_LIMIT}`, {
      cache: "no-store",
    })
      .then((response) => {
        if (!response.ok) throw new Error("Unable to load candle history");
        return response.json() as Promise<(string | number)[][]>;
      })
      .then((rows) => {
        if (!active) return;
        setCandles(
          rows.map((row) => ({
            open_time: Number(row[0]),
            open: String(row[1]),
            high: String(row[2]),
            low: String(row[3]),
            close: String(row[4]),
            volume: String(row[5]),
            close_time: Number(row[6]),
          })),
        );
        setError(null);
      })
      .catch((err) => {
        if (active) setError(err instanceof Error ? err.message : "Unable to load candle history");
      })
      .finally(() => {
        if (active) setHistoryLoading(false);
      });

    return () => {
      active = false;
    };
  }, [symbol, interval]);

  useEffect(() => {
    let active = true;
    let socket: WebSocket | null = null;
    let reconnectTimer: number | null = null;

    const connect = () => {
      const wsSymbol = symbol.toLowerCase();
      const streams = `${wsSymbol}@ticker/${wsSymbol}@kline_${interval}/${wsSymbol}@depth20@1000ms`;
      socket = new WebSocket(`${STREAM_API}?streams=${streams}`);

      socket.onopen = () => {
        if (!active) return;
        setConnected(true);
        setError(null);
      };

      socket.onmessage = (event) => {
        if (!active) return;
        try {
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
                return next.slice(-HISTORY_LIMIT);
              }
              return [...current, nextCandle].slice(-HISTORY_LIMIT);
            });
            return;
          }

          if (Array.isArray(data.bids) && Array.isArray(data.asks)) {
            setOrderBook({
              bids: data.bids.map(([price, quantity]: [string, string]) => ({ price, quantity })),
              asks: data.asks.map(([price, quantity]: [string, string]) => ({ price, quantity })),
            });
          }
        } catch {
          setError("Received malformed Binance stream data");
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

    setTicker(null);
    setOrderBook(null);
    setConnected(false);
    connect();

    return () => {
      active = false;
      if (reconnectTimer !== null) window.clearTimeout(reconnectTimer);
      socket?.close();
    };
  }, [symbol, interval]);

  const selectedInfo = useMemo(
    () => universe.find((item) => item.symbol === symbol),
    [universe, symbol],
  );
  const baseAsset = selectedInfo?.baseAsset ?? symbol.replace(/USDT$/, "");
  const quoteAsset = selectedInfo?.quoteAsset ?? (symbol.endsWith("USDT") ? "USDT" : "");
  const pairLabel = quoteAsset ? `${baseAsset}/${quoteAsset}` : symbol;
  const asks = (orderBook?.asks ?? []).slice(0, 8).reverse();
  const bids = (orderBook?.bids ?? []).slice(0, 8);
  const change = Number(ticker?.price_change_percent ?? 0);
  const priceClass = change >= 0 ? "positive" : "negative";

  const commitSymbol = (value: string) => {
    const normalized = value.trim().replace(/[/\-\s]/g, "").toUpperCase();
    if (!normalized) return;
    const exists = universe.length === 0 || universe.some((item) => item.symbol === normalized);
    if (!exists) {
      setError(`Symbol ${normalized} is not an active Binance Spot pair`);
      return;
    }
    setSymbolInput(normalized);
    setSymbol(normalized);
  };

  return (
    <div className="terminalPage">
      <div className="terminalTopbar">
        <div>
          <p className="eyebrow">Spot Market · Full Binance Universe</p>
          <div className="pairTitle">
            <span className="coinBadge">◈</span>
            <h1>{pairLabel}</h1>
            <span className={priceClass}>{ticker ? `${change >= 0 ? "+" : ""}${formatNumber(change)}%` : "—"}</span>
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, alignItems: "center", flexWrap: "wrap" }}>
            <input
              list="binance-symbols"
              value={symbolInput}
              onChange={(event) => setSymbolInput(event.target.value.toUpperCase())}
              onKeyDown={(event) => {
                if (event.key === "Enter") commitSymbol(symbolInput);
              }}
              onBlur={() => commitSymbol(symbolInput)}
              placeholder="Search symbol e.g. ETHUSDT"
              aria-label="Search Binance Spot symbol"
              style={{
                background: "#0b1118",
                color: "#dfe7f1",
                border: "1px solid #263242",
                borderRadius: 8,
                padding: "8px 10px",
                minWidth: 240,
              }}
            />
            <datalist id="binance-symbols">
              {universe.map((item) => (
                <option key={item.symbol} value={item.symbol}>{`${item.baseAsset}/${item.quoteAsset}`}</option>
              ))}
            </datalist>
            <span className="periodTag">{universe.length ? `${universe.length} spot pairs` : "Loading symbols…"}</span>
          </div>
          {error && <p className="negative" style={{ marginTop: 8 }}>{error}</p>}
        </div>
        <div className="tickerStats">
          <div><span>Last price</span><strong className={priceClass}>{formatNumber(ticker?.last_price)}</strong></div>
          <div><span>24h high</span><strong>{formatNumber(ticker?.high_price)}</strong></div>
          <div><span>24h low</span><strong>{formatNumber(ticker?.low_price)}</strong></div>
          <div><span>24h volume</span><strong>{formatNumber(ticker?.volume, 4)} {baseAsset}</strong></div>
        </div>
      </div>

      <div className="terminalGrid">
        <section className="panel chartPanel">
          <div className="chartToolbar">
            <div className="toolbarGroup">
              {intervals.map((item) => (
                <button
                  key={item.value}
                  className={interval === item.value ? "selected" : ""}
                  onClick={() => setIntervalValue(item.value)}
                >
                  {item.label}
                </button>
              ))}
            </div>
            <div className="toolbarGroup">
              <span className="periodTag">EMA 9 · 20 · 21 · 50 · 200</span>
              <span className="periodTag">RSI 14</span>
              <span className="periodTag">MACD 12/26/9</span>
              <span className="periodTag">{historyLoading ? "Loading candles…" : `${candles.length} bars`}</span>
              <span className="periodTag">{connected ? "WS Live" : "Connecting…"}</span>
            </div>
          </div>
          <div className="priceChart" style={{ height: 815, minHeight: 815, overflow: "hidden" }}>
            <RealCandlestickChart candles={candles} />
          </div>
          <div className="indicatorPanel">
            <div className="indicatorHead">
              <strong>{pairLabel} · {interval.toUpperCase()}</strong>
              <span>{connected ? "Live WebSocket" : "Connecting…"}</span>
            </div>
          </div>
        </section>

        <aside className="panel orderBookPanel">
          <div className="panelHead compact"><h2>Order Book</h2><span className="periodTag">WS Live</span></div>
          <div className="bookHeader"><span>Price ({quoteAsset || "Quote"})</span><span>Amount ({baseAsset})</span><span>Total</span></div>
          <div className="bookRows asks">
            {asks.map((row) => <div className="bookRow" key={`ask-${row.price}`}><span>{formatNumber(row.price)}</span><span>{formatNumber(row.quantity, 5)}</span><span>{formatNumber(Number(row.price) * Number(row.quantity), 2)}</span></div>)}
          </div>
          <div className="spreadRow"><strong className={priceClass}>{formatNumber(ticker?.last_price)}</strong><span>{quoteAsset ? `≈ ${formatNumber(ticker?.last_price)} ${quoteAsset}` : ""}</span></div>
          <div className="bookRows bids">
            {bids.map((row) => <div className="bookRow" key={`bid-${row.price}`}><span>{formatNumber(row.price)}</span><span>{formatNumber(row.quantity, 5)}</span><span>{formatNumber(Number(row.price) * Number(row.quantity), 2)}</span></div>)}
          </div>
        </aside>

        <section className="panel positionsPanel">
          <div className="positionsTabs"><button className="selected">Positions (Demo)</button><button>Open Orders</button><button>Order History</button><button>Trade History</button></div>
          <div className="positionTable">
            <div className="positionRow positionHead"><span>Symbol</span><span>Side</span><span>Size</span><span>Entry Price</span><span>Mark Price</span><span>Unrealized PnL</span><span>ROE</span></div>
            <div className="positionRow"><strong>{symbol}</strong><span className="longBadge">DEMO</span><span>—</span><span>—</span><span>{formatNumber(ticker?.last_price)}</span><strong>—</strong><span>—</span></div>
            <div className="positionRow"><span>Account positions remain demo until authenticated Binance account integration is added.</span></div>
          </div>
        </section>
      </div>
    </div>
  );
}
