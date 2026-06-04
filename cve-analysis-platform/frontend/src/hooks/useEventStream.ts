import { useEffect, useRef, useState } from "react";
import { api } from "../api";
import type { RunEvent } from "../types";

/**
 * Subscribe to the live event stream for a run.
 * - Replays full history via REST first (so the UI has events even if WS
 *   silently fails behind a proxy).
 * - Opens a WebSocket and dedupes by `seq`.
 * - Auto-reconnects with linear back-off until a terminal event arrives.
 */
export function useEventStream(runId: string | undefined): {
  events: RunEvent[];
  connected: boolean;
  error: string | null;
} {
  const [events, setEvents] = useState<RunEvent[]>([]);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seenRef = useRef<Set<number>>(new Set());
  const wsRef = useRef<WebSocket | null>(null);
  const finishedRef = useRef(false);

  useEffect(() => {
    if (!runId) return;
    let cancelled = false;
    finishedRef.current = false;
    seenRef.current = new Set();
    setEvents([]);
    setError(null);

    function append(ev: RunEvent) {
      if (seenRef.current.has(ev.seq)) return;
      seenRef.current.add(ev.seq);
      setEvents((prev) => {
        const next = [...prev, ev];
        next.sort((a, b) => a.seq - b.seq);
        return next;
      });
      if (ev.event === "run.completed" || ev.event === "run.failed") {
        finishedRef.current = true;
      }
    }

    // 1) initial REST replay
    api
      .getEvents(runId, 0)
      .then((rows) => {
        if (cancelled) return;
        rows.forEach(append);
      })
      .catch((e) => setError(String(e)));

    // 2) WS live stream with reconnect
    let attempt = 0;
    function connect() {
      if (cancelled || finishedRef.current) return;
      const ws = new WebSocket(api.streamUrl(runId!));
      wsRef.current = ws;
      ws.onopen = () => {
        attempt = 0;
        setConnected(true);
        setError(null);
      };
      ws.onmessage = (msg) => {
        try {
          const ev = JSON.parse(msg.data) as RunEvent;
          append(ev);
        } catch (e) {
          /* ignore parse errors */
        }
      };
      ws.onerror = () => {
        setError("websocket error");
      };
      ws.onclose = () => {
        setConnected(false);
        wsRef.current = null;
        if (cancelled || finishedRef.current) return;
        attempt += 1;
        const delay = Math.min(5000, 500 * attempt);
        setTimeout(connect, delay);
      };
    }
    connect();

    return () => {
      cancelled = true;
      finishedRef.current = true;
      if (wsRef.current) {
        try {
          wsRef.current.close();
        } catch {
          /* ignore */
        }
        wsRef.current = null;
      }
    };
  }, [runId]);

  return { events, connected, error };
}
