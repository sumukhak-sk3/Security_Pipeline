import { useEffect, useState } from "react";
import type { Status } from "../types";
import { toProxyUrl } from "../api/jenkinsClient";

const CICD_JOB_URL = "https://jenkins-qa2.inca.infoblox.com/job/IB_QA_CI_NIOS_CVE_Analyser";

interface CICDStatus {
  status: Status;
  lastBuild: number | null;
}

export function useCICDStatus(): CICDStatus {
  const [status, setStatus] = useState<Status>("pending");
  const [lastBuild, setLastBuild] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;

    async function poll() {
      try {
        const proxy = toProxyUrl(CICD_JOB_URL);
        const res = await fetch(`${proxy}/api/json?tree=lastBuild[number,result,building]`);
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const build = data.lastBuild;
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
    const id = setInterval(poll, 15_000);
    return () => {
      cancelled = true;
      clearInterval(id);
    };
  }, []);

  return { status, lastBuild };
}
