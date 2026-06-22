/**
 * WebSocket hook — connects to the backend plugin's /_ws endpoint.
 * Receives push updates for Jenkins job changes and RP result changes.
 * Components subscribe to specific event types.
 *
 * REVERSIBLE: Delete this file to remove WebSocket functionality.
 */

import { useEffect, useRef, useState, useCallback } from "react";

// ─── Type-safe WebSocket message definitions ────────────────────────────────

export interface JenkinsArtifactPayload {
  fileName: string;
  relativePath: string;
  downloadUrl: string;
}

export interface JenkinsJobPayload {
  name: string;
  url: string;
  lastBuild: { number: number; url: string; result: string | null; building: boolean; timestamp: number; duration: number; estimatedDuration?: number; displayName?: string } | null;
  lastCompletedBuild: { number: number; url: string; result: string; timestamp: number; duration: number; displayName?: string } | null;
  lastSuccessfulBuild: { number: number; url: string; result: string; timestamp: number; duration: number; displayName?: string } | null;
  builds: Array<{ number: number; url: string; result: string | null; building: boolean; timestamp: number; duration: number; displayName?: string }>;
  stages: unknown;
  buildParams: Record<string, string>;
  artifacts?: JenkinsArtifactPayload[];
  artifactsBuildNumber?: number | null;
}

export interface RPLaunchPayload {
  id: number;
  name: string;
  status: string;
  total: number;
  passed: number;
  failed: number;
  skipped: number;
  startTime?: string;
  endTime?: string;
  url: string;
  failedItems?: Array<{ name: string; path?: unknown; sampleLogs: Array<{ time: string; level: string; message: string }> }>;
}

export interface WsInitPayload {
  jenkins: Record<string, JenkinsJobPayload | null>;
  rp: { quick: RPLaunchPayload | null; slow: RPLaunchPayload | null } | null;
  branchTag: string | null;
}

export interface WsJenkinsUpdatePayload extends JenkinsJobPayload {
  jobId: string;
}

export interface WsRPUpdatePayload {
  branchTag: string;
  quickBranch: string;
  slowBranch: string;
  quick: RPLaunchPayload | null;
  slow: RPLaunchPayload | null;
}

export interface WsImpactUpdatePayload {
  healthy: boolean | null;
  health: unknown;
  indexes: unknown[] | null;
  latestRun: unknown;
  cveSummary?: ImpactCveSummaryPayload | null;
}

export interface ImpactCveSummaryPayload {
  runId: string;
  total: number;
  withDecision: number;
  withoutDecision: number;
  bySeverity: Record<string, number>;
  byVerdict: Record<string, number>;
  byStatus: Record<string, number>;
  fetchedAt: number;
}

export interface SbomSummaryPayload {
  buildNumber: number;
  buildUrl: string;
  builtAt?: number;
  project: string | null;
  components: number | null;
  groups: string[];
  buildLabel: string | null;
  dtrackUrl: string | null;
  bomUploaded: boolean;
  bomToken: string | null;
  parsedAt: number;
}

export interface S3CvePayload {
  key: string | null;
  lastModifiedMs: number;
  etag: string | null;
  fetchedAt: number;
  bucket: string;
  prefix: string;
  configured: boolean;
  totalCount: number;
  error: string | null;
}

export interface WsInitPayloadExtra {
  impact?: WsImpactUpdatePayload | null;
  sbom?: SbomSummaryPayload | null;
  s3Cve?: S3CvePayload | null;
}

export type WsMessage =
  | { type: "init"; payload: WsInitPayload & WsInitPayloadExtra; ts: number }
  | { type: "jenkins:update"; payload: WsJenkinsUpdatePayload; ts: number }
  | { type: "rp:update"; payload: WsRPUpdatePayload; ts: number }
  | { type: "impact:update"; payload: WsImpactUpdatePayload; ts: number }
  | { type: "sbom:update"; payload: SbomSummaryPayload; ts: number }
  | { type: "s3:update"; payload: S3CvePayload; ts: number };

export type WsMessageType = WsMessage["type"];

type Listener = (msg: WsMessage) => void;

// ─── Singleton WebSocket connection ─────────────────────────────────────────

let ws: WebSocket | null = null;
let listeners = new Set<Listener>();
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;

function getWsUrl(): string {
  const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${proto}//${window.location.host}/_ws`;
}

function connect(): void {
  if (ws?.readyState === WebSocket.OPEN || ws?.readyState === WebSocket.CONNECTING) return;

  ws = new WebSocket(getWsUrl());

  ws.onmessage = (event) => {
    try {
      const msg: WsMessage = JSON.parse(event.data);
      for (const listener of listeners) {
        listener(msg);
      }
    } catch { /* ignore malformed */ }
  };

  ws.onclose = () => {
    ws = null;
    // Reconnect after 2s
    if (reconnectTimer) clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(connect, 2000);
  };

  ws.onerror = () => {
    ws?.close();
  };
}

function subscribe(listener: Listener): () => void {
  listeners.add(listener);
  // Ensure connection is open
  connect();
  return () => {
    listeners.delete(listener);
    // Don't close — keep connection alive for other subscribers
  };
}

// ─── React hook ─────────────────────────────────────────────────────────────

/**
 * Subscribe to WebSocket messages. Returns the latest message matching
 * the specified type(s), or all messages if no filter is given.
 */
export function useBackendWs(types?: WsMessageType[]): WsMessage | null {
  const [lastMsg, setLastMsg] = useState<WsMessage | null>(null);
  const typesRef = useRef(types);
  typesRef.current = types;

  useEffect(() => {
    const unsub = subscribe((msg) => {
      if (!typesRef.current || typesRef.current.includes(msg.type)) {
        setLastMsg(msg);
      }
    });
    return unsub;
  }, []);

  return lastMsg;
}

/**
 * Hook that returns a callback to trigger a one-time WS-backed refresh.
 * Useful for forcing the backend to re-poll immediately.
 */
export function useWsRefresh(): () => void {
  return useCallback(() => {
    // For now, just trigger a re-fetch from cache via REST.
    // In future, can send a "refresh" command over WS.
  }, []);
}
