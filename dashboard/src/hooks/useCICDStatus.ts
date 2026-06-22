import { useEffect, useState } from "react";
import type { Status } from "../types";
import { toProxyUrl } from "../api/jenkinsClient";
import { config } from "../config";

const CICD_JOB_URL = "https://jenkins-qa2.inca.infoblox.com/job/IB_QA_CI_NIOS_CVE_Analyser";

// Floor of 60s prevents accidentally hammering Jenkins if the global
// VITE_POLL_INTERVAL_MS is set to a very small value for other widgets.
const MIN_POLL_MS = 60_000;
const DEFAULT_POLL_MS = 120_000;

interface CICDStatus {
  status: Status;
  lastBuild: number | null;
  lastSuccessfulBuild: number | null;
}

export function useCICDStatus(): CICDStatus {
  const [status, setStatus] = useState<Status>("pending");
  const [lastBuild, setLastBuild] = useState<number | null>(null);
  const [lastSuccessfulBuild, setLastSuccessfulBuild] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const proxy = toProxyUrl(CICD_JOB_URL);
        const res = await fetch(
          `${proxy}/api/json?tree=lastBuild[number,result,building],lastSuccessfulBuild[number]`,
        );
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const build = data.lastBuild;
        setLastSuccessfulBuild(data.lastSuccessfulBuild?.number ?? null);
        if (!build) {
          setStatus("pending");
          setLastBuild(null);
          return;
        }
        setLastBuild(build.number);
        if (build.building) {
          setStatus("running");
        } else if (build.result === "SUCCESS") {
          setStatus("success");
        } else if (build.result === "FAILURE" || build.result === "ABORTED") {
          setStatus("failed");
        } else {
          setStatus("pending");
        }
      } catch {
        // keep last known status
      }
    }

    poll();
    const intervalMs = Math.max(
      MIN_POLL_MS,
      config.api.pollIntervalMs || DEFAULT_POLL_MS,
    );
    const id = setInterval(poll, intervalMs);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { status, lastBuild, lastSuccessfulBuild };
}
