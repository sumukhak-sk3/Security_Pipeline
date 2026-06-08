import { useEffect, useMemo, useState } from "react";
import { useTheme } from "../theme/ThemeProvider";
import { useWorkflowLiveSummary } from "../hooks/useWorkflowLiveSummary";
import { workflowJobSpecs } from "../workflowJobs";
import StatusPill from "./StatusPill";
import type { Status } from "../types";

/** Reads the live orchestrator + CVE-BUILD state so the topbar reflects the
 *  real run number, status, and branch — no mock fallback. */
export default function TopBar() {
  const { theme, toggle } = useTheme();
  const liveE = useWorkflowLiveSummary(useMemo(() => workflowJobSpecs("E"), []));

  const orchestrator = liveE.jobs.find((j) => j.id === "e-orchestrator");
  const niosBuild = liveE.jobs.find((j) => j.id === "e-nios-build");

  // Branch comes from CVE-BUILD's BUILD_PATH param (set by the orchestrator).
  // Falls back to the orchestrator's own displayName if param isn't fetched yet.
  const [liveBranch, setLiveBranch] = useState<string>("");
  useEffect(() => {
    const params = niosBuild?.job?.lastBuild?.actions
      ?.flatMap((a: any) => a?.parameters ?? [])
      ?.reduce((acc: Record<string, string>, p: any) => {
        if (p?.name) acc[p.name] = p.value ?? "";
        return acc;
      }, {});
    const candidate = (params?.BUILD_PATH || params?.BUILD || "")
      .replace(/^origin\//, "");
    if (candidate) setLiveBranch(candidate);
  }, [niosBuild?.job]);

  const runId = orchestrator?.headline
    ? `NIOS-CVE-Repo #${orchestrator.headline.number}`
    : "—";

  // Overall status: running takes priority over failed (same rule as Overview).
  let overall: Status;
  if (liveE.jobsRunning > 0) overall = "running";
  else if (liveE.jobsFailed > 0) overall = "failed";
  else if (liveE.status === "success") overall = "success";
  else overall = liveE.status;

  return (
    <header className="flex h-14 shrink-0 items-center justify-between border-b border-line bg-surface-1 px-6">
      <div className="flex items-center gap-3">
        <div className="text-sm text-ink-muted">Current run</div>
        <div className="font-mono text-sm">{runId}</div>
        <StatusPill status={overall} />
        {liveBranch && (
          <>
            <div className="text-sm text-ink-muted">·</div>
            <div className="font-mono text-sm text-ink-muted">{liveBranch}</div>
          </>
        )}
      </div>

      <div className="flex items-center gap-2">
        <button
          className="rounded border border-line bg-surface-1 px-3 py-1.5 text-xs font-medium text-ink-muted hover:bg-surface-2 hover:text-ink"
          onClick={toggle}
          aria-label="Toggle theme"
        >
          {theme === "dark" ? "Light" : "Dark"}
        </button>
        <div className="grid h-8 w-8 place-items-center rounded-full bg-surface-2 text-xs font-semibold">
          SK
        </div>
      </div>
    </header>
  );
}
