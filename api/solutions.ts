import { kiloRouter } from "./_shared/kiloRouter.js";
import { getGlobalAnalytics, getRegionalAnalytics } from "./_shared/deterministicAnalytics.js";
import { FACTORS_CACHE_MS, SOLUTIONS_CACHE_MS } from "./_shared/http.js";
import { getCache, setCache } from "./_shared/cache.js";
import { safeParseJson } from "./_shared/validation.js";
import { isRegion, type Region } from "./_shared/regions.js";
import type { Factor, Solution, RegionId } from "./_shared/types.js";

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

function isValidRegionId(value: string): value is RegionId {
  return value === "global" || isRegion(value);
}

function buildSolution(s: unknown, scope: RegionId, validRegions: RegionId[]): Solution | null {
  if (!s || typeof s !== "object") return null;
  const obj = s as Record<string, unknown>;
  const title = typeof obj.title === "string" ? obj.title.trim().slice(0, 120) : "";
  const summary = typeof obj.summary === "string" ? obj.summary.trim().slice(0, 600) : "";
  const actions = Array.isArray(obj.actions)
    ? obj.actions.filter((a: unknown) => typeof a === "string").map((a: string) => a.trim().slice(0, 200)).slice(0, 5)
    : [];
  if (!title || !summary || actions.length === 0) return null;
  const rawRegions = Array.isArray(obj.regions)
    ? obj.regions.filter((r: unknown): r is RegionId => typeof r === "string" && validRegions.includes(r as RegionId))
    : [];
  const commodities: ("oil" | "electricity" | "water")[] = Array.isArray(obj.commodities)
    ? obj.commodities.filter((c): c is "oil" | "electricity" | "water" =>
        c === "oil" || c === "electricity" || c === "water",
      )
    : ["oil", "electricity", "water"];
  const relatedFactors = Array.isArray(obj.relatedFactors)
    ? obj.relatedFactors.filter((f: unknown) => typeof f === "string").slice(0, 8)
    : [];
  const confidence =
    typeof obj.confidence === "number" && Number.isFinite(obj.confidence)
      ? Math.max(0, Math.min(100, Math.round(obj.confidence)))
      : 70;

  return {
    id: `solution-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    title,
    summary,
    actions,
    commodities,
    regions: rawRegions.length > 0 ? rawRegions : (scope === "global" ? ["global"] : [scope]),
    scope,
    relatedFactors,
    confidence,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };
}

export default async function handler(req: Request): Promise<Response> {
  try {
    const url = new URL(req.url);
    const force = url.searchParams.get("force") === "true";
    const regionParam = url.searchParams.get("region");
    const isGlobal = regionParam === null || regionParam === "";
    const scope: RegionId = isGlobal ? "global" : (isValidRegionId(regionParam) ? regionParam : "global");
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

    // Use AbortController to abort the Kilo inference on timeout, so the
    // underlying fetch is cancelled (not just timed out via Promise.race).
    const abortController = new AbortController();
    const timeoutId = setTimeout(() => abortController.abort(), 15000);
    try {
      const response = await kiloRouter.kiloInfer(payload, abortController.signal);
      const content = response.choices?.[0]?.message?.content ?? "";
      const parsed = safeParseJson<{ solutions?: unknown[] }>(content);

<<<<<<< ours
      const validRegions: RegionId[] = ["global", "asia", "europe", "africa", "americas", "oceania"];
=======
    const validRegions: RegionId[] = ["global", "asia", "europe", "africa", "americas", "oceania"];

    const solutions: Solution[] = (parsed?.solutions ?? [])
      .map((s: unknown) => buildSolution(s, scope, validRegions))
      .filter((s): s is Solution => s !== null)
      .slice(0, MAX_SOLUTIONS);
>>>>>>> theirs

      const solutions: Solution[] = (parsed?.solutions ?? [])
        .map((s: unknown) => buildSolution(s, scope, validRegions))
        .filter((s): s is Solution => s !== null)
        .slice(0, MAX_SOLUTIONS);

      await setCache(cacheKey, solutions, SOLUTIONS_CACHE_MS);
      return Response.json({ solutions, scope, count: solutions.length, aiCurated: true, cacheKey, updatedAt: new Date().toISOString() }, { status: 200 });
    } finally {
      clearTimeout(timeoutId);
    }
  } catch (error) {
    console.error("Solutions error:", error);
    return Response.json({ solutions: [], scope: "global" as RegionId, count: 0, aiCurated: false, cacheKey: "solutions:error", updatedAt: new Date().toISOString(), error: "Solutions temporarily unavailable" }, { status: 200 });
  }
}