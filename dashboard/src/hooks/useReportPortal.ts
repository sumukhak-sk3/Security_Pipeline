import { useCallback, useEffect, useRef, useState } from "react";
import { fetchSingleUTResult, type UTResult, type LaunchSummary, type FailedItem } from "../api/reportPortalClient";
import { fetchCachedRP, fetchCachedRPForBranch, type CachedRPLaunch } from "../api/cachedClient";
import { awaitPrefetch } from "../api/prefetch";
import { useBackendWs } from "./useBackendWs";
import { config } from "../config";

export interface ReportPortalLaunchState {
  loading: boolean;
  summary: LaunchSummary | null;
  failedItems?: FailedItem[];
  error: string | null;
}

/**
 * Hook that fetches a single ReportPortal UT launch result (quick or slow).
 * Uses the backend cache for instant responses, with WebSocket push for updates.
 * Falls back to direct RP API calls if cache is unavailable.
 */
export function useReportPortalLaunch(
  branchTag: string | undefined,
  utType: "quick" | "slow" | undefined,
): ReportPortalLaunchState {
  const [loading, setLoading] = useState(false);
  const [summary, setSummary] = useState<LaunchSummary | null>(null);
  const [failedItems, setFailedItems] = useState<FailedItem[] | undefined>();
  const [error, setError] = useState<string | null>(null);
  const abortRef = useRef<AbortController | null>(null);

  // Listen for RP WebSocket updates
  const wsMsg = useBackendWs(["rp:update", "init"]);

  // Apply WebSocket updates
  useEffect(() => {
    if (!wsMsg || !utType) return;
    const rpData = wsMsg.type === "init" ? wsMsg.payload?.rp : wsMsg.payload;
    if (!rpData) return;

    const launch: CachedRPLaunch | null = rpData[utType] ?? null;
    if (launch) {
      setSummary({
        id: launch.id,
        name: launch.name,
        status: launch.status,
        total: launch.total,
        passed: launch.passed,
        failed: launch.failed,
        skipped: launch.skipped,
        startTime: launch.startTime,
        endTime: launch.endTime,
        url: launch.url,
      });
      setFailedItems(launch.failedItems as FailedItem[] | undefined);
      setError(null);
      setLoading(false);
    }
  }, [wsMsg, utType]);

  const doFetch = useCallback(async () => {
    if (!branchTag || !utType) {
      setSummary(null);
      setFailedItems(undefined);
      setError(null);
      return;
    }

    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;

    setLoading(true);
    setError(null);

    try {
      // Try prefetch first (single shared request already in flight)
      const isSpecific = /\d{4}-\d{2}-\d{2}/.test(branchTag);
      let rpData;
      if (!isSpecific) {
        const pre = await awaitPrefetch();
        rpData = pre?.rp ?? await fetchCachedRP();
      } else {
        rpData = await fetchCachedRPForBranch(branchTag);
      }

      if (controller.signal.aborted) return;

      const launch = rpData[utType];
      if (launch) {
        setSummary({
          id: launch.id,
          name: launch.name,
          status: launch.status,
          total: launch.total,
          passed: launch.passed,
          failed: launch.failed,
          skipped: launch.skipped,
          startTime: launch.startTime,
          endTime: launch.endTime,
          url: launch.url,
        });
        setFailedItems(launch.failedItems as FailedItem[] | undefined);
      } else {
        setSummary(null);
        setFailedItems(undefined);
      }
    } catch {
      // Fallback to direct RP call
      if (controller.signal.aborted) return;
      try {
        const result = await fetchSingleUTResult(branchTag, utType);
        if (controller.signal.aborted) return;
        if (result.status === "fetched" && result.summary) {
          setSummary(result.summary);
          setFailedItems(result.failedItems);
        } else {
          setSummary(null);
          setFailedItems(undefined);
        }
      } catch (err: any) {
        if (controller.signal.aborted) return;
        setError(err?.message ?? "Failed to fetch ReportPortal data");
      }
    } finally {
      if (!controller.signal.aborted) setLoading(false);
    }
  }, [branchTag, utType]);

  useEffect(() => {
    doFetch();
    return () => abortRef.current?.abort();
  }, [doFetch]);

  // Reduced polling since WS pushes updates
  useEffect(() => {
    if (!branchTag || !utType) return;
    const id = setInterval(doFetch, config.api.pollIntervalMs * 6);
    return () => clearInterval(id);
  }, [branchTag, utType, doFetch]);

  return { loading, summary, failedItems, error };
}
