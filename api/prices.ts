import { tinyfishRouter } from "./_shared/tinyfishRouter.js";
import { getCache, setCache } from "./_shared/cache.js";
import { SEARCH_CACHE_MS, sanitizeUrl } from "./_shared/http.js";
import {
  GLOBAL_DEFAULTS,
  REGIONAL_DEFAULTS,
  getGlobalAnalytics,
  getRegionalAnalytics,
} from "./_shared/deterministicAnalytics.js";
import { isRegion, type Region } from "./_shared/regions.js";
import type { RegionId } from "./_shared/types.js";

const OIL_QUERY_PREFIXES: Record<RegionId, string> = {
  global: "",
  asia: "[Asia] ",
  europe: "[Europe] ",
  africa: "[Africa] ",
  americas: "[Americas] ",
  oceania: "[Oceania] ",
};

const COMMODITY_QUERIES = [
  { commodity: "oil", queryTemplate: "Brent crude oil price 2026" },
  { commodity: "electricity", queryTemplate: "Global electricity wholesale price 2026" },
  { commodity: "water", queryTemplate: "Water price per cubic meter 2026" },
];

function extractPriceFromText(text: string): number | null {
  // Extract price numbers from text (look for patterns like $XX.XX, XX.XX USD, etc.)
  const pricePatterns = [
    /\$(\d+(?:\.\d+)?)/g, // $XX.XX
    /(\d+(?:\.\d+)?)\s*USD/g, // XX.XX USD
    /(\d+(?:\.\d+)?)\s*dollars?/gi, // XX.XX dollars
    /(\d+(?:\.\d+)?)\s*€/g, // XX.XX €
    /(\d+(?:\.\d+)?)\s*EUR/g, // XX.XX EUR
    /(\d+(?:\.\d+)?)\s*¥/g, // XX.XX ¥
    /(\d+(?:\.\d+)?)\s*元/g, // XX.XX 元
  ];

  for (const pattern of pricePatterns) {
    const matches = [...text.matchAll(pattern)];
    if (matches.length > 0) {
      // Take the first reasonable price (not too small or too large)
      for (const match of matches) {
        const price = parseFloat(match[1]);
        if (price >= 0.01 && price <= 10000) {
          return price;
        }
      }
    }
  }
  return null;
}

function getCommodityUnit(commodity: "oil" | "electricity" | "water"): string {
  switch (commodity) {
    case "oil":
      return "USD per barrel";
    case "electricity":
      return "USD per MWh";
    case "water":
      return "USD per cubic meter";
    default:
      return "USD";
  }
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "true";
    const regionParam = url.searchParams.get("region");
    const isGlobal = regionParam === null || regionParam === "";
    const scope: RegionId = isGlobal ? "global" : (isRegion(regionParam) ? regionParam : "global");
    const cacheKey = `live-prices:${scope}`;

    if (!force) {
      const cached = await getCache<{
        oil: { price: number; unit: string; source: string; isLive: boolean };
        electricity: { price: number; unit: string; source: string; isLive: boolean };
        water: { price: number; unit: string; source: string; isLive: boolean };
        asOf: string;
        dataSource: string;
        isLive: boolean;
      }>(cacheKey, SEARCH_CACHE_MS);
      if (cached) {
        return Response.json(cached, { status: 200 });
      }
    }

    // Initialize abort controller with 15s timeout
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 15000);

    try {
      // Try to get live prices from TinyFish
      const searchResults = await getLivePricesFromTinyFish(scope, abortController.signal);
      
      // If we got usable live prices, use them
      if (searchResults.isLive) {
        await setCache(cacheKey, searchResults, SEARCH_CACHE_MS);
        return Response.json(searchResults, { status: 200 });
      }
    } catch (error) {
      console.warn("TinyFish search failed, falling back to defaults:", error);
    } finally {
      clearTimeout(timeoutId);
    }

    // Fallback to deterministic defaults
    const analytics = scope === "global" ? await getGlobalAnalytics() : await getRegionalAnalytics(scope as Region);
    const fallbackPrices = scope === "global"
      ? {
          oil: GLOBAL_DEFAULTS.currentDieselPrice,
          electricity: GLOBAL_DEFAULTS.currentElectricityTariff,
          water: GLOBAL_DEFAULTS.currentWaterPrice,
        }
      : {
          oil: REGIONAL_DEFAULTS[scope as Region].diesel.current,
          electricity: REGIONAL_DEFAULTS[scope as Region].electricity.current,
          water: REGIONAL_DEFAULTS[scope as Region].water.current,
        };

    const fallbackResult = {
      oil: {
        price: fallbackPrices.oil,
        unit: "USD per barrel",
        source: analytics.dataSource,
        isLive: false,
      },
      electricity: {
        price: fallbackPrices.electricity,
        unit: "USD per MWh",
        source: analytics.dataSource,
        isLive: false,
      },
      water: {
        price: fallbackPrices.water,
        unit: "USD per cubic meter",
        source: analytics.dataSource,
        isLive: false,
      },
      asOf: new Date().toISOString(),
      dataSource: analytics.dataSource,
      isLive: false,
    };

    await setCache(cacheKey, fallbackResult, SEARCH_CACHE_MS);
    return Response.json(fallbackResult, { status: 200 });
  } catch (error) {
    console.error("Prices error:", error);
    return Response.json(
      { 
        error: "Prices temporarily unavailable",
        oil: { price: 0, unit: "USD per barrel", source: "error", isLive: false },
        electricity: { price: 0, unit: "USD per MWh", source: "error", isLive: false },
        water: { price: 0, unit: "USD per cubic meter", source: "error", isLive: false },
        asOf: new Date().toISOString(),
        dataSource: "error",
        isLive: false 
      }, 
      { status: 500 }
    );
  }
}

async function getLivePricesFromTinyFish(scope: RegionId, abortSignal: AbortSignal): Promise<{
  oil: { price: number; unit: string; source: string; isLive: boolean };
  electricity: { price: number; unit: string; source: string; isLive: boolean };
  water: { price: number; unit: string; source: string; isLive: boolean };
  asOf: string;
  dataSource: string;
  isLive: boolean;
}> {
  const prices: Record<string, { price: number | null; source: string }> = {
    oil: { price: null, source: "" },
    electricity: { price: null, source: "" },
    water: { price: null, source: "" },
  };

  const searchPromises = COMMODITY_QUERIES.map(async ({ commodity, queryTemplate }) => {
    const query = `${OIL_QUERY_PREFIXES[scope]}${queryTemplate}`;
    try {
      const result = await tinyfishRouter.tinyfishSearch(query, { limit: 10 }, abortSignal);
      
      // Extract price from search results
      for (const res of result.results) {
        const textToSearch = `${res.title} ${res.snippet}`;
        const price = extractPriceFromText(textToSearch);
        if (price !== null) {
          prices[commodity] = {
            price,
            source: sanitizeUrl(res.url) || res.url,
          };
          break; // Take first valid price
        }
      }
    } catch (error) {
      console.warn(`Failed to search for ${commodity}:`, error);
    }
  });

  await Promise.all(searchPromises);

  // Check if we got all three prices
  const allPricesFound = Object.values(prices).every(p => p.price !== null);
  
  if (allPricesFound) {
    return {
      oil: {
        price: prices.oil.price!,
        unit: getCommodityUnit("oil"),
        source: prices.oil.source,
        isLive: true,
      },
      electricity: {
        price: prices.electricity.price!,
        unit: getCommodityUnit("electricity"),
        source: prices.electricity.source,
        isLive: true,
      },
      water: {
        price: prices.water.price!,
        unit: getCommodityUnit("water"),
        source: prices.water.source,
        isLive: true,
      },
      asOf: new Date().toISOString(),
      dataSource: "TinyFish search",
      isLive: true,
    };
  } else {
    // Return not live signal if any price is missing
    return {
      oil: { price: 0, unit: "USD per barrel", source: "insufficient data", isLive: false },
      electricity: { price: 0, unit: "USD per MWh", source: "insufficient data", isLive: false },
      water: { price: 0, unit: "USD per cubic meter", source: "insufficient data", isLive: false },
      asOf: new Date().toISOString(),
      dataSource: "TinyFish search (insufficient data)",
      isLive: false,
    };
  }
}