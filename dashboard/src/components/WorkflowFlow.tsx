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
