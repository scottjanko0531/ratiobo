"use client";
import { useEffect, useRef } from "react";

const SYMBOLS =
  "FOREXCOM:SPXUSD,BITSTAMP:BTCUSD,EASYMARKETS:OILUSD,AMEX:GLD,NASDAQ:PDBC,AMEX:VTI,AMEX:VWO,NASDAQ:VXUS,10-TVC:US10Y,2-TVC:US02Y,TVC:GOLD";

export default function TickerBanner() {
  const ref = useRef(null);

  useEffect(() => {
    if (!document.querySelector('script[data-tv-tickers]')) {
      const s = document.createElement("script");
      s.type = "module";
      s.src = "https://widgets.tradingview-widget.com/w/en/tv-tickers.js";
      s.dataset.tvTickers = "1";
      document.head.appendChild(s);
    }
    if (ref.current) {
      ref.current.setAttribute("symbols", SYMBOLS);
      ref.current.setAttribute("hide-chart", "");
      ref.current.setAttribute("hover-type", "chart-performance-grid");
      ref.current.setAttribute("show-hover", "");
    }
  }, []);

  return <tv-tickers ref={ref} />;
}
