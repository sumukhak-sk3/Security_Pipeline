import { useEffect, useState } from "react";
import {
  fetchHealth,
  fetchIndexes,
  fetchLatestRun,
  type HealthResponse,
  type IndexInfo,
  type RunInfo,
} from "../api/impactClient";
import { useBackendWs } from "./useBackendWs";
import { awaitPrefetch } from "../api/prefetch";
import { config } from "../config";

export interface ImpactStatus {
  loading: boolean;
  healthy: boolean | null;        // null = unknown / endpoint missing
  health: HealthResponse | null;
  indexes: IndexInfo[] | null;    // null = endpoint failed
  latestRun: RunInfo | null;      // null = endpoint failed
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
  const [errors, setErrors] = useState<Record<string, string>>({});

  // Listen for WebSocket push
  const wsMsg = useBackendWs(["impact:update", "init"]);

  useEffect(() => {
    if (!wsMsg) return;
    const data = wsMsg.type === "init" ? null : wsMsg.payload; // init doesn't include impact yet
    if (!data) return;
    setHealthy(data.healthy ?? null);
    setHealth(data.health ?? null);
    setIndexes(data.indexes ?? null);
    setLatestRun(data.latestRun ?? null);
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
      await Promise.allSettled([
        fetchHealth()
          .then((h) => { if (!cancelled) { setHealth(h); setHealthy(true); } })
          .catch((e: Error) => { if (!cancelled) { setHealth(null); setHealthy(false); errs.health = e.message; } }),
        fetchIndexes()
          .then((arr) => { if (!cancelled) setIndexes(arr); })
          .catch((e: Error) => { if (!cancelled) { setIndexes(null); errs.indexes = e.message; } }),
        fetchLatestRun()
          .then((r) => { if (!cancelled) setLatestRun(r); })
          .catch((e: Error) => { if (!cancelled) { setLatestRun(null); errs.latestRun = e.message; } }),
      ]);
      if (!cancelled) { setErrors(errs); setLoading(false); }
    };

    fetchFromCache().then((ok) => { if (!ok && !cancelled) fetchDirect(); });
    return () => { cancelled = true; };
  }, [tick]);

  // Reduced polling since WS pushes updates
  useEffect(() => {
    const ms = config.api.pollIntervalMs;
    if (!ms || ms <= 0) return;
    const t = setInterval(() => setTick((n) => n + 1), ms * 3);
    return () => clearInterval(t);
  }, []);

  return {
    loading,
    healthy,
    health,
    indexes,
    latestRun,
    errors,
    refresh: () => setTick((n) => n + 1),
  };
}
