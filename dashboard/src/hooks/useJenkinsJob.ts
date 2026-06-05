import { useEffect, useState } from "react";
import {
  fetchJob,
  fetchRunStages,
  type JenkinsJob,
  type JenkinsRunDescribe,
} from "../api/jenkinsClient";
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
 * Polls one Jenkins job and fetches stage info for the headline build.
 * Pass the REAL Jenkins URL; client rewrites it to a proxy path internally.
 *
 * Headline build = running build (if any) else lastCompletedBuild — so
 * failed/aborted builds show up too, not just successes.
 */
export function useJenkinsJob(jenkinsUrl: string | undefined): JenkinsJobState {
  const [tick, setTick] = useState(0);
  const [loading, setLoading] = useState(false);
  const [job, setJob] = useState<JenkinsJob | null>(null);
  const [stages, setStages] = useState<JenkinsRunDescribe | null>(null);
  const [error, setError] = useState<string | null>(null);

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

    fetchJob(jenkinsUrl)
      .then(async (j) => {
        if (cancelled) return;
        setJob(j);
        setError(null);

        const headline =
          j.lastBuild?.building ? j.lastBuild : j.lastCompletedBuild;
        if (headline) {
          const describe = await fetchRunStages(jenkinsUrl, headline.number);
          if (!cancelled) setStages(describe);
        } else {
          setStages(null);
        }
      })
      .catch((e: Error) => {
        if (cancelled) return;
        setJob(null);
        setStages(null);
        setError(e.message);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [jenkinsUrl, tick]);

  useEffect(() => {
    if (!jenkinsUrl) return;
    const ms = config.api.pollIntervalMs;
    if (!ms || ms <= 0) return;
    const t = setInterval(() => setTick((n) => n + 1), ms);
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
