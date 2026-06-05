import { useEffect, useState, useCallback } from "react";
import {
  fetchJob,
  fetchRunStages,
  type JenkinsJob,
  type JenkinsRunDescribe,
} from "../api/jenkinsClient";
import { fetchCachedJenkinsJob, toJenkinsJob } from "../api/cachedClient";
import { awaitPrefetch } from "../api/prefetch";
import { useBackendWs } from "./useBackendWs";
import { config } from "../config";

export interface JenkinsJobState {
  loading: boolean;
  job: JenkinsJob | null;
  /** Stage breakdown of the headline (running or last completed) build. */
  stages: JenkinsRunDescribe | null;
  error: string | null;
  jenkinsUrl: string;
  refresh: () => void;
}

/**
 * Fetches one Jenkins job — first from backend cache (instant), then
 * listens for WebSocket push updates. Falls back to direct polling if
 * the cached endpoint is unavailable.
 */
export function useJenkinsJob(jenkinsUrl: string | undefined): JenkinsJobState {
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(false);
  const [job, setJob] = useState<JenkinsJob | null>(null);
  const [stages, setStages] = useState<JenkinsRunDescribe | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Listen for WebSocket push updates
  const wsMsg = useBackendWs(["jenkins:update", "init"]);

  // Derive jobId from the jenkinsUrl for cache lookups
  const jobId = jenkinsUrl ? deriveJobId(jenkinsUrl) : null;

  // Apply WebSocket updates
  useEffect(() => {
    if (!wsMsg || !jobId) return;
    if (wsMsg.type === "init") {
      const cached = wsMsg.payload?.jenkins?.[jobId];
      if (cached) {
        setJob(toJenkinsJob(cached));
        setStages(cached.stages ?? null);
        setError(null);
        setLoading(false);
      }
    } else if (wsMsg.type === "jenkins:update" && wsMsg.payload?.jobId === jobId) {
      const data = wsMsg.payload;
      setJob({
        name: data.name,
        url: data.url,
        lastBuild: data.lastBuild,
        lastCompletedBuild: data.lastCompletedBuild,
        lastSuccessfulBuild: data.lastSuccessfulBuild,
        builds: data.builds ?? [],
      });
      setStages(data.stages ?? null);
      setError(null);
    }
  }, [wsMsg, jobId]);

  // Initial fetch from cache, fallback to direct
  useEffect(() => {
    if (!jenkinsUrl) {
      setJob(null);
      setStages(null);
      setError(null);
      setLoading(false);
      return;
    }
    let cancelled = false;
    setLoading(true);

    const fetchFromCache = async () => {
      if (jobId) {
        try {
          // Try prefetch first (single shared request), then dedicated endpoint
          const pre = await awaitPrefetch();
          const cached = pre?.jenkins?.jobs?.[jobId] ?? await fetchCachedJenkinsJob(jobId);
          if (!cancelled) {
            if (cached) {
              setJob(toJenkinsJob(cached));
              setStages(cached.stages ?? null);
              setError(null);
              setLoading(false);
              return;
            }
            // Cache responded but job is null — backend hasn't fetched it yet.
            // Don't fall back to direct call; wait for WS push or next poll.
            setLoading(false);
            return;
          }
        } catch { /* cache endpoint itself failed — fall through to direct */ }
      }

      // Fallback: direct fetch (only when cache endpoint is unavailable)
      try {
        const j = await fetchJob(jenkinsUrl);
        if (cancelled) return;
        setJob(j);
        setError(null);

        const headline = j.lastBuild?.building ? j.lastBuild : j.lastCompletedBuild;
        if (headline) {
          const describe = await fetchRunStages(jenkinsUrl, headline.number);
          if (!cancelled) setStages(describe);
        } else {
          setStages(null);
        }
      } catch (e: any) {
        if (cancelled) return;
        setJob(null);
        setStages(null);
        setError(e.message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    fetchFromCache();
    return () => { cancelled = true; };
  }, [jenkinsUrl, jobId, tick]);

  // Polling fallback — only if WebSocket is not delivering updates
  useEffect(() => {
    if (!jenkinsUrl) return;
    const ms = config.api.pollIntervalMs;
    if (!ms || ms <= 0) return;
    // Poll less aggressively since WS pushes updates
    const t = setInterval(() => setTick((n) => n + 1), ms * 2);
    return () => clearInterval(t);
  }, [jenkinsUrl]);

  return {
    loading,
    job,
    stages,
    error,
    jenkinsUrl: jenkinsUrl ?? "",
    refresh: () => setTick((n) => n + 1),
  };
}

/** Map a Jenkins URL to the job ID used in the backend cache. */
function deriveJobId(url: string): string | null {
  if (url.includes("Automation_Quick_UT")) return "e-quick-ut";
  if (url.includes("Automation_Slow_UT")) return "e-slow-ut";
  if (url.includes("CVE-BUILD")) return "e-nios-build";
  if (url.includes("NIOS-CVE-Analyser/job/test")) return "d-impact";
  return null;
}
