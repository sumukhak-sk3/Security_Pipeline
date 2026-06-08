import { useEffect, useState } from "react";
import {
  fetchHealth,
  fetchIndexes,
  fetchLatestRun,
  fetchRunCves,
  type HealthResponse,
  type IndexInfo,
  type RunInfo,
  type CveItem,
} from "../api/impactClient";
import { useBackendWs, type ImpactCveSummaryPayload } from "./useBackendWs";
import { awaitPrefetch } from "../api/prefetch";
import { config } from "../config";

export interface ImpactStatus {
  loading: boolean;
  healthy: boolean | null;        // null = unknown / endpoint missing
  health: HealthResponse | null;
  indexes: IndexInfo[] | null;    // null = endpoint failed
  latestRun: RunInfo | null;      // null = endpoint failed
  cveSummary: ImpactCveSummaryPayload | null;
  errors: Record<string, string>; // per-endpoint error messages
  refresh: () => void;
}

/**
 * Fetches Impact Analyser status from backend cache (instant),
 * with WebSocket push for updates. Falls back to direct calls.
 */
export function useImpactStatus(): ImpactStatus {
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [indexes, setIndexes] = useState<IndexInfo[] | null>(null);
  const [latestRun, setLatestRun] = useState<RunInfo | null>(null);
  const [cveSummary, setCveSummary] = useState<ImpactCveSummaryPayload | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Listen for WebSocket push
  const wsMsg = useBackendWs(["impact:update", "init"]);

  useEffect(() => {
    if (!wsMsg) return;
    // `init` now carries the cached impact payload under payload.impact
    type ImpactSnapshot = { healthy?: boolean | null; health?: unknown; indexes?: unknown; latestRun?: unknown; cveSummary?: ImpactCveSummaryPayload | null };
    let data: ImpactSnapshot | null = null;
    if (wsMsg.type === "init") {
      data = (wsMsg.payload as { impact?: ImpactSnapshot | null }).impact ?? null;
    } else if (wsMsg.type === "impact:update") {
      data = wsMsg.payload as ImpactSnapshot;
    }
    if (!data) return;
    setHealthy(data.healthy ?? null);
    setHealth((data.health as HealthResponse) ?? null);
    setIndexes((data.indexes as IndexInfo[]) ?? null);
    setLatestRun((data.latestRun as RunInfo) ?? null);
    setCveSummary(data.cveSummary ?? null);
    setErrors({});
    setLoading(false);
  }, [wsMsg]);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    // Try prefetch first (single shared request), then dedicated endpoint
    const fetchFromCache = async (): Promise<boolean> => {
      try {
        const pre = await awaitPrefetch();
        const data = pre?.impact ?? (await fetch("/_api/impact").then(r => r.ok ? r.json() : null));
        if (cancelled) return true;
        if (data && data.healthy !== undefined) {
          setHealthy(data.healthy ?? null);
          setHealth(data.health ?? null);
          setIndexes(data.indexes ?? null);
          setLatestRun(data.latestRun ?? null);
          setCveSummary(data.cveSummary ?? null);
          setErrors({});
          setLoading(false);
          return true;
        }
        return false;
      } catch {
        return false;
      }
    };

    // Fallback: direct calls
    const fetchDirect = async () => {
      const errs: Record<string, string> = {};
      const runHolder: { run: RunInfo | null } = { run: null };
      await Promise.allSettled([
        fetchHealth()
          .then((h) => { if (!cancelled) { setHealth(h); setHealthy(true); } })
          .catch((e: Error) => { if (!cancelled) { setHealth(null); setHealthy(false); errs.health = e.message; } }),
        fetchIndexes()
          .then((arr) => { if (!cancelled) setIndexes(arr); })
          .catch((e: Error) => { if (!cancelled) { setIndexes(null); errs.indexes = e.message; } }),
        fetchLatestRun()
          .then((r) => { if (!cancelled) { setLatestRun(r); runHolder.run = r; } })
          .catch((e: Error) => { if (!cancelled) { setLatestRun(null); errs.latestRun = e.message; } }),
      ]);
      // CVE summary requires a runId — fetch after latestRun is known
      const rid = runHolder.run?.run_id ?? runHolder.run?.id;
      if (rid && !cancelled) {
        try {
          const cves = await fetchRunCves(String(rid));
          if (!cancelled) setCveSummary(summariseCves(String(rid), cves));
        } catch (e) {
          if (!cancelled) errs.cves = (e as Error).message;
        }
      }
      if (!cancelled) { setErrors(errs); setLoading(false); }
    };

    fetchFromCache().then((ok) => { if (!ok && !cancelled) fetchDirect(); });
    return () => { cancelled = true; };
  }, [tick]);

  // Reduced polling since WS pushes updates
  useEffect(() => {
    const ms = config.api.pollIntervalMs;
    if (!ms || ms <= 0) return;
    const t = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, []);

  return {
    loading,
    healthy,
    health,
    indexes,
    latestRun,
    cveSummary,
    errors,
    refresh: () => setTick((n) => n + 1),
  };
}

/** Aggregate a CVE list (defensive about field shape). */
function summariseCves(runId: string, list: CveItem[]): ImpactCveSummaryPayload {
  const out: ImpactCveSummaryPayload = {
    runId,
    total: list.length,
    withDecision: 0,
    withoutDecision: 0,
    bySeverity: {},
    byVerdict: {},
    byStatus: {},
    fetchedAt: Date.now(),
  };
  for (const c of list) {
    const sev = String(c?.severity ?? "UNKNOWN").toUpperCase();
    out.bySeverity[sev] = (out.bySeverity[sev] ?? 0) + 1;

    const dec = c?.decision;
    const verdict = c?.verdict
      ?? (typeof dec === "object" && dec ? dec.verdict : (typeof dec === "string" ? dec : null));
    if (verdict) {
      const v = String(verdict).toUpperCase();
      out.byVerdict[v] = (out.byVerdict[v] ?? 0) + 1;
      out.withDecision++;
    } else {
      out.withoutDecision++;
    }

    if (c?.status) {
      const s = String(c.status).toUpperCase();
      out.byStatus[s] = (out.byStatus[s] ?? 0) + 1;
    }
  }
  return out;
}
