import type { Status } from "../types";
import { cn } from "../lib/cn";

const labelMap: Record<Status, string> = {
  pending: "Pending",
  running: "Running",
  success: "Success",
  failed: "Failed",
  skipped: "Skipped",
};

const styleMap: Record<Status, string> = {
  pending: "bg-status-pending/10 text-status-pending ring-status-pending/20",
  running: "bg-status-running/10 text-status-running ring-status-running/30",
  success: "bg-status-success/10 text-status-success ring-status-success/30",
  failed: "bg-status-failed/10 text-status-failed ring-status-failed/30",
  skipped: "bg-status-skipped/10 text-status-skipped ring-status-skipped/20",
};

export default function StatusPill({ status, className }: { status: Status; className?: string }) {
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1.5 rounded px-2 py-0.5 text-[11px] font-medium ring-1 ring-inset",
        styleMap[status],
        className
      )}
    >
      <span
        className={cn(
          "h-1.5 w-1.5 rounded-full",
          status === "running" ? "animate-pulse" : "",
        )}
        style={{ background: "currentColor" }}
      />
      {labelMap[status]}
    </span>
  );
}
