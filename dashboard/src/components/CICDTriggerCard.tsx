import { useState, useRef, useEffect } from "react";
import { toProxyUrl } from "../api/jenkinsClient";
import StatusPill from "./StatusPill";
import { cn } from "../lib/cn";

const CICD_JOB_URL = "https://jenkins-qa2.inca.infoblox.com/job/IB_QA_CI_NIOS_CVE_Analyser";

interface TriggerState {
  status: "idle" | "triggering" | "running" | "success" | "failed";
  buildNumber: number | null;
  error: string | null;
}

/**
 * CICD Trigger Card — triggers the QA2 Jenkins pipeline with a branch parameter
 * and streams the console output live.
 */
export default function CICDTriggerCard() {
  const [branch, setBranch] = useState("");
  const [state, setState] = useState<TriggerState>({ status: "idle", buildNumber: null, error: null });
  const [consoleLines, setConsoleLines] = useState<string[]>([]);
  const [consoleOpen, setConsoleOpen] = useState(false);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const consoleEndRef = useRef<HTMLDivElement>(null);

  const proxyBase = toProxyUrl(CICD_JOB_URL);
  const today = new Date().toISOString().slice(0, 10);
  const defaultBranch = `bugfix/ubuntu-mirror-${today}`;

  // Auto-scroll console
  useEffect(() => {
    consoleEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [consoleLines]);

  // Cleanup poll on unmount
  useEffect(() => {
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, []);

  async function handleTrigger() {
    const effectiveBranch = branch.trim() || defaultBranch;
    setState({ status: "triggering", buildNumber: null, error: null });
    setConsoleLines([]);
    setConsoleOpen(true);

    try {
      // Trigger buildWithParameters
      const params = new URLSearchParams();
      params.set("BRANCH", effectiveBranch);

      const res = await fetch(`${proxyBase}/buildWithParameters`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });

      if (!res.ok && res.status !== 201) {
        setState({ status: "failed", buildNumber: null, error: `Trigger failed: ${res.status} ${res.statusText}` });
        return;
      }

      setState({ status: "running", buildNumber: null, error: null });
      setConsoleLines(["[info] Build triggered successfully. Waiting for build to start..."]);

      // Poll for the build number (queue → build)
      let buildNum: number | null = null;
      let attempts = 0;
      while (!buildNum && attempts < 30) {
        await new Promise((r) => setTimeout(r, 2000));
        attempts++;
        try {
          const jobRes = await fetch(`${proxyBase}/api/json?tree=lastBuild[number,building]`);
          if (jobRes.ok) {
            const jobData = await jobRes.json();
            if (jobData.lastBuild?.building || jobData.lastBuild?.number) {
              buildNum = jobData.lastBuild.number;
            }
          }
        } catch { /* retry */ }
      }

      if (!buildNum) {
        setState({ status: "failed", buildNumber: null, error: "Timed out waiting for build to start" });
        return;
      }

      setState({ status: "running", buildNumber: buildNum, error: null });
      setConsoleLines([`[info] Build #${buildNum} started. Streaming console...`]);

      // Stream console output
      let offset = 0;
      pollRef.current = setInterval(async () => {
        try {
          const consoleRes = await fetch(
            `${proxyBase}/${buildNum}/logText/progressiveText?start=${offset}`,
          );
          if (consoleRes.ok) {
            const text = await consoleRes.text();
            const moreData = consoleRes.headers.get("X-More-Data");
            const newOffset = consoleRes.headers.get("X-Text-Size");

            if (text.trim()) {
              const newLines = text.split("\n").filter((l) => l.length > 0);
              setConsoleLines((prev) => [...prev, ...newLines]);
            }

            if (newOffset) offset = parseInt(newOffset, 10);

            // Build finished
            if (moreData !== "true") {
              if (pollRef.current) clearInterval(pollRef.current);
              pollRef.current = null;
              // Check final result
              const resultRes = await fetch(`${proxyBase}/${buildNum}/api/json?tree=result`);
              if (resultRes.ok) {
                const resultData = await resultRes.json();
                const result = resultData.result;
                setState({
                  status: result === "SUCCESS" ? "success" : "failed",
                  buildNumber: buildNum,
                  error: result !== "SUCCESS" ? `Build finished: ${result}` : null,
                });
              }
            }
          }
        } catch { /* ignore poll errors */ }
      }, 3000);
    } catch (err: any) {
      setState({ status: "failed", buildNumber: null, error: err?.message ?? "Network error" });
    }
  }

  async function handleTestConnection() {
    setState({ status: "triggering", buildNumber: null, error: null });
    try {
      const res = await fetch(`${proxyBase}/api/json`, {
        headers: { Accept: "application/json" },
      });
      if (res.ok) {
        setState({ status: "idle", buildNumber: null, error: null });
        setConsoleLines(["[ok] Connection to QA2 Jenkins verified successfully."]);
        setConsoleOpen(true);
      } else {
        setState({ status: "failed", buildNumber: null, error: `Connection failed: ${res.status}` });
      }
    } catch (err: any) {
      setState({ status: "failed", buildNumber: null, error: err?.message ?? "Network error" });
    }
  }

  const statusMap = {
    idle: undefined,
    triggering: "running" as const,
    running: "running" as const,
    success: "success" as const,
    failed: "failed" as const,
  };

  return (
    <section className="rounded-xl border border-line bg-surface-1 p-4">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <h2 className="text-sm font-semibold">Trigger CICD Pipeline</h2>
          {state.status !== "idle" && <StatusPill status={statusMap[state.status]!} />}
        </div>
        {state.buildNumber && (
          <a
            href={`${CICD_JOB_URL}/${state.buildNumber}`}
            target="_blank"
            rel="noopener noreferrer"
            className="text-[10px] text-accent hover:underline"
          >
            Build #{state.buildNumber} ↗
          </a>
        )}
      </div>

      <p className="mt-1 text-[11px] text-ink-muted">
        Triggers <code className="rounded bg-surface-2 px-1">IB_QA_CI_NIOS_CVE_Analyser</code> on jenkins-qa2.
        Pass a branch name or leave blank for the default.
      </p>

      {/* Input + Buttons */}
      <div className="mt-3 flex items-end gap-3">
        <div className="flex-1">
          <label className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
            Branch (optional)
          </label>
          <input
            type="text"
            value={branch}
            onChange={(e) => setBranch(e.target.value)}
            placeholder={defaultBranch}
            disabled={state.status === "triggering" || state.status === "running"}
            className="mt-1 w-full rounded border border-line bg-surface-0 px-2.5 py-1.5 text-sm text-ink placeholder:text-ink-subtle focus:border-accent focus:outline-none disabled:opacity-50"
          />
        </div>
        <button
          onClick={handleTestConnection}
          disabled={state.status === "triggering" || state.status === "running"}
          className="rounded border border-line px-3 py-1.5 text-xs text-ink-muted hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
        >
          Test Connection
        </button>
        <button
          onClick={handleTrigger}
          disabled={state.status === "triggering" || state.status === "running"}
          className="rounded bg-accent px-4 py-1.5 text-xs font-semibold text-white hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-50"
        >
          {state.status === "running" ? "Running..." : "Trigger CICD"}
        </button>
      </div>

      {/* Default branch hint */}
      <div className="mt-1.5 text-[10px] text-ink-subtle">
        Default: <code className="rounded bg-surface-2 px-1">{defaultBranch}</code> · Target: <code className="rounded bg-surface-2 px-1">jenkins-qa2 / IB_QA_CI_NIOS_CVE_Analyser</code>
      </div>

      {/* Error */}
      {state.error && (
        <div className="mt-2 rounded border border-status-failed/40 bg-status-failed/10 px-3 py-1.5 text-[11px] text-status-failed">
          {state.error}
        </div>
      )}

      {/* Console output */}
      {consoleOpen && (
        <div className="mt-3 rounded border border-line bg-surface-0">
          <div className="flex items-center justify-between border-b border-line px-3 py-1.5">
            <span className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
              Console Output
            </span>
            <button
              onClick={() => setConsoleOpen(false)}
              className="text-[10px] text-ink-muted hover:text-ink"
            >
              Close
            </button>
          </div>
          <div className="max-h-64 overflow-y-auto p-3 font-mono text-[11px] leading-relaxed text-ink-muted">
            {consoleLines.length === 0 ? (
              <span className="text-ink-subtle">Waiting for output...</span>
            ) : (
              consoleLines.map((line, i) => (
                <div
                  key={i}
                  className={cn(
                    "whitespace-pre-wrap",
                    line.includes("ERROR") || line.includes("FATAL") ? "text-red-500" : "",
                    line.includes("[info]") || line.includes("[ok]") ? "text-green-500" : "",
                  )}
                >
                  {line}
                </div>
              ))
            )}
            <div ref={consoleEndRef} />
          </div>
        </div>
      )}
    </section>
  );
}
