import { useEffect, useRef, useState } from "react";
import type { Job } from "../types";
import { config, jobLogUrl } from "../config";

/**
 * Streams console log lines for a job.
 *
 * - In `mock` mode: emits the static lines stored on each Step.
 * - In `live` mode: polls the backend's progressive-log endpoint
 *   (`config.api.baseUrl` → see `jobLogUrl`). The backend is expected to
 *   proxy Jenkins' `/logText/progressiveText` and return:
 *     { text: string, nextOffset: number, more: boolean }
 *
 * Polling stops automatically when the job is no longer "running".
 */
export function useJobLog(runId: string | undefined, job: Job | null) {
  const [lines, setLines] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const offsetRef = useRef(0);

  useEffect(() => {
    setLines([]);
    setError(null);
    offsetRef.current = 0;
    if (!job) return;

    // -------- mock mode: flatten step logs once --------
    if (config.dataSource === "mock") {
      const flat = job.steps.flatMap((s) =>
        (s.log ?? []).map((l) => `[${s.name}] ${l}`)
      );
      setLines(flat.length ? flat : ["(no log output yet)"]);
      return;
    }

    // -------- live mode: poll the backend --------
    if (!runId || !config.api.baseUrl) {
      setError("API base URL not configured (VITE_API_BASE_URL).");
      return;
    }

    let cancelled = false;
    let timer: number | undefined;

    const poll = async () => {
      try {
        setLoading(true);
        const res = await fetch(jobLogUrl(runId, job.id, offsetRef.current));
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const data: { text: string; nextOffset: number; more: boolean } =
          await res.json();
        if (cancelled) return;
        if (data.text) {
          setLines((prev) => [...prev, ...data.text.split(/\r?\n/).filter(Boolean)]);
        }
        offsetRef.current = data.nextOffset ?? offsetRef.current;
        if (data.more && job.status === "running") {
          timer = window.setTimeout(poll, config.api.pollIntervalMs);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    };

    poll();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [runId, job]);

  return { lines, loading, error };
}
