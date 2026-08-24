import type { AdvisorySeverity } from '../core/types.js';
import type { Outcome, RunFetcher } from './http.js';

const BASE = 'https://api.deps.dev/v3alpha';

interface VersionResponse {
  publishedAt?: string;
  isDeprecated?: boolean;
  deprecatedReason?: string;
  advisoryKeys?: Array<{ id?: string }>;
}

interface AdvisoryResponse {
  advisoryKey?: { id?: string };
  url?: string;
  title?: string;
  aliases?: string[];
  cvss3Score?: number;
}

export interface VersionFacts {
  publishedAt: string | null;
  isDeprecated: boolean;
  deprecatedReason: string | null;
  advisoryIds: string[];
}

export interface AdvisoryFacts {
  id: string;
  title: string;
  url: string;
  severity: AdvisorySeverity;
  cvss3Score: number | null;
}

/**
 * deps.dev returns a CVSS v3 base score and no qualitative rating, so the rating is derived here
 * using the v3.1 severity bands (low 0.1-3.9, medium 4.0-6.9, high 7.0-8.9, critical 9.0-10.0).
 * An advisory with no score at all is treated as moderate rather than dropped, because "we could
 * not grade it" must not read as "it is harmless".
 */
export function severityFromCvss(score: number | null | undefined): AdvisorySeverity {
  if (score === null || score === undefined || Number.isNaN(score)) return 'moderate';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'moderate';
  return 'low';
}

export function encodePackageName(name: string): string {
  return encodeURIComponent(name);
}

export async function fetchVersionFacts(
  fetcher: RunFetcher,
  packageName: string,
  version: string,
): Promise<Outcome<VersionFacts>> {
  const url = `${BASE}/systems/npm/packages/${encodePackageName(packageName)}/versions/${encodeURIComponent(version)}`;
  const result = await fetcher.getJson<VersionResponse>(url);
  if (!result.ok) return result;

  const body = result.value;
  return {
    ok: true,
    fromCache: result.fromCache,
    value: {
      publishedAt: body.publishedAt ?? null,
      isDeprecated: body.isDeprecated === true,
      deprecatedReason: body.deprecatedReason ?? null,
      advisoryIds: (body.advisoryKeys ?? [])
        .map((key) => key.id)
        .filter((id): id is string => !!id),
    },
  };
}

export async function fetchAdvisory(
  fetcher: RunFetcher,
  advisoryId: string,
): Promise<Outcome<AdvisoryFacts>> {
  const url = `${BASE}/advisories/${encodeURIComponent(advisoryId)}`;
  const result = await fetcher.getJson<AdvisoryResponse>(url);
  if (!result.ok) return result;

  const body = result.value;
  return {
    ok: true,
    fromCache: result.fromCache,
    value: {
      id: body.advisoryKey?.id ?? advisoryId,
      title: body.title ?? advisoryId,
      url: body.url ?? `https://osv.dev/vulnerability/${advisoryId}`,
      severity: severityFromCvss(body.cvss3Score),
      cvss3Score: body.cvss3Score ?? null,
    },
  };
}
