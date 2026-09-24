import { REGION_NAMES, type Region } from "./_shared/regions.js";
import { getGlobalAnalytics, getRegionalAnalytics } from "./_shared/deterministicAnalytics.js";
import { kiloRouter } from "./_shared/kiloRouter.js";
import { tinyfishRouter } from "./_shared/tinyfishRouter.js";

interface HealthResponse {
  kiloGateway: {
    available: boolean;
    usableKeys: number;
  };
  tinyfish: {
    available: boolean;
    usableKeys: number;
  };
  onlineModelConnected: boolean;
  analytics: {
    global: {
      lastFetch: string | null;
      success: boolean;
    };
    regional: Record<
      Region,
      {
        lastFetch: string | null;
        success: boolean;
      }
    >;
  };
  dynamicFactors: {
    global: {
      lastRun: string | null;
      nextRun: string | null;
      aiCurated: boolean;
      pollIntervalMs: number;
    };
    regional: Record<
      Region,
      {
        lastRun: string | null;
        nextRun: string | null;
        aiCurated: boolean;
        pollIntervalMs: number;
      }
    >;
  };
}

export default async function handler(_req: Request): Promise<Response> {
  // Global abort controller for the entire health check with 7s total budget
  // Leaves 3s buffer for Vercel's 10s default timeout (or 23s buffer for 30s maxDuration)
  const abortController = new AbortController();
  const totalTimeoutId = setTimeout(() => abortController.abort(), 7000);

  try {
    // Run all checks in parallel with the same abort signal
    // Each check has built-in timeout logic that respects the abort signal
    const [kiloStatus, tinyfishStatus, analyticsResult] = await Promise.all([
      kiloRouter.getKiloStatus(abortController.signal),
      tinyfishRouter.getTinyfishStatus(abortController.signal),
      (async () => {
        // Run global and regional analytics in PARALLEL
        const globalAnalyticsPromise = getGlobalAnalytics();
        const regionalAnalyticsPromises = Object.keys(REGION_NAMES).map(
          (region) =>
            getRegionalAnalytics(region as Region).then((analytics) => ({
              region: region as Region,
              result: analytics,
            }))
        );

        try {
          const [globalAnalytics, regionalResults] = await Promise.all([
            globalAnalyticsPromise,
            Promise.race([
                Promise.all(regionalAnalyticsPromises).then((results) =>
                Object.fromEntries(
                  results.map(({ region, result }) => [region, result])
                )
              ),
              new Promise<{}>((_resolve, reject) =>
                setTimeout(() => reject(new Error("Regional analytics timeout")), 5000)
              )
            ]),
          ]);

          const regionalAnalytics = regionalResults as Record<
            Region,
            { lastFetch: string | null; success: boolean }
          >;

          // Build the proper structure
          const result: Record<Region, { lastFetch: string | null; success: boolean }> =
            {} as Record<Region, { lastFetch: string | null; success: boolean }>;
          for (const region of Object.keys(REGION_NAMES) as Region[]) {
            if (regionalAnalytics[region]) {
              result[region] = {
                lastFetch: new Date().toISOString(),
                success: true,
              };
            } else {
              result[region] = { lastFetch: null, success: false };
            }
          }

          return { globalAnalytics, regionalAnalytics: result };
        } catch (e) {
          // Return null values on timeout/error
          const result: Record<Region, { lastFetch: string | null; success: boolean }> =
            {} as Record<Region, { lastFetch: string | null; success: boolean }>;
          for (const region of Object.keys(REGION_NAMES) as Region[]) {
            result[region] = { lastFetch: null, success: false };
          }
          return { globalAnalytics: { timestamp: null, fuelLevy: 0, electricityTariffAdjustmentIndex: 0, waterScarcityAdjustedPriceIndex: 0, dataSource: "", isLive: false }, regionalAnalytics: result };
        }
      })()
    ]);

    const onlineModelConnected =
      kiloStatus.available &&
      kiloStatus.usableKeys > 0 &&
      kiloStatus.zeroCostModels.length > 0 &&
      tinyfishStatus.available &&
      tinyfishStatus.usableKeys > 0;

    const response: HealthResponse = {
      kiloGateway: {
        available: kiloStatus.available,
        usableKeys: kiloStatus.usableKeys,
      },
      tinyfish: {
        available: tinyfishStatus.available,
        usableKeys: tinyfishStatus.usableKeys,
      },
      onlineModelConnected,
      analytics: {
        global: {
          lastFetch: analyticsResult.globalAnalytics.timestamp,
          success: !!analyticsResult.globalAnalytics.timestamp,
        },
        regional: analyticsResult.regionalAnalytics,
      },
      dynamicFactors: {
        global: {
          lastRun: null,
          nextRun: null,
          aiCurated: false,
          pollIntervalMs: 120000,
        },
        regional: Object.fromEntries(
          (Object.keys(REGION_NAMES) as Region[]).map((region) => [
            region,
            {
              lastRun: null,
              nextRun: null,
              aiCurated: false,
              pollIntervalMs: 120000,
            },
          ])
        ) as Record<
          Region,
          {
            lastRun: string | null;
            nextRun: string | null;
            aiCurated: boolean;
            pollIntervalMs: number;
          }
        >,
      },
    };

    return Response.json(response);
  } catch (error) {
    console.error("Health check failed:", error);
    return Response.json({
      error: "Health check temporarily unavailable",
      onlineModelConnected: false,
      kiloGateway: { available: false, usableKeys: 0 },
      tinyfish: { available: false, usableKeys: 0 },
    }, { status: 200 });
  } finally {
    clearTimeout(totalTimeoutId);
  }
}