import { cn } from "../lib/cn";

interface WaitingJobCardProps {
  /** Title of this job, e.g. "NIOS Build" */
  title: string;
  /** The job this one is waiting for, e.g. "NIOS-CVE-Repo (Orchestrator)" */
  waitingFor: string;
  /** Short description of what this job will do once triggered */
  description?: string;
  /** Position in the pipeline (1-based) */
  step: number;
  /** Total steps in the pipeline */
  totalSteps: number;
}

/**
 * Placeholder card shown when a pipeline run is in progress but this job
 * hasn't been triggered yet — its upstream dependency is still running.
 */
export default function WaitingJobCard({
  title,
  waitingFor,
  description,
  step,
  totalSteps,
}: WaitingJobCardProps) {
  return (
    <div className="rounded-xl border border-dashed border-line bg-surface-1 p-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2.5">
          {/* Step badge */}
          <span className="flex h-6 w-6 items-center justify-center rounded-full bg-surface-2 text-[10px] font-bold text-ink-subtle">
            {step}/{totalSteps}
          </span>
          <h3 className="text-sm font-semibold text-ink-subtle">{title}</h3>
        </div>
        {/* Waiting pill */}
        <span className="inline-flex items-center gap-1.5 rounded-full bg-amber-50 px-2.5 py-0.5 text-[10px] font-semibold text-amber-600 dark:bg-amber-950 dark:text-amber-400">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-amber-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-amber-500" />
          </span>
          Waiting
        </span>
      </div>

      {/* Progress bar at 0% */}
      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-surface-2" />

      {/* Info */}
      <div className="mt-3 space-y-1.5">
        <div className="flex items-center gap-1.5 text-xs text-ink-muted">
          <svg className="h-3.5 w-3.5 flex-shrink-0" fill="none" viewBox="0 0 24 24" stroke="currentColor" strokeWidth={2}>
            <path strokeLinecap="round" strokeLinejoin="round" d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" />
          </svg>
          Waiting for <span className="font-medium text-ink">{waitingFor}</span> to trigger this job
        </div>
        {description && (
          <p className="pl-5 text-[11px] leading-relaxed text-ink-subtle">
            {description}
          </p>
        )}
      </div>
    </div>
  );
}
