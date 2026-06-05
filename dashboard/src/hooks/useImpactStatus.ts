import { useEffect, useState } from "react";
import {
  fetchHealth,
  fetchIndexes,
  fetchLatestRun,
  type HealthResponse,
  type IndexInfo,
  type RunInfo,
} from "../api/impactClient";
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
 * Polls the Impact Analyser backend at config.impactAnalyser.apiUrl.
 * Each endpoint fails independently — a missing /indexes won't break /health.
 */
export function useImpactStatus(): ImpactStatus {
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [health, setHealth] = useState<HealthResponse | null>(null);
  const [healthy, setHealthy] = useState<boolean | null>(null);
  const [indexes, setIndexes] = useState<IndexInfo[] | null>(null);
  const [latestRun, setLatestRun] = useState<RunInfo | null>(null);
  const [errors, setErrors] = useState<Record<string, string>>({});

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    const errs: Record<string, string> = {};

    const runHealth = fetchHealth()
      .then((h) => {
        if (cancelled) return;
        setHealth(h);
        setHealthy(true);
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setHealth(null);
        setHealthy(false);
        errs.health = e.message;
      });

    const runIdx = fetchIndexes()
      .then((arr) => !cancelled && setIndexes(arr))
      .catch((e: Error) => {
        if (cancelled) return;
        setIndexes(null);
        errs.indexes = e.message;
      });

    const runLatest = fetchLatestRun()
      .then((r) => !cancelled && setLatestRun(r))
      .catch((e: Error) => {
        if (cancelled) return;
        setLatestRun(null);
        errs.latestRun = e.message;
      });

    Promise.allSettled([runHealth, runIdx, runLatest]).then(() => {
      if (cancelled) return;
      setErrors(errs);
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [tick]);

  // Auto-refresh on interval
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
    errors,
    refresh: () => setTick((n) => n + 1),
  };
}
