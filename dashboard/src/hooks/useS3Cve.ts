/**
 * Reads the latest S3 CVE-output object from the backend cache (populated by
 * the S3 poller in vite-backend-plugin.ts). Returns the newest matching
 * object's key + lastModified so callers can detect whether the SBOM/CVE
 * workflow for the current pipeline run has reached S3.
 *
 * REVERSIBLE: Delete this file to remove S3-gating from the UI.
 */

import { useEffect, useState } from "react";
import { useBackendWs, type S3CvePayload } from "./useBackendWs";
import { awaitPrefetch } from "../api/prefetch";

export interface S3CveState {
  loading: boolean;
  data: S3CvePayload | null;
  error: string | null;
}

export function useS3Cve(): S3CveState {
  const [data, setData] = useState<S3CvePayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const wsMsg = useBackendWs(["s3:update", "init"]);

  useEffect(() => {
    if (!wsMsg) return;
    if (wsMsg.type === "s3:update") {
      setData(wsMsg.payload);
      setLoading(false);
      setError(null);
    } else if (wsMsg.type === "init") {
      const init = (wsMsg.payload as { s3Cve?: S3CvePayload | null }).s3Cve;
      if (init) {
        setData(init);
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
        if (pre?.s3Cve) {
          setData(pre.s3Cve);
          setLoading(false);
          return;
        }
        const res = await fetch("/_api/s3-cve");
        if (!res.ok) throw new Error(`${res.status}`);
        const body = await res.json();
        if (cancelled) return;
        setData(body?.data ?? null);
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

  return { loading, data, error };
}
