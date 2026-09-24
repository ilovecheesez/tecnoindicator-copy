import { useCallback, useEffect, useRef, useState } from "react";
import {
  COMMODITIES,
  type CommodityId,
  type LiveWaterQuote,
} from "../lib/model";

function getDefaultPrices(): Record<CommodityId, number> {
  return Object.fromEntries(COMMODITIES.map((c) => [c.id, c.base])) as Record<CommodityId, number>;
}

export interface UseLiveMarketReturn {
  prices: Record<CommodityId, number>;
  jitter: number;
  lastUpdated: Date;
  waterLive: LiveWaterQuote | null;
  waterFetching: boolean;
  isLive: boolean;
  streaming: boolean;
  refresh: () => void;
  fetchWater: () => Promise<void>;
  toggleLive: () => void;
}

export function useLiveMarket(): UseLiveMarketReturn {
  const [prices, setPrices] = useState<Record<CommodityId, number>>(getDefaultPrices);
  const [jitter, setJitter] = useState(0);
  const [lastUpdated, setLastUpdated] = useState(() => new Date());
  const [waterLive] = useState<LiveWaterQuote | null>(null);
  const [waterFetching] = useState(false);
  const [isLive, setIsLive] = useState(true);
  const [streaming, setStreaming] = useState(true);
  const tickRef = useRef<number | null>(null);

  // Fetch prices from API
  const fetchPrices = useCallback(async (force = false) => {
    try {
      const url = force ? "/api/prices?force=true" : "/api/prices";
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const data = await res.json();
      setPrices({
        oil: data.oil.price,
        electricity: data.electricity.price,
        water: data.water.price,
      });
      setIsLive(data.isLive);
      setLastUpdated(new Date(data.asOf));
    } catch {
      setPrices(getDefaultPrices());
      setIsLive(false);
    }
  }, []);

  // Manual refresh - fetches with force=true
  const refresh = useCallback(() => {
    void fetchPrices(true);
  }, [fetchPrices]);

  // Water fetch kept for backward compatibility - now a no-op since water comes from API
  const fetchWater = useCallback(async () => {
    // No-op: water prices now come from /api/prices endpoint
    // Keeping function signature for backward compatibility
  }, []);

  const toggleLive = useCallback(() => {
    setIsLive((prev) => !prev);
  }, []);

  // Poll /api/prices every 60s when isLive is true
  useEffect(() => {
    const clear = () => {
      if (tickRef.current !== null) {
        clearInterval(tickRef.current);
        tickRef.current = null;
      }
    };

    const start = () => {
      clear();
      if (!isLive || document.hidden) {
        setStreaming(false);
        return;
      }
      setStreaming(true);
      tickRef.current = window.setInterval(() => {
        void fetchPrices();
        // Keep jitter for forecast model compatibility
        setJitter((j) => j + 0.01);
      }, 60_000);
    };

    start();

    const onVisibility = () => {
      if (document.hidden) {
        clear();
        setStreaming(false);
      } else if (isLive) {
        start();
      }
    };

    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      clear();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [isLive, fetchPrices]);

  // Initial fetch
  useEffect(() => {
    void fetchPrices();
    // Initial water fetch for backward compatibility
    void fetchWater();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    prices,
    jitter,
    lastUpdated,
    waterLive,
    waterFetching,
    isLive,
    streaming,
    refresh,
    fetchWater,
    toggleLive,
  };
}