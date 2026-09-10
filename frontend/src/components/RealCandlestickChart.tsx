"use client";

import { useEffect, useRef } from "react";
import {
  CandlestickSeries,
  ColorType,
  createChart,
  type CandlestickData,
  type IChartApi,
  type ISeriesApi,
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

export default function RealCandlestickChart({ candles }: Props) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);

  useEffect(() => {
    if (!containerRef.current) return;

    const chart = createChart(containerRef.current, {
      autoSize: true,
      attributionLogo: true,
      layout: {
        background: { type: ColorType.Solid, color: "#0b1118" },
        textColor: "#8ea0b8",
      },
      grid: {
        vertLines: { color: "#17202b" },
        horzLines: { color: "#17202b" },
      },
      rightPriceScale: {
        borderColor: "#263242",
      },
      timeScale: {
        borderColor: "#263242",
        timeVisible: true,
        secondsVisible: false,
        rightOffset: 4,
        barSpacing: 8,
      },
      crosshair: {
        mode: 0,
      },
      handleScroll: true,
      handleScale: true,
    });

    const series = chart.addSeries(CandlestickSeries, {
      upColor: "#2ed6a1",
      downColor: "#ff5c72",
      borderVisible: false,
      wickUpColor: "#2ed6a1",
      wickDownColor: "#ff5c72",
    });

    chartRef.current = chart;
    seriesRef.current = series;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, []);

  useEffect(() => {
    const series = seriesRef.current;
    const chart = chartRef.current;
    if (!series || !chart) return;

    const data: CandlestickData<Time>[] = candles.map((candle) => ({
      time: Math.floor(candle.open_time / 1000) as Time,
      open: Number(candle.open),
      high: Number(candle.high),
      low: Number(candle.low),
      close: Number(candle.close),
    }));

    series.setData(data);
    if (data.length) chart.timeScale().fitContent();
  }, [candles]);

  return <div ref={containerRef} style={{ width: "100%", height: "100%", minHeight: 420 }} />;
}
