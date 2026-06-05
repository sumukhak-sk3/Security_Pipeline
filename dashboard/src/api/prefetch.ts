/**
 * Single prefetch that loads ALL cached data.
 * 
 * Priority:
 * 1. window.__PREFETCH_DATA__ (injected into HTML by backend plugin — instant, zero latency)
 * 2. Fetch /_api/all (fallback if inline data missing)
 *
 * Hooks check this store first before making their own fetch calls.
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

let prefetchPromise: Promise<PrefetchData | null> | null = null;
let prefetchResult: PrefetchData | null = null;

// Check for inline data injected by the backend plugin (synchronous — zero latency)
if (typeof window !== "undefined" && window.__PREFETCH_DATA__) {
  prefetchResult = window.__PREFETCH_DATA__;
  prefetchPromise = Promise.resolve(prefetchResult);
}

/**
 * Trigger the prefetch (call once at app startup, e.g. in main.tsx).
 * Returns immediately if inline data was available.
 */
export function startPrefetch(): void {
  if (prefetchPromise) return;
  prefetchPromise = fetch("/_api/all")
    .then((res) => (res.ok ? res.json() : null))
    .then((data) => {
      prefetchResult = data;
      return data;
    })
    .catch(() => null);
}

/**
 * Get the prefetch result. Returns null if not yet loaded.
 */
export function getPrefetchSync(): PrefetchData | null {
  return prefetchResult;
}

/**
 * Await the prefetch result (resolves once the single request completes).
 */
export function awaitPrefetch(): Promise<PrefetchData | null> {
  if (!prefetchPromise) startPrefetch();
  return prefetchPromise!;
}
