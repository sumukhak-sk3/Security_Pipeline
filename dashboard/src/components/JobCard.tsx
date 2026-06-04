import { useState } from "react";
import type { Job } from "../types";
import ProgressBar from "./ProgressBar";
import StatusPill from "./StatusPill";
import StepRow from "./StepRow";
import { cn } from "../lib/cn";
import { formatDuration } from "../lib/format";

export default function JobCard({
  job,
  onOpenConsole,
}: {
  job: Job;
  onOpenConsole?: (job: Job) => void;
}) {
  const [open, setOpen] = useState(job.status === "running");

  const duration =
    job.startedAt && job.finishedAt
      ? formatDuration(new Date(job.finishedAt).getTime() - new Date(job.startedAt).getTime())
      : job.startedAt
      ? formatDuration(Date.now() - new Date(job.startedAt).getTime())
      : "—";

  return (
    <div className="rounded border border-line bg-surface-1">
      <button
        className="flex w-full items-center gap-4 px-4 py-3 text-left"
        onClick={() => setOpen((o) => !o)}
      >
        <span
          className={cn(
            "text-ink-subtle transition-transform",
            open && "rotate-90"
          )}
        >
          ▸
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <div className="truncate text-sm font-medium">{job.name}</div>
            <StatusPill status={job.status} />
          </div>
          <div className="mt-2">
            <ProgressBar value={job.progress} status={job.status} showLabel />
          </div>
        </div>
        <div className="hidden w-20 text-right text-xs text-ink-muted sm:block">{duration}</div>
        <button
          onClick={(e) => {
            e.stopPropagation();
            onOpenConsole?.(job);
          }}
          className="hidden rounded border border-line px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink sm:inline-block"
        >
          Console
        </button>
      </button>

      {open && (
        <div className="border-t border-line">
          {job.steps.map((s) => (
            <StepRow key={s.id} step={s} />
          ))}
        </div>
      )}
    </div>
  );
}
