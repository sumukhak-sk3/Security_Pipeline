import { useParams, Link, Navigate } from "react-router-dom";
import { recentRuns } from "../mock/data";
import WorkflowFlow from "../components/WorkflowFlow";
import StatusPill from "../components/StatusPill";
import ArtifactsPanel from "../components/ArtifactsPanel";
import PRStatusCard from "../components/PRStatusCard";
import { formatTime } from "../lib/format";

export default function RunDetail() {
  const { runId } = useParams();
  const run = recentRuns.find((r) => r.id === runId);
  if (!run) return <Navigate to="/history" replace />;

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
        <StatusPill status={run.status} />
      </section>

      <WorkflowFlow workflows={run.workflows} />

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-2">
        <ArtifactsPanel artifacts={run.artifacts} />
        <PRStatusCard pr={run.pr} />
      </div>
    </div>
  );
}
