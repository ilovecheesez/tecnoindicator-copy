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
  try {
    const kiloStatus = await kiloRouter.getKiloStatus();
    const tinyfishStatus = await tinyfishRouter.getTinyfishStatus();

    const globalAnalytics = await getGlobalAnalytics();
    const regionalAnalytics: Record<Region, { lastFetch: string | null; success: boolean }> = {} as Record<
      Region,
      { lastFetch: string | null; success: boolean }
    >;

    for (const region of Object.keys(REGION_NAMES) as Region[]) {
      try {
        await getRegionalAnalytics(region);
        regionalAnalytics[region] = {
          lastFetch: new Date().toISOString(),
          success: true,
        };
      } catch {
        regionalAnalytics[region] = {
          lastFetch: null,
          success: false,
        };
      }
    }

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
          lastFetch: globalAnalytics.timestamp,
          success: true,
        },
        regional: regionalAnalytics,
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
    }, { status: 503 });
  }
}