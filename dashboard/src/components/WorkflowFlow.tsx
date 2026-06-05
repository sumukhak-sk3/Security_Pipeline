import { Fragment } from "react";
import type { Workflow } from "../types";
import ProgressBar from "./ProgressBar";
import StatusPill from "./StatusPill";
import { cn } from "../lib/cn";
import { Link } from "react-router-dom";
import { workflowShortName } from "../workflows";

export default function WorkflowFlow({ workflows }: { workflows: Workflow[] }) {
  return (
    <div className="rounded border border-line bg-surface-1 p-5">
      <div className="mb-4 flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold">End-to-end pipeline</div>
          <div className="text-xs text-ink-muted">Workflow E → Workflow B → Workflow D</div>
        </div>
        <Link
          to="/workflows/e"
          className={cn(
            "inline-flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium text-white shadow-sm transition-colors",
            "bg-accent hover:bg-accent/90 focus:outline-none focus:ring-2 focus:ring-accent/50",
          )}
        >
          <svg className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M14.752 11.168l-3.197-2.132A1 1 0 0010 9.87v4.263a1 1 0 001.555.832l3.197-2.132a1 1 0 000-1.664z" />
            <path strokeLinecap="round" strokeLinejoin="round" d="M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Trigger Pipeline
        </Link>
      </div>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-[1fr_auto_1fr_auto_1fr] md:items-stretch">
        {workflows.map((w, i) => (
          <Fragment key={w.id}>
            <WorkflowNode w={w} />
            {i < workflows.length - 1 && (
              <div
                className="hidden items-center justify-center text-ink-subtle md:flex"
                aria-hidden
              >
                →
              </div>
            )}
          </Fragment>
        ))}
      </div>
    </div>
  );
}

function WorkflowNode({ w }: { w: Workflow }) {
  return (
    <Link
      to={`/workflows/${w.id}`}
      className={cn(
        "group flex flex-col rounded border border-line bg-surface-1 p-4 transition-colors hover:border-accent/60 hover:bg-surface-2"
      )}
    >
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <div className="grid h-7 w-7 place-items-center rounded bg-surface-2 text-xs font-semibold text-ink-muted group-hover:text-ink">
            {w.id}
          </div>
          <div className="text-sm font-medium">{workflowShortName(w.id)}</div>
        </div>
        <StatusPill status={w.status} />
      </div>
      <div className="mt-3 text-xs leading-relaxed text-ink-muted line-clamp-2">{w.description}</div>
      <div className="mt-4">
        <ProgressBar value={w.progress} status={w.status} showLabel />
      </div>
      <div className="mt-2 text-[11px] text-ink-subtle">
        {w.jobs.filter((j) => j.status === "success").length} / {w.jobs.length} jobs complete
      </div>
    </Link>
  );
}
