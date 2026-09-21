import { kiloRouter } from "./_shared/kiloRouter.js";
import { getGlobalAnalytics, getRegionalAnalytics } from "./_shared/deterministicAnalytics.js";
import { FACTORS_CACHE_MS, SOLUTIONS_CACHE_MS } from "./_shared/http.js";
import { getCache, setCache } from "./_shared/cache.js";
import { safeParseJson } from "./_shared/validation.js";
import { REGION_NAMES, isRegion, type Region } from "./_shared/regions.js";
import type { Factor, Solution } from "./_shared/types.js";

const MAX_SOLUTIONS = 3;

const SOLUTION_PROMPT = `You are a Senior Business Strategy Advisor for commodity-driven companies. Based on the following market analytics and dynamic factors, generate exactly 3 actionable solutions for business owners and executives to manage their logistics and business decisions better. Each solution should target a different strategic aspect: operational resilience, cost optimization, and strategic positioning.

Return strict JSON only with this schema:
{
  "solutions": [
    {
      "title": "string (max 120 chars)",
      "summary": "string (max 600 chars)",
      "actions": ["string (max 200 chars)", "string", "string", "string", "string"],
      "commodities": ["oil" | "electricity" | "water"],
      "regions": ["global" | "asia" | "europe" | "africa" | "americas" | "oceania"],
      "relatedFactors": ["factorId", ...],
      "confidence": number (0-100)
    }
  ]
}

Use only the supplied analytics, factors, and source URLs. Do not invent sources or facts.`;

export default async function handler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "true";
    const regionParam = url.searchParams.get("region");
    const scopeParam = url.searchParams.get("scope");
    const isGlobal = (regionParam === null || regionParam === "") && scopeParam !== "regional";
    const scope = isGlobal ? ("global" as const) : (regionParam as Region);
    const cacheKey = `solutions:${scope}`;
    
    if (!force) {
      const cached = await getCache<Solution[]>(cacheKey, SOLUTIONS_CACHE_MS);
      if (cached) {
        return Response.json({ solutions: cached, scope, count: cached.length, aiCurated: true, cacheKey, updatedAt: new Date().toISOString() }, { status: 200 });
      }
    }

    const analytics = scope === "global" ? await getGlobalAnalytics() : await getRegionalAnalytics(scope as Region);
    const factorsCache = await getCache<Factor[]>(`dynamic-factors:${scope}`, FACTORS_CACHE_MS);
    const factors = factorsCache ?? [];

    const payload = {
      messages: [
        { role: "system", content: SOLUTION_PROMPT },
        { role: "user", content: JSON.stringify({ analytics, factors, scope, region: isGlobal ? null : scope }) },
      ],
      max_tokens: 2048,
      temperature: 0.25,
    };

    const response = await kiloRouter.kiloInfer(payload);
    const content = response.choices?.[0]?.message?.content ?? "";
    const parsed = safeParseJson<{ solutions?: unknown[] }>(content);

    const solutions: Solution[] = (parsed?.solutions ?? [])
      .map((s: any) => {
        if (!s || typeof s !== "object") return null;
        const title = typeof s.title === "string" ? s.title.trim().slice(0, 120) : "";
        const summary = typeof s.summary === "string" ? s.summary.trim().slice(0, 600) : "";
        const actions = Array.isArray(s.actions) ? s.actions.filter((a: any) => typeof a === "string").map((a: string) => a.trim().slice(0, 200)).slice(0, 5) : [];
        if (!title || !summary || actions.length === 0) return null;
        return {
          id: `solution-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
          title,
          summary,
          actions,
          commodities: Array.isArray(s.commodities) ? s.commodities.filter((c: string) => c === "oil" || c === "electricity" || c === "water") : ["oil", "electricity", "water"],
          regions: Array.isArray(s.regions) ? s.regions.filter((r: string) => r === "global" || ["asia", "europe", "africa", "americas", "oceania"].includes(r)) : scope === "global" ? ["global"] : [scope],
          scope,
          relatedFactors: Array.isArray(s.relatedFactors) ? s.relatedFactors.slice(0, 8) : [],
          confidence: typeof s.confidence === "number" && Number.isFinite(s.confidence) ? Math.max(0, Math.min(100, Math.round(s.confidence))) : 70,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        };
      })
      .filter((s): s is Solution => s !== null)
      .slice(0, MAX_SOLUTIONS);

    await setCache(cacheKey, solutions, SOLUTIONS_CACHE_MS);
    return Response.json({ solutions, scope, count: solutions.length, aiCurated: true, cacheKey, updatedAt: new Date().toISOString() }, { status: 200 });
  } catch (error) {
    console.error("Solutions error:", error);
    const scope = new URL(req.url).searchParams.get("region") ?? "global";
    return Response.json({ solutions: [], scope, count: 0, aiCurated: false, cacheKey: `solutions:${scope}`, updatedAt: new Date().toISOString(), error: "Solutions temporarily unavailable" }, { status: 200 });
  }
}