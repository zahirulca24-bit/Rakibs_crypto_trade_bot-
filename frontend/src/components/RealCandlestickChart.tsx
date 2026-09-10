"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  CandlestickSeries,
  ColorType,
  HistogramSeries,
  LineSeries,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type LogicalRange,
  type Time,
} from "lightweight-charts";

export type ChartCandle = {
  open_time: number;
  open: string;
  high: string;
  low: string;
  close: string;
};

type Props = {
  candles: ChartCandle[];
};

type NumericPoint = { time: Time; value: number };
type MacdPoint = NumericPoint & { histogram: number };
type EmaPeriod = 9 | 20 | 21 | 50 | 200;

const EMA_PERIODS: EmaPeriod[] = [9, 20, 21, 50, 200];

const chartBaseOptions = {
  autoSize: true,
  layout: {
    background: { type: ColorType.Solid as const, color: "#0b1118" },
    textColor: "#8ea0b8",
    fontSize: 11,
  },
  grid: {
    vertLines: { color: "#151e29" },
    horzLines: { color: "#151e29" },
  },
  rightPriceScale: {
    borderColor: "#263242",
    scaleMargins: { top: 0.08, bottom: 0.08 },
  },
  timeScale: {
    borderColor: "#263242",
    timeVisible: true,
    secondsVisible: false,
    rightOffset: 5,
    barSpacing: 7,
    minBarSpacing: 2,
  },
  crosshair: { mode: 0 },
  handleScroll: true,
  handleScale: true,
};

function ema(values: number[], period: number) {
  if (!values.length) return [];
  const multiplier = 2 / (period + 1);
  const result = [values[0]];
  for (let i = 1; i < values.length; i += 1) {
    result.push((values[i] - result[i - 1]) * multiplier + result[i - 1]);
  }
  return result;
}

function rsi(values: number[], period = 14) {
  const result: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period) return result;

  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const change = values[i] - values[i - 1];
    gains += Math.max(change, 0);
    losses += Math.max(-change, 0);
  }

  let avgGain = gains / period;
  let avgLoss = losses / period;
  result[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);

  for (let i = period + 1; i < values.length; i += 1) {
    const change = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(change, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-change, 0)) / period;
    result[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return result;
}

function formatValue(value: number | undefined, digits = 2) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

const indicatorButtonStyle = (active: boolean) => ({
  border: `1px solid ${active ? "#4f6b8a" : "#263242"}`,
  background: active ? "#162231" : "#0b1118",
  color: active ? "#e6edf6" : "#75869a",
  borderRadius: 6,
  padding: "5px 9px",
  fontSize: 11,
  cursor: "pointer",
});

export default function RealCandlestickChart({ candles }: Props) {
  const priceContainerRef = useRef<HTMLDivElement | null>(null);
  const rsiContainerRef = useRef<HTMLDivElement | null>(null);
  const macdContainerRef = useRef<HTMLDivElement | null>(null);

  const priceChartRef = useRef<IChartApi | null>(null);
  const rsiChartRef = useRef<IChartApi | null>(null);
  const macdChartRef = useRef<IChartApi | null>(null);

  const candleSeriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const emaSeriesRefs = useRef<Record<number, ISeriesApi<"Line"> | null>>({});
  const rsiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const signalSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const histogramSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const [showRsi, setShowRsi] = useState(true);
  const [showMacd, setShowMacd] = useState(true);
  const [visibleEmas, setVisibleEmas] = useState<Record<EmaPeriod, boolean>>({
    9: true,
    20: true,
    21: true,
    50: true,
    200: true,
  });

  const indicators = useMemo(() => {
    const closes = candles.map((candle) => Number(candle.close));
    const times = candles.map((candle) => Math.floor(candle.open_time / 1000) as Time);
    const emas = Object.fromEntries(EMA_PERIODS.map((period) => [period, ema(closes, period)])) as Record<number, number[]>;

    const rsiValues = rsi(closes, 14);
    const ema12 = ema(closes, 12);
    const ema26 = ema(closes, 26);
    const macd = closes.map((_, index) => ema12[index] - ema26[index]);
    const signal = ema(macd, 9);
    const macdPoints: MacdPoint[] = times.map((time, index) => ({
      time,
      value: macd[index],
      histogram: macd[index] - signal[index],
    }));

    return { times, emas, rsiValues, macd, signal, macdPoints };
  }, [candles]);

  useEffect(() => {
    if (!priceContainerRef.current || !rsiContainerRef.current || !macdContainerRef.current) return;

    const priceChart = createChart(priceContainerRef.current, {
      ...chartBaseOptions,
      timeScale: { ...chartBaseOptions.timeScale, visible: false },
    });
    const rsiChart = createChart(rsiContainerRef.current, {
      ...chartBaseOptions,
      rightPriceScale: {
        ...chartBaseOptions.rightPriceScale,
        autoScale: false,
        scaleMargins: { top: 0.08, bottom: 0.08 },
      },
      timeScale: { ...chartBaseOptions.timeScale, visible: false },
    });
    const macdChart = createChart(macdContainerRef.current, chartBaseOptions);

    const candleSeries = priceChart.addSeries(CandlestickSeries, {
      upColor: "#2ed6a1",
      downColor: "#ff5c72",
      borderVisible: false,
      wickUpColor: "#2ed6a1",
      wickDownColor: "#ff5c72",
      priceLineVisible: true,
      lastValueVisible: true,
    });

    const emaConfig = [
      [9, "#f6c85f", 2],
      [20, "#56cfe1", 1],
      [21, "#7f9cf5", 2],
      [50, "#c084fc", 2],
      [200, "#f97316", 2],
    ] as const;

    for (const [period, color, lineWidth] of emaConfig) {
      emaSeriesRefs.current[period] = priceChart.addSeries(LineSeries, {
        color,
        lineWidth,
        priceLineVisible: false,
        lastValueVisible: false,
        crosshairMarkerVisible: false,
      });
    }

    const rsiSeries = rsiChart.addSeries(LineSeries, {
      color: "#a78bfa",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
      crosshairMarkerVisible: false,
    });
    rsiSeries.createPriceLine({ price: 70, color: "#5b2b35", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "70" });
    rsiSeries.createPriceLine({ price: 30, color: "#214a42", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "30" });

    const macdSeries = macdChart.addSeries(LineSeries, {
      color: "#60a5fa",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    const signalSeries = macdChart.addSeries(LineSeries, {
      color: "#f59e0b",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    const histogramSeries = macdChart.addSeries(HistogramSeries, {
      priceLineVisible: false,
      lastValueVisible: false,
      priceFormat: { type: "price", precision: 4, minMove: 0.0001 },
    });

    priceChartRef.current = priceChart;
    rsiChartRef.current = rsiChart;
    macdChartRef.current = macdChart;
    candleSeriesRef.current = candleSeries;
    rsiSeriesRef.current = rsiSeries;
    macdSeriesRef.current = macdSeries;
    signalSeriesRef.current = signalSeries;
    histogramSeriesRef.current = histogramSeries;

    let syncing = false;
    const syncRange = (targets: IChartApi[]) => (range: LogicalRange | null) => {
      if (!range || syncing) return;
      syncing = true;
      for (const target of targets) target.timeScale().setVisibleLogicalRange(range);
      syncing = false;
    };

    const priceSync = syncRange([rsiChart, macdChart]);
    const rsiSync = syncRange([priceChart, macdChart]);
    const macdSync = syncRange([priceChart, rsiChart]);
    priceChart.timeScale().subscribeVisibleLogicalRangeChange(priceSync);
    rsiChart.timeScale().subscribeVisibleLogicalRangeChange(rsiSync);
    macdChart.timeScale().subscribeVisibleLogicalRangeChange(macdSync);

    return () => {
      priceChart.remove();
      rsiChart.remove();
      macdChart.remove();
      priceChartRef.current = null;
      rsiChartRef.current = null;
      macdChartRef.current = null;
      candleSeriesRef.current = null;
      emaSeriesRefs.current = {};
      rsiSeriesRef.current = null;
      macdSeriesRef.current = null;
      signalSeriesRef.current = null;
      histogramSeriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    for (const period of EMA_PERIODS) {
      emaSeriesRefs.current[period]?.applyOptions({ visible: visibleEmas[period] });
    }
  }, [visibleEmas]);

  useEffect(() => {
    const candleSeries = candleSeriesRef.current;
    if (!candleSeries) return;

    const candleData: CandlestickData<Time>[] = candles.map((candle) => ({
      time: Math.floor(candle.open_time / 1000) as Time,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
    }));
    candleSeries.setData(candleData);

    for (const period of EMA_PERIODS) {
      const series = emaSeriesRefs.current[period];
      if (!series) continue;
      const data: LineData<Time>[] = indicators.times.map((time, index) => ({
        time,
        value: indicators.emas[period][index],
      }));
      series.setData(data);
    }

    const rsiData: LineData<Time>[] = indicators.times.flatMap((time, index) => {
      const value = indicators.rsiValues[index];
      return value === null ? [] : [{ time, value }];
    });
    rsiSeriesRef.current?.setData(rsiData);

    const macdData: LineData<Time>[] = indicators.times.map((time, index) => ({ time, value: indicators.macd[index] }));
    const signalData: LineData<Time>[] = indicators.times.map((time, index) => ({ time, value: indicators.signal[index] }));
    const histogramData: HistogramData<Time>[] = indicators.macdPoints.map((point) => ({
      time: point.time,
      value: point.histogram,
      color: point.histogram >= 0 ? "rgba(46, 214, 161, 0.55)" : "rgba(255, 92, 114, 0.55)",
    }));
    macdSeriesRef.current?.setData(macdData);
    signalSeriesRef.current?.setData(signalData);
    histogramSeriesRef.current?.setData(histogramData);

    if (candleData.length) {
      priceChartRef.current?.timeScale().fitContent();
      rsiChartRef.current?.timeScale().fitContent();
      macdChartRef.current?.timeScale().fitContent();
    }
  }, [candles, indicators]);

  useEffect(() => {
    window.setTimeout(() => {
      priceChartRef.current?.timeScale().fitContent();
      if (showRsi) rsiChartRef.current?.timeScale().fitContent();
      if (showMacd) macdChartRef.current?.timeScale().fitContent();
    }, 0);
  }, [showRsi, showMacd]);

  const lastIndex = candles.length - 1;
  const latestRsi = lastIndex >= 0 ? indicators.rsiValues[lastIndex] ?? undefined : undefined;
  const latestMacd = lastIndex >= 0 ? indicators.macd[lastIndex] : undefined;
  const latestSignal = lastIndex >= 0 ? indicators.signal[lastIndex] : undefined;

  const toggleEma = (period: EmaPeriod) => {
    setVisibleEmas((current) => ({ ...current, [period]: !current[period] }));
  };

  return (
    <div style={{ width: "100%", background: "#0b1118" }}>
      <div style={{ padding: "8px 12px", borderBottom: "1px solid #1c2734", display: "flex", gap: 7, flexWrap: "wrap", alignItems: "center" }}>
        <strong style={{ fontSize: 11, color: "#dfe7f1", marginRight: 4 }}>Indicators</strong>
        {EMA_PERIODS.map((period) => (
          <button key={period} type="button" onClick={() => toggleEma(period)} style={indicatorButtonStyle(visibleEmas[period])}>
            EMA {period}
          </button>
        ))}
        <button type="button" onClick={() => setShowRsi((value) => !value)} style={indicatorButtonStyle(showRsi)}>
          RSI 14
        </button>
        <button type="button" onClick={() => setShowMacd((value) => !value)} style={indicatorButtonStyle(showMacd)}>
          MACD 12·26·9
        </button>
      </div>

      <div style={{ padding: "7px 12px", borderBottom: "1px solid #1c2734", display: "flex", gap: 14, flexWrap: "wrap", fontSize: 11 }}>
        {EMA_PERIODS.filter((period) => visibleEmas[period]).map((period) => (
          <span key={period} style={{ color: "#9cafc3" }}>
            EMA {period} <strong>{formatValue(indicators.emas[period]?.[lastIndex])}</strong>
          </span>
        ))}
      </div>

      <div ref={priceContainerRef} style={{ width: "100%", height: 430 }} />

      <div style={{ borderTop: "1px solid #1c2734", display: showRsi ? "block" : "none" }}>
        <div style={{ padding: "6px 12px", fontSize: 11, color: "#9cafc3", display: "flex", gap: 12 }}>
          <strong style={{ color: "#dfe7f1" }}>RSI (14)</strong>
          <span>{formatValue(latestRsi)}</span>
          <span style={{ color: "#6f8198" }}>70 overbought · 30 oversold</span>
        </div>
        <div ref={rsiContainerRef} style={{ width: "100%", height: 150 }} />
      </div>

      <div style={{ borderTop: "1px solid #1c2734", position: "relative", display: showMacd ? "block" : "none" }}>
        <div style={{ padding: "6px 12px", fontSize: 11, color: "#9cafc3", display: "flex", gap: 12, flexWrap: "wrap" }}>
          <strong style={{ color: "#dfe7f1" }}>MACD (12, 26, 9)</strong>
          <span>MACD {formatValue(latestMacd, 4)}</span>
          <span>Signal {formatValue(latestSignal, 4)}</span>
          <span>Hist {formatValue(latestMacd !== undefined && latestSignal !== undefined ? latestMacd - latestSignal : undefined, 4)}</span>
        </div>
        <div ref={macdContainerRef} style={{ width: "100%", height: 180 }} />
        <a
          href="https://www.tradingview.com/"
          target="_blank"
          rel="noreferrer"
          style={{ position: "absolute", left: 10, bottom: 8, fontSize: 10, color: "#6f8198", textDecoration: "none", zIndex: 2 }}
        >
          Charting by TradingView
        </a>
      </div>
    </div>
  );
}
