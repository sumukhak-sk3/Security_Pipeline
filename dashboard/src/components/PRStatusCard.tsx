import type { PullRequest } from "../types";
import { relTime } from "../lib/format";

const stateStyles: Record<PullRequest["state"], string> = {
  open: "bg-status-running/10 text-status-running ring-status-running/30",
  approved: "bg-status-success/10 text-status-success ring-status-success/30",
  merged: "bg-accent/10 text-accent ring-accent/30",
  changes_requested: "bg-status-failed/10 text-status-failed ring-status-failed/30",
};

export default function PRStatusCard({ pr }: { pr?: PullRequest }) {
  return (
    <div className="rounded border border-line bg-surface-1">
      <div className="border-b border-line px-4 py-3 text-sm font-semibold">
        Pull request
      </div>
      {!pr ? (
        <div className="px-4 py-8 text-center text-xs text-ink-subtle">
          Awaiting Workflow D output — no PR raised yet.
        </div>
      ) : (
        <div className="space-y-3 p-4">
          <div className="flex items-center gap-2">
            <span
              className={`rounded px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset ${stateStyles[pr.state]}`}
            >
              {pr.state.replace("_", " ")}
            </span>
            <span className="font-mono text-xs text-ink-muted">#{pr.number}</span>
          </div>
          <div className="text-sm font-medium leading-snug">{pr.title}</div>
          <div className="text-xs text-ink-muted">
            {pr.repo} · {pr.branch}
          </div>
          <div className="flex items-center justify-between border-t border-line pt-3 text-[11px] text-ink-subtle">
            <span>by {pr.author}</span>
            <span>{relTime(pr.createdAt)}</span>
          </div>
          <a
            href={pr.url}
            className="block w-full rounded border border-line bg-surface-2 px-3 py-1.5 text-center text-xs font-medium text-ink hover:bg-surface-3"
          >
            Open in GitHub
          </a>
        </div>
      )}
    </div>
  );
}
