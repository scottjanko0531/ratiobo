"use client";
import { useEffect, useRef } from "react";

const SYMBOLS =
  "FOREXCOM:SPXUSD,CMCMARKETS:GOLD,EASYMARKETS:OILUSD,AMEX:VTI,AMEX:VWO,NASDAQ:VXUS,NASDAQ:PDBC,TVC:SILVER,COINBASE:BTCUSD,AMEX:GLD";

export default function TickerBanner() {
  const ref = useRef(null);

  useEffect(() => {
    if (!document.querySelector('script[data-tv-ticker-tape]')) {
      const s = document.createElement("script");
      s.type = "module";
      s.src = "https://widgets.tradingview-widget.com/w/en/tv-ticker-tape.js";
      s.dataset.tvTickerTape = "1";
      document.head.appendChild(s);
    }
    if (ref.current) {
      ref.current.setAttribute("symbols", SYMBOLS);
      ref.current.setAttribute("hide-chart", "");
    }
  }, []);

  return <tv-ticker-tape ref={ref} />;
}
