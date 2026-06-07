import { useEffect, useState } from "react";
import {
  fetchJob,
  fetchRunStages,
  type JenkinsJob,
  type JenkinsBuild,
  type JenkinsStage,
} from "../api/jenkinsClient";
import { fetchCachedJenkins, toJenkinsJob } from "../api/cachedClient";
import { awaitPrefetch } from "../api/prefetch";
import { useBackendWs } from "./useBackendWs";
import { config } from "../config";
import type { Status } from "../types";
import { buildStatus, computeProgress, headlineBuild, stagesOf } from "../lib/jenkinsMap";

export interface LiveJobSummary {
  id: string;
  title: string;
  jenkinsUrl: string;
  job: JenkinsJob | null;
  headline: JenkinsBuild | null;
  stages: JenkinsStage[] | null;
  status: Status;
  progress: number;
  error: string | null;
}

export interface LiveWorkflowSummary {
  loading: boolean;
  status: Status;
  progress: number;
  jobsTotal: number;
  jobsDone: number;
  jobsRunning: number;
  jobsFailed: number;
  jobs: LiveJobSummary[];
}

interface JobSpec {
  id: string;
  title: string;
  jenkinsUrl: string;
}

function aggregate(items: LiveJobSummary[]): Omit<LiveWorkflowSummary, "loading" | "jobs"> {
  const total = items.length || 1;
  const done = items.filter((i) => i.status === "success").length;
  const running = items.filter((i) => i.status === "running").length;
  const failed = items.filter((i) => i.status === "failed").length;
  // Unreachable: pending AND (has error, no URL configured, OR URL is set but no job data returned)
  const unreachable = items.filter((i) => i.status === "pending" && (i.error || !i.jenkinsUrl || (i.jenkinsUrl && !i.job))).length;
  // Genuinely pending: pending, reachable, has job data (meaning Jenkins responded but build hasn't started)
  const genuinelyPending = items.filter((i) => i.status === "pending" && i.jenkinsUrl && i.job && !i.error).length;

  const reachableTotal = total - unreachable;
  const progress = reachableTotal > 0
    ? Math.round(items.filter((i) => i.job != null).reduce((a, i) => a + i.progress, 0) / reachableTotal)
    : 0;

  let status: Status = "pending";
  if (failed > 0) status = "failed";
  else if (running > 0) status = "running";
  else if (reachableTotal > 0 && done === reachableTotal) status = "success";
  else if (done > 0 && genuinelyPending > 0) status = "running";
  else if (done > 0 && genuinelyPending === 0) status = "success"; // all reachable jobs done, rest are unreachable

  return { status, progress, jobsTotal: items.length, jobsDone: done, jobsRunning: running, jobsFailed: failed };
}

/**
 * Polls a fixed list of Jenkins jobs and aggregates their state into a
 * workflow-level summary. Stage info is fetched per job so per-job progress
 * reflects actual pipeline advancement (not just elapsed/estimated time).
 */
export function useWorkflowLiveSummary(jobs: JobSpec[]): LiveWorkflowSummary {
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState<LiveJobSummary[]>(() =>
    jobs.map((j) => ({
      id: j.id,
      title: j.title,
      jenkinsUrl: j.jenkinsUrl,
      job: null,
      headline: null,
      stages: null,
      status: "pending",
      progress: 0,
      error: null,
    })),
  );

  const specKey = jobs.map((j) => `${j.id}|${j.jenkinsUrl}`).join(",");

  useEffect(() => {
    let cancelled = false;
    setLoading(true);

    const fetchFromCache = async (): Promise<boolean> => {
      try {
        // Use prefetch (single request already in flight) for instant data
        const pre = await awaitPrefetch();
        const allCached = pre?.jenkins?.jobs ?? await fetchCachedJenkins();
        if (cancelled) return true;
        const results: LiveJobSummary[] = jobs.map((spec) => {
          const cached = allCached[spec.id];
          if (!cached) {
            return {
              id: spec.id, title: spec.title, jenkinsUrl: spec.jenkinsUrl,
              job: null, headline: null, stages: null, status: "pending" as Status, progress: 0, error: null,
            };
          }
          const job = toJenkinsJob(cached);
          const headline = headlineBuild(job);
          const stages = stagesOf(cached.stages);
          return {
            id: spec.id, title: spec.title, jenkinsUrl: spec.jenkinsUrl,
            job, headline, stages,
            status: buildStatus(headline),
            progress: computeProgress(headline, stages),
            error: null,
          };
        });
        if (!cancelled) { setItems(results); setLoading(false); }
        return true;
      } catch {
        return false; // cache unavailable, fall through
      }
    };

    const fetchDirect = async () => {
      const results = await Promise.all(
        jobs.map(async (spec): Promise<LiveJobSummary> => {
          if (!spec.jenkinsUrl) {
            return {
              id: spec.id, title: spec.title, jenkinsUrl: "",
              job: null, headline: null, stages: null, status: "pending", progress: 0, error: null,
            };
          }
          try {
            const job = await fetchJob(spec.jenkinsUrl);
            const headline = headlineBuild(job);
            let stages: JenkinsStage[] | null = null;
            if (headline) {
              const describe = await fetchRunStages(spec.jenkinsUrl, headline.number);
              stages = stagesOf(describe);
            }
            return {
              id: spec.id, title: spec.title, jenkinsUrl: spec.jenkinsUrl,
              job, headline, stages,
              status: buildStatus(headline), progress: computeProgress(headline, stages), error: null,
            };
          } catch (e) {
            return {
              id: spec.id, title: spec.title, jenkinsUrl: spec.jenkinsUrl,
              job: null, headline: null, stages: null, status: "pending", progress: 0, error: (e as Error).message,
            };
          }
        }),
      );
      if (!cancelled) { setItems(results); setLoading(false); }
    };

    // Try cache first, fallback to direct
    fetchFromCache().then((ok) => { if (!ok && !cancelled) fetchDirect(); });

    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [specKey, tick]);

  useEffect(() => {
    const ms = config.api.pollIntervalMs;
    if (!ms || ms <= 0) return;
    const t = setInterval(() => setTick((n) => n + 1), ms);
    return () => clearInterval(t);
  }, []);

  return { loading, jobs: items, ...aggregate(items) };
}
