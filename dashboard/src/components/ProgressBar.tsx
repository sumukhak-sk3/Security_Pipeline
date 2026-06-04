import type { Status } from "../types";
import { cn } from "../lib/cn";

const barColor: Record<Status, string> = {
  pending: "bg-status-pending/40",
  running: "bg-status-running",
  success: "bg-status-success",
  failed: "bg-status-failed",
  skipped: "bg-status-skipped/50",
};

export default function ProgressBar({
  value,
  status = "running",
  size = "md",
  showLabel = false,
  className,
}: {
  value: number;
  status?: Status;
  size?: "sm" | "md";
  showLabel?: boolean;
  className?: string;
}) {
  const v = Math.max(0, Math.min(100, Math.round(value)));
  const height = size === "sm" ? "h-1" : "h-1.5";

  return (
    <div className={cn("flex items-center gap-2", className)}>
      <div className={cn("relative w-full overflow-hidden rounded-full bg-surface-2", height)}>
        <div
          className={cn(
            "h-full rounded-full transition-[width] duration-500 ease-out",
            barColor[status],
            status === "running" && "progress-stripe"
          )}
          style={{ width: `${v}%` }}
        />
      </div>
      {showLabel && (
        <span className="w-9 shrink-0 text-right font-mono text-[11px] text-ink-muted">{v}%</span>
      )}
    </div>
  );
}
