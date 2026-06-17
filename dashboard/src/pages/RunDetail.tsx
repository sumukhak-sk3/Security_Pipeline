import { useParams, Link, Navigate } from "react-router-dom";
import { useState, useEffect } from "react";
import { recentRuns } from "../mock/data";
import WorkflowFlow from "../components/WorkflowFlow";
import StatusPill from "../components/StatusPill";
import ArtifactsPanel from "../components/ArtifactsPanel";
import PRStatusCard from "../components/PRStatusCard";
import { formatTime } from "../lib/format";
import { raisePR, getRun } from "../api/impactClient";
import type { BackendRun } from "../api/impactClient";
import type { Run } from "../types";

export default function RunDetail() {
  const { runId } = useParams();
  const [backendRun, setBackendRun] = useState<BackendRun | null>(null);
  const [prState, setPrState] = useState<"idle" | "pending" | "success" | "failed">("idle");
  const [prUrl, setPrUrl] = useState<string | null>(null);
  const [prError, setPrError] = useState<string | null>(null);

  // Try to fetch real run data from backend
  useEffect(() => {
    if (runId) {
      getRun(runId).then(setBackendRun).catch(() => {
        // Silently ignore if run doesn't exist on backend
      });
    }
  }, [runId]);

  const mockRun = recentRuns.find((r) => r.id === runId);
  const run = mockRun;

  // Determine if run is successful (check both backend and mock data)
  const isSuccessful =
    run?.status === "success" ||
    (backendRun?.status && 
      (typeof backendRun.status === "string" 
        ? backendRun.status === "ok" 
        : backendRun.status.state === "ok"));

  if (!run) return <Navigate to="/history" replace />;

  const handleRaisePR = async () => {
    if (!runId) return;
    setPrState("pending");
    setPrError(null);
    setPrUrl(null);
    try {
      const result = await raisePR(runId);
      if (result.success && result.pr_url) {
        setPrState("success");
        setPrUrl(result.pr_url);
      } else {
        setPrState("failed");
        setPrError(result.message || "Failed to create PR");
      }
    } catch (e) {
      setPrError(String(e));
      setPrState("failed");
    }
  };

  return (
    <div className="space-y-6">
      <div className="text-xs">
        <Link to="/history" className="text-ink-muted hover:text-ink">
          ← Back to history
        </Link>
      </div>

      <section className="flex items-end justify-between">
        <div>
          <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
            Run detail
          </div>
          <h1 className="mt-1 font-mono text-2xl font-semibold tracking-tight">{run.id}</h1>
          <div className="mt-1 text-sm text-ink-muted">
            {run.branch} · started {formatTime(run.startedAt)}
          </div>
        </div>
        <div className="flex items-center gap-3">
          <StatusPill status={run.status} />
          <button
            disabled={!isSuccessful || prState === "pending" || prState === "success"}
            onClick={handleRaisePR}
            title={
              !isSuccessful
                ? "Available once the run completes successfully"
                : prState === "success"
                  ? "PR has been created"
                  : prState === "pending"
                    ? "Creating PR..."
                    : "Raise a PR with applied CVE fixes"
            }
            className="px-3 py-1 text-sm font-medium rounded bg-blue-600 text-white disabled:opacity-50 disabled:cursor-not-allowed hover:bg-blue-700 transition-colors"
          >
            {prState === "pending"
              ? "Creating PR…"
              : prState === "success"
                ? "✓ PR created"
                : "🔗 Raise PR"}
          </button>
          {prUrl && (
            <a href={prUrl} target="_blank" rel="noreferrer">
              <button className="px-3 py-1 text-sm font-medium rounded bg-gray-600 text-white hover:bg-gray-700 transition-colors">
                View on GitHub
              </button>
            </a>
          )}
        </div>
      </section>

      {prError && <div className="px-4 py-3 rounded bg-red-100 text-red-800 text-sm">{prError}</div>}

      <WorkflowFlow workflows={run.workflows} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ArtifactsPanel artifacts={run.artifacts} />
        <PRStatusCard pr={run.pr} />
      </div>
    </div>
  );
}
