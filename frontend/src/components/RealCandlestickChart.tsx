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
  volume?: string;
};

type Props = { candles: ChartCandle[] };
type EmaPeriod = 9 | 20 | 21 | 50 | 200;
const EMA_PERIODS: EmaPeriod[] = [9, 20, 21, 50, 200];

const baseOptions = {
  autoSize: true,
  layout: {
    background: { type: ColorType.Solid as const, color: "#080d14" },
    textColor: "#8796aa",
    fontSize: 10,
  },
  grid: {
    vertLines: { color: "#121b26" },
    horzLines: { color: "#121b26" },
  },
  rightPriceScale: {
    borderColor: "#202b38",
    scaleMargins: { top: 0.08, bottom: 0.08 },
  },
  timeScale: {
    borderColor: "#202b38",
    timeVisible: true,
    secondsVisible: false,
    rightOffset: 4,
    barSpacing: 7,
    minBarSpacing: 2,
  },
  crosshair: { mode: 0 },
  handleScroll: true,
  handleScale: true,
};

function ema(values: number[], period: number) {
  if (!values.length) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i += 1) out.push((values[i] - out[i - 1]) * k + out[i - 1]);
  return out;
}

function rsi(values: number[], period = 14) {
  const out: Array<number | null> = Array(values.length).fill(null);
  if (values.length <= period) return out;
  let gains = 0;
  let losses = 0;
  for (let i = 1; i <= period; i += 1) {
    const d = values[i] - values[i - 1];
    gains += Math.max(d, 0);
    losses += Math.max(-d, 0);
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  for (let i = period + 1; i < values.length; i += 1) {
    const d = values[i] - values[i - 1];
    avgGain = (avgGain * (period - 1) + Math.max(d, 0)) / period;
    avgLoss = (avgLoss * (period - 1) + Math.max(-d, 0)) / period;
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
  }
  return out;
}

function fmt(value: number | undefined, digits = 2) {
  if (value === undefined || !Number.isFinite(value)) return "—";
  return value.toLocaleString(undefined, { maximumFractionDigits: digits });
}

function toggleStyle(active: boolean) {
  return {
    border: `1px solid ${active ? "#365270" : "#253140"}`,
    background: active ? "#132131" : "#0a1018",
    color: active ? "#e7edf5" : "#718196",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 10,
    cursor: "pointer",
  } as const;
}

export default function RealCandlestickChart({ candles }: Props) {
  const priceEl = useRef<HTMLDivElement | null>(null);
  const volumeEl = useRef<HTMLDivElement | null>(null);
  const rsiEl = useRef<HTMLDivElement | null>(null);
  const macdEl = useRef<HTMLDivElement | null>(null);

  const priceChart = useRef<IChartApi | null>(null);
  const volumeChart = useRef<IChartApi | null>(null);
  const rsiChart = useRef<IChartApi | null>(null);
  const macdChart = useRef<IChartApi | null>(null);

  const candlesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const emaRefs = useRef<Record<number, ISeriesApi<"Line"> | null>>({});
  const rsiRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdRef = useRef<ISeriesApi<"Line"> | null>(null);
  const signalRef = useRef<ISeriesApi<"Line"> | null>(null);
  const histRef = useRef<ISeriesApi<"Histogram"> | null>(null);

  const [showVolume, setShowVolume] = useState(true);
  const [showRsi, setShowRsi] = useState(true);
  const [showMacd, setShowMacd] = useState(true);
  const [visibleEmas, setVisibleEmas] = useState<Record<EmaPeriod, boolean>>({
    9: true, 20: true, 21: true, 50: true, 200: true,
  });

  const calc = useMemo(() => {
    const closes = candles.map((c) => Number(c.close));
    const times = candles.map((c) => Math.floor(c.open_time / 1000) as Time);
    const emas = Object.fromEntries(EMA_PERIODS.map((p) => [p, ema(closes, p)])) as Record<number, number[]>;
    const rsi14 = rsi(closes, 14);
    const e12 = ema(closes, 12);
    const e26 = ema(closes, 26);
    const macd = closes.map((_, i) => e12[i] - e26[i]);
    const signal = ema(macd, 9);
    return { times, emas, rsi14, macd, signal };
  }, [candles]);

  useEffect(() => {
    if (!priceEl.current || !volumeEl.current || !rsiEl.current || !macdEl.current) return;

    const p = createChart(priceEl.current, { ...baseOptions, timeScale: { ...baseOptions.timeScale, visible: false } });
    const v = createChart(volumeEl.current, { ...baseOptions, timeScale: { ...baseOptions.timeScale, visible: false } });
    const r = createChart(rsiEl.current, { ...baseOptions, timeScale: { ...baseOptions.timeScale, visible: false } });
    const m = createChart(macdEl.current, baseOptions);

    candlesRef.current = p.addSeries(CandlestickSeries, {
      upColor: "#35c77b", downColor: "#ea4d5b", borderVisible: false,
      wickUpColor: "#35c77b", wickDownColor: "#ea4d5b", priceLineVisible: true, lastValueVisible: true,
    });

    const emaConfig = [
      [9, "#e6b72e", 2], [20, "#62a6d5", 1], [21, "#8aa4ff", 2], [50, "#d06bb7", 2], [200, "#f47a22", 2],
    ] as const;
    for (const [period, color, lineWidth] of emaConfig) {
      emaRefs.current[period] = p.addSeries(LineSeries, {
        color, lineWidth, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
      });
    }

    volumeRef.current = v.addSeries(HistogramSeries, {
      priceFormat: { type: "volume" }, priceLineVisible: false, lastValueVisible: false,
    });

    rsiRef.current = r.addSeries(LineSeries, {
      color: "#b45ca8", lineWidth: 2, priceLineVisible: false, lastValueVisible: true, crosshairMarkerVisible: false,
    });
    rsiRef.current.createPriceLine({ price: 70, color: "#4b3039", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "70" });
    rsiRef.current.createPriceLine({ price: 30, color: "#24453d", lineWidth: 1, lineStyle: 2, axisLabelVisible: true, title: "30" });

    macdRef.current = m.addSeries(LineSeries, {
      color: "#62a6d5", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    signalRef.current = m.addSeries(LineSeries, {
      color: "#e6b72e", lineWidth: 2, priceLineVisible: false, lastValueVisible: false, crosshairMarkerVisible: false,
    });
    histRef.current = m.addSeries(HistogramSeries, { priceLineVisible: false, lastValueVisible: false });

    priceChart.current = p; volumeChart.current = v; rsiChart.current = r; macdChart.current = m;

    let syncing = false;
    const sync = (targets: IChartApi[]) => (range: LogicalRange | null) => {
      if (!range || syncing) return;
      syncing = true;
      targets.forEach((chart) => chart.timeScale().setVisibleLogicalRange(range));
      syncing = false;
    };
    p.timeScale().subscribeVisibleLogicalRangeChange(sync([v, r, m]));
    v.timeScale().subscribeVisibleLogicalRangeChange(sync([p, r, m]));
    r.timeScale().subscribeVisibleLogicalRangeChange(sync([p, v, m]));
    m.timeScale().subscribeVisibleLogicalRangeChange(sync([p, v, r]));

    return () => {
      p.remove(); v.remove(); r.remove(); m.remove();
      priceChart.current = null; volumeChart.current = null; rsiChart.current = null; macdChart.current = null;
      candlesRef.current = null; volumeRef.current = null; emaRefs.current = {}; rsiRef.current = null;
      macdRef.current = null; signalRef.current = null; histRef.current = null;
    };
  }, []);

  useEffect(() => {
    const candleData: CandlestickData<Time>[] = candles.map((c) => ({
      time: Math.floor(c.open_time / 1000) as Time,
      open: Number(c.open), high: Number(c.high), low: Number(c.low), close: Number(c.close),
    }));
    candlesRef.current?.setData(candleData);

    EMA_PERIODS.forEach((period) => {
      emaRefs.current[period]?.setData(calc.times.map((time, i) => ({ time, value: calc.emas[period][i] })) as LineData<Time>[]);
    });

    volumeRef.current?.setData(candles.map((c, i) => ({
      time: Math.floor(c.open_time / 1000) as Time,
      value: Number(c.volume ?? 0),
      color: Number(c.close) >= Number(c.open) ? "rgba(53,199,123,.50)" : "rgba(234,77,91,.50)",
    })) as HistogramData<Time>[]);

    rsiRef.current?.setData(calc.times.flatMap((time, i) => calc.rsi14[i] == null ? [] : [{ time, value: calc.rsi14[i] as number }]) as LineData<Time>[]);
    macdRef.current?.setData(calc.times.map((time, i) => ({ time, value: calc.macd[i] })) as LineData<Time>[]);
    signalRef.current?.setData(calc.times.map((time, i) => ({ time, value: calc.signal[i] })) as LineData<Time>[]);
    histRef.current?.setData(calc.times.map((time, i) => ({
      time,
      value: calc.macd[i] - calc.signal[i],
      color: calc.macd[i] - calc.signal[i] >= 0 ? "rgba(53,199,123,.55)" : "rgba(234,77,91,.55)",
    })) as HistogramData<Time>[]);

    if (candleData.length) [priceChart.current, volumeChart.current, rsiChart.current, macdChart.current].forEach((c) => c?.timeScale().fitContent());
  }, [candles, calc]);

  useEffect(() => {
    EMA_PERIODS.forEach((p) => emaRefs.current[p]?.applyOptions({ visible: visibleEmas[p] }));
  }, [visibleEmas]);

  useEffect(() => {
    const t = window.setTimeout(() => {
      [priceChart.current, volumeChart.current, rsiChart.current, macdChart.current].forEach((c) => c?.timeScale().fitContent());
    }, 50);
    return () => window.clearTimeout(t);
  }, [showVolume, showRsi, showMacd]);

  const last = candles.length - 1;
  const latestRsi = last >= 0 ? calc.rsi14[last] ?? undefined : undefined;
  const latestMacd = last >= 0 ? calc.macd[last] : undefined;
  const latestSignal = last >= 0 ? calc.signal[last] : undefined;
  const latestVolume = last >= 0 ? Number(candles[last]?.volume ?? 0) : undefined;

  return (
    <div style={{ width: "100%", background: "#080d14" }}>
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap", alignItems: "center", padding: "7px 10px", borderBottom: "1px solid #1b2531" }}>
        <strong style={{ fontSize: 10, marginRight: 4 }}>Indicators</strong>
        {EMA_PERIODS.map((p) => <button key={p} onClick={() => setVisibleEmas((s) => ({ ...s, [p]: !s[p] }))} style={toggleStyle(visibleEmas[p])}>EMA {p}</button>)}
        <button onClick={() => setShowVolume((v) => !v)} style={toggleStyle(showVolume)}>VOL</button>
        <button onClick={() => setShowRsi((v) => !v)} style={toggleStyle(showRsi)}>RSI 14</button>
        <button onClick={() => setShowMacd((v) => !v)} style={toggleStyle(showMacd)}>MACD</button>
      </div>

      <div style={{ padding: "5px 10px", display: "flex", gap: 12, flexWrap: "wrap", fontSize: 10, borderBottom: "1px solid #151e29" }}>
        {EMA_PERIODS.filter((p) => visibleEmas[p]).map((p) => <span key={p}>EMA {p} <strong>{fmt(calc.emas[p]?.[last])}</strong></span>)}
      </div>
      <div ref={priceEl} style={{ width: "100%", height: 330 }} />

      <div style={{ display: showVolume ? "block" : "none", borderTop: "1px solid #1b2531" }}>
        <div style={{ padding: "4px 10px", fontSize: 10 }}><strong>VOLUME</strong> <span style={{ color: "#7f91a7" }}>{fmt(latestVolume, 3)}</span></div>
        <div ref={volumeEl} style={{ width: "100%", height: 85 }} />
      </div>

      <div style={{ display: showRsi ? "block" : "none", borderTop: "1px solid #1b2531" }}>
        <div style={{ padding: "4px 10px", fontSize: 10 }}><strong>RSI (14)</strong> <span style={{ color: "#b45ca8" }}>{fmt(latestRsi)}</span> <span style={{ color: "#697a8f" }}>70 overbought · 30 oversold</span></div>
        <div ref={rsiEl} style={{ width: "100%", height: 100 }} />
      </div>

      <div style={{ display: showMacd ? "block" : "none", borderTop: "1px solid #1b2531", position: "relative" }}>
        <div style={{ padding: "4px 10px", fontSize: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
          <strong>MACD (12,26,9)</strong><span>MACD {fmt(latestMacd, 4)}</span><span>Signal {fmt(latestSignal, 4)}</span><span>Hist {fmt(latestMacd !== undefined && latestSignal !== undefined ? latestMacd - latestSignal : undefined, 4)}</span>
        </div>
        <div ref={macdEl} style={{ width: "100%", height: 120 }} />
        <a href="https://www.tradingview.com/" target="_blank" rel="noreferrer" style={{ position: "absolute", left: 8, bottom: 5, fontSize: 9, color: "#65758a", textDecoration: "none" }}>Charting by TradingView</a>
      </div>
    </div>
  );
}
