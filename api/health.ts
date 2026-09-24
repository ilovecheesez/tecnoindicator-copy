import { REGION_NAMES, type Region } from "./_shared/regions.js";
import { getGlobalAnalytics, getRegionalAnalytics } from "./_shared/deterministicAnalytics.js";
import { kiloRouter } from "./_shared/kiloRouter.js";
import { tinyfishRouter } from "./_shared/tinyfishRouter.js";

type KiloStatusLike = {
  available: boolean;
  usableKeys: number;
  zeroCostModels: string[];
};

type TinyfishStatusLike = {
  available: boolean;
  usableKeys: number;
};

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
    // Run all checks in PARALLEL with per-check timeouts so the health endpoint
    // never exceeds Vercel's 10s serverless function timeout.
    // Total budget: 7s (leaves 3s buffer for serialization/Vercel overhead).

    const kiloPromise = Promise.race([
      kiloRouter.getKiloStatus(),
      new Promise<KiloStatusLike>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Kilo status timeout")), 4000)
      ),
    ]).catch((err) => {
      console.error("Kilo status error:", (err as Error).message ?? err);
      return { available: false, usableKeys: 0, zeroCostModels: [] as string[] };
    });

    const tinyfishPromise = Promise.race([
      tinyfishRouter.getTinyfishStatus(),
      new Promise<TinyfishStatusLike>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Tinyfish status timeout")), 4000)
      ),
    ]).catch((err) => {
      console.error("Tinyfish status error:", (err as Error).message ?? err);
      return { available: false, usableKeys: 0 };
    });

    const analyticsPromise = Promise.race([
      (async () => {
        const globalAnalytics = await Promise.race([
          getGlobalAnalytics(),
          new Promise<{ timestamp: string | null }>((_resolve, reject) =>
            setTimeout(() => reject(new Error("Global analytics timeout")), 3000)
          ),
        ]).catch(() => ({ timestamp: null as string | null }));

        const regionalAnalytics: Record<Region, { lastFetch: string | null; success: boolean }> =
          {} as Record<Region, { lastFetch: string | null; success: boolean }>;
        for (const region of Object.keys(REGION_NAMES) as Region[]) {
          try {
            await Promise.race([
              getRegionalAnalytics(region),
              new Promise<void>(
                (_resolve, reject) =>
                  setTimeout(() => reject(new Error("Regional analytics timeout")), 2000)
              ),
            ]);
            regionalAnalytics[region] = { lastFetch: new Date().toISOString(), success: true };
          } catch {
            regionalAnalytics[region] = { lastFetch: null, success: false };
          }
        }
        return { globalAnalytics, regionalAnalytics };
      })(),
      new Promise<never>((_resolve, reject) =>
        setTimeout(() => reject(new Error("Analytics timeout")), 6000)
      ),
    ]).catch((err) => {
      console.error("Analytics error:", (err as Error).message ?? err);
      return {
        globalAnalytics: { timestamp: null as string | null },
        regionalAnalytics: Object.fromEntries(
          (Object.keys(REGION_NAMES) as Region[]).map((r) => [
            r,
            { lastFetch: null as string | null, success: false },
          ])
        ) as Record<Region, { lastFetch: string | null; success: boolean }>,
      };
    });

    // All three run in parallel; longest individual timeout is 6s.
    const [kiloStatus, tinyfishStatus, analyticsResult] = await Promise.all([
      kiloPromise,
      tinyfishPromise,
      analyticsPromise,
    ]);

    const globalAnalytics = analyticsResult.globalAnalytics;
    const regionalAnalytics = analyticsResult.regionalAnalytics;

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
          success: !!globalAnalytics.timestamp,
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
      kiloGateway: { available: false, usableKeys: 0 },
      tinyfish: { available: false, usableKeys: 0 },
    }, { status: 200 });
  }
}
