/**
 * Reads the latest parsed SBOM summary from the backend cache (populated by
 * the CVE-BUILD console parser in vite-backend-plugin.ts). Falls back to
 * /_api/sbom on first paint and listens for `sbom:update` WS pushes.
 *
 * REVERSIBLE: Delete this file to remove SBOM live data from the UI.
 */

import { useEffect, useState } from "react";
import { useBackendWs, type SbomSummaryPayload } from "./useBackendWs";
import { awaitPrefetch } from "../api/prefetch";

export interface SbomSummaryState {
  loading: boolean;
  summary: SbomSummaryPayload | null;
  error: string | null;
}

export function useSbomSummary(): SbomSummaryState {
  const [summary, setSummary] = useState<SbomSummaryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const wsMsg = useBackendWs(["sbom:update", "init"]);

  useEffect(() => {
    if (!wsMsg) return;
    if (wsMsg.type === "sbom:update") {
      setSummary(wsMsg.payload);
      setLoading(false);
      setError(null);
    } else if (wsMsg.type === "init") {
      const init = (wsMsg.payload as { sbom?: SbomSummaryPayload | null }).sbom;
      if (init) {
        setSummary(init);
        setLoading(false);
      }
    }
  }, [wsMsg]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pre = await awaitPrefetch();
        if (cancelled) return;
        if (pre?.sbom) {
          setSummary(pre.sbom);
          setLoading(false);
          return;
        }
        const res = await fetch("/_api/sbom");
        if (!res.ok) throw new Error(`${res.status}`);
        const body = await res.json();
        if (cancelled) return;
        setSummary(body?.data ?? null);
        setLoading(false);
      } catch (e) {
        if (!cancelled) {
          setError((e as Error).message);
          setLoading(false);
        }
      }
    })();
    return () => { cancelled = true; };
  }, []);

  return { loading, summary, error };
}
