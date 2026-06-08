/**
 * Thin client for the Impact Analyser backend.
 *
 * Endpoints are best-effort — if a path returns 404 the caller should treat it
 * as "feature not available" rather than a hard error. The exact API surface
 * may vary across deployments; adjust paths here if your backend differs.
 */
import { config } from "../config";

const base = () => config.impactAnalyser.apiUrl.replace(/\/+$/, "");

async function getJson<T>(path: string, init?: RequestInit): Promise<T> {
  const url = `${base()}${path}`;
  const res = await fetch(url, {
    headers: { Accept: "application/json" },
    ...init,
  });
  if (!res.ok) {
    throw new Error(`${res.status} ${res.statusText} — ${url}`);
  }
  return (await res.json()) as T;
}

export interface HealthResponse {
  status?: string;
  ok?: boolean;
  [k: string]: unknown;
}

export interface IndexInfo {
  name?: string;
  id?: string;
  [k: string]: unknown;
}

export interface RunInfo {
  run_id?: string;
  id?: string;
  status?: string;
  started_at?: string;
  finished_at?: string;
  report_url?: string;
  [k: string]: unknown;
}

export function fetchHealth(): Promise<HealthResponse> {
  return getJson<HealthResponse>("/health");
}

export async function fetchIndexes(): Promise<IndexInfo[]> {
  // Accept either an array or {indexes:[...]}
  const data = await getJson<IndexInfo[] | { indexes?: IndexInfo[] }>("/indexes");
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.indexes)) return data.indexes;
  return [];
}

export function fetchLatestRun(): Promise<RunInfo> {
  return getJson<RunInfo>("/runs/latest");
}

export interface CveItem {
  cve_id?: string;
  id?: string;
  severity?: string;
  status?: string;
  decision?: { verdict?: string } | string | null;
  verdict?: string;
  [k: string]: unknown;
}

export async function fetchRunCves(runId: string): Promise<CveItem[]> {
  const data = await getJson<CveItem[] | { cves?: CveItem[]; items?: CveItem[] }>(`/runs/${encodeURIComponent(runId)}/cves`);
  if (Array.isArray(data)) return data;
  if (Array.isArray(data?.cves)) return data.cves;
  if (Array.isArray(data?.items)) return data.items;
  return [];
}

/** Probe a path and return its raw JSON body (or null on failure). */
export async function probe(path: string): Promise<unknown> {
  try {
    return await getJson<unknown>(path);
  } catch {
    return null;
  }
}
