/**
 * Single prefetch that loads ALL cached data.
 * 
 * Priority:
 * 1. window.__PREFETCH_DATA__ (injected into HTML by backend plugin — instant, zero latency)
 * 2. Fetch /_api/all (fallback if inline data missing)
 *
 * The initial prefetch is cached for the first render (zero-latency paint).
 * Subsequent calls to `awaitPrefetch()` always fetch fresh data from the
 * backend cache so the UI stays in sync with the poller.
 *
 * REVERSIBLE: Delete this file; hooks will fall back to individual fetches.
 */

import type { CachedJenkinsJob, CachedRPResult } from "./cachedClient";

declare global {
  interface Window {
    __PREFETCH_DATA__?: PrefetchData;
  }
}

export interface PrefetchData {
  jenkins: { jobs: Record<string, CachedJenkinsJob | null> };
  rp: CachedRPResult | null;
  impact: any | null;
  ts: number;
}

let initialPromise: Promise<PrefetchData | null> | null = null;
let initialResolved = false;
let lastResult: PrefetchData | null = null;

// Check for inline data injected by the backend plugin (synchronous — zero latency)
if (typeof window !== "undefined" && window.__PREFETCH_DATA__) {
  lastResult = window.__PREFETCH_DATA__;
  initialPromise = Promise.resolve(lastResult);
  initialResolved = true;
}

/**
 * Trigger the initial prefetch (call once at app startup, e.g. in main.tsx).
 * Returns immediately if inline data was available.
 */
export function startPrefetch(): void {
  if (initialPromise) return;
  initialPromise = fetchFresh();
}

function fetchFresh(): Promise<PrefetchData | null> {
  return fetch("/_api/all", { signal: AbortSignal.timeout(12_000) })
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      if (data) lastResult = data;
      initialResolved = true;
      return data;
    })
    .catch(() => {
      initialResolved = true;
      return lastResult; // Return stale data on error rather than null
    });
}

/**
 * Get the prefetch result. Returns null if not yet loaded.
 */
export function getPrefetchSync(): PrefetchData | null {
  return lastResult;
}

/**
 * Await the prefetch result.
 * - First call: returns the initial prefetch (instant if inline data exists).
 * - Subsequent calls: fetches fresh data from /_api/all each time so the
 *   UI always reflects the latest poller state.
 */
export function awaitPrefetch(): Promise<PrefetchData | null> {
  if (!initialPromise) startPrefetch();
  // First render: use the initial (possibly inline) data for zero-latency paint
  if (!initialResolved) return initialPromise!;
  // After initial load: always fetch fresh from the backend cache
  return fetchFresh();
}
