import { useEffect, useRef } from "react";
import type { Job } from "../types";
import { cn } from "../lib/cn";
import { useJobLog } from "../hooks/useJobLog";
import { jenkinsConsoleUrl, jenkinsJobUrl } from "../config";

export default function ConsoleDrawer({
  runId,
  job,
  onClose,
}: {
  runId?: string;
  job: Job | null;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const open = !!job;
  const { lines, loading, error } = useJobLog(runId, job);

  // auto-scroll to bottom as new lines arrive
  const bottomRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [lines.length]);

  const jenkinsUrl =
    job?.jenkinsUrl ||
    (job && job.buildNumber
      ? jenkinsConsoleUrl(job.workflowId, job.id, job.buildNumber)
      : job
      ? jenkinsJobUrl(job.workflowId, job.id)
      : "");

  return (
    <>
      <div
        className={cn(
          "fixed inset-0 z-40 bg-black/30 transition-opacity",
          open ? "opacity-100" : "pointer-events-none opacity-0"
        )}
        onClick={onClose}
      />
      <aside
        className={cn(
          "fixed right-0 top-0 z-50 h-full w-full max-w-2xl border-l border-line bg-surface-1 shadow-card transition-transform",
          open ? "translate-x-0" : "translate-x-full"
        )}
        aria-hidden={!open}
      >
        <div className="flex h-14 items-center justify-between border-b border-line px-5">
          <div className="min-w-0">
            <div className="truncate text-sm font-semibold">{job?.name ?? ""}</div>
            <div className="text-[11px] text-ink-subtle">
              Console output {loading && "· streaming…"}
            </div>
          </div>
          <div className="flex items-center gap-2">
            {jenkinsUrl && (
              <a
                href={jenkinsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="rounded border border-line px-2 py-1 text-xs text-ink-muted hover:bg-surface-2 hover:text-ink"
              >
                Open in Jenkins ↗
              </a>
            )}
            <button
              onClick={onClose}
              className="rounded border border-line px-2 py-1 text-xs text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              Close
            </button>
          </div>
        </div>
        <div className="h-[calc(100%-3.5rem)] overflow-auto bg-surface-0 p-4 font-mono text-xs leading-relaxed text-ink-muted">
          {error && (
            <div className="mb-3 rounded border border-status-failed/40 bg-status-failed/10 px-3 py-2 text-status-failed">
              {error}
            </div>
          )}
          {lines.length === 0 && !error ? (
            <div className="text-ink-subtle">No log lines yet.</div>
          ) : (
            lines.map((l, i) => (
              <div key={i} className="whitespace-pre-wrap">
                {l}
              </div>
            ))
          )}
          <div ref={bottomRef} />
        </div>
      </aside>
    </>
  );
}
