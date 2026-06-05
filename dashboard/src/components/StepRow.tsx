import type { Step } from "../types";
import ProgressBar from "./ProgressBar";
import StatusPill from "./StatusPill";

export default function StepRow({ step }: { step: Step }) {
  return (
    <div className="grid grid-cols-[1fr_180px_90px] items-center gap-4 border-t border-line/60 px-12 py-2 first:border-t-0">
      <div className="min-w-0 truncate text-sm text-ink-muted">{step.name}</div>
      <ProgressBar value={step.progress} status={step.status} size="sm" />
      <div className="flex justify-end">
        <StatusPill status={step.status} />
      </div>
    </div>
  );
}
