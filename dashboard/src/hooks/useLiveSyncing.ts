/**
 * Tracks whether the dashboard is showing inline pre-render data (possibly
 * stale) or live data confirmed by the backend WebSocket.
 *
 * Returns true while the inline `__PREFETCH_DATA__` is still the freshest
 * thing on screen and the WS `init`/`jenkins:update` hasn't arrived yet.
 * Components can show a "Syncing live data…" hint to acknowledge the gap.
 *
 * Auto-clears after the first WS message or after a 3s safety timeout, so
 * the indicator never gets stuck if the WS fails.
 */

import { useEffect, useState } from "react";
import { useBackendWs } from "./useBackendWs";
import { getPrefetchSync } from "../api/prefetch";

export function useLiveSyncing(): {
  syncing: boolean;
  cacheAgeMs: number | null;
  anyRunning: boolean;
} {
  const pre = getPrefetchSync() as
    | (ReturnType<typeof getPrefetchSync> & { cacheAgeMs?: number; anyRunning?: boolean })
    | null;
  const inlineAge = pre?.cacheAgeMs ?? null; // -1 means cache age unknown
  const inlineRunning = pre?.anyRunning === true;
  const ws = useBackendWs(["init", "jenkins:update"]);
  // Show syncing when: no inline data, unknown age, age > 4s, or pipeline is live.
  const [syncing, setSyncing] = useState<boolean>(() =>
    inlineAge == null || inlineAge < 0 || inlineRunning || inlineAge > 4000,
  );

  // Clear once the WS sends fresh data
  useEffect(() => {
    if (ws) setSyncing(false);
  }, [ws]);

  // Safety: never stay "syncing" forever
  useEffect(() => {
    if (!syncing) return;
    const t = setTimeout(() => setSyncing(false), 3000);
    return () => clearTimeout(t);
  }, [syncing]);

  return { syncing, cacheAgeMs: inlineAge, anyRunning: inlineRunning };
}
