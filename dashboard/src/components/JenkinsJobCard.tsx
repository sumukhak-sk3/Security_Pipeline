import { useState } from "react";
import { useJenkinsJob } from "../hooks/useJenkinsJob";
import type { JenkinsBuild, JenkinsStage } from "../api/jenkinsClient";
import StatusPill from "./StatusPill";
import ProgressBar from "./ProgressBar";
import JenkinsConsoleDrawer from "./JenkinsConsoleDrawer";
import { formatDuration } from "../lib/format";
import { cn } from "../lib/cn";
import { buildStatus, computeProgress, stageStatus } from "../lib/jenkinsMap";

/* ------------------------------------------------------------------ */
/* Local helpers                                                       */
/* ------------------------------------------------------------------ */

function relTime(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return `${Math.round(diff / 1000)}s ago`;
  if (diff < 3_600_000) return `${Math.round(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.round(diff / 3_600_000)}h ago`;
  return `${Math.round(diff / 86_400_000)}d ago`;
}

/* ------------------------------------------------------------------ */
/* Component                                                           */
/* ------------------------------------------------------------------ */

interface JobProps {
  readonly title: string;
  readonly jenkinsUrl: string;
}

export default function JenkinsJobCard({ title, jenkinsUrl }: JobProps) {
  const { loading, job, stages, error, refresh } = useJenkinsJob(jenkinsUrl);
  const [open, setOpen] = useState(false);
  const [consoleFor, setConsoleFor] = useState<number | null>(null);

  if (!jenkinsUrl) {
    return <NoJenkinsCard title={title} reason="No Jenkins URL configured" />;
  }
  if (loading && !job) {
    return <SkeletonCard title={title} />;
  }
  if (error || !job) {
    return (
      <ErrorCard
        title={title}
        jenkinsUrl={jenkinsUrl}
        error={error ?? "Job not found"}
        onRetry={refresh}
      />
    );
  }

  const headline: JenkinsBuild | null =
    job.lastBuild?.building ? job.lastBuild : job.lastCompletedBuild;
  const isRunning = !!headline?.building;
  const status = buildStatus(headline);
  const progress = computeProgress(headline, stages?.stages ?? null);
  const buildUrl = headline ? `${jenkinsUrl}/${headline.number}` : jenkinsUrl;

  const headlineConsoleBuild = headline?.number ?? null;

  const finishedAtLabel = (() => {
    if (!headline) return "—";
    if (isRunning) return relTime(headline.timestamp);
    return relTime(headline.timestamp + headline.duration);
  })();
  const durationMs = (() => {
    if (!headline) return 0;
    return isRunning ? Date.now() - headline.timestamp : headline.duration;
  })();

  return (
    <>
      <div className="rounded border border-line bg-surface-1">
        {/* Header row */}
        <div className="flex items-start gap-4 px-4 py-3">
          <button
            className={cn(
              "mt-0.5 text-ink-subtle transition-transform",
              open && "rotate-90",
            )}
            onClick={() => setOpen((o) => !o)}
            aria-label={open ? "Collapse" : "Expand"}
          >
            ▸
          </button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2">
              <div className="truncate text-sm font-medium">{title}</div>
              <StatusPill status={status} />
            </div>
            <div className="mt-1 text-[11px] text-ink-subtle">{job.name}</div>
            <div className="mt-3">
              <ProgressBar value={progress} status={status} showLabel />
            </div>
            <div className="mt-2 grid grid-cols-2 gap-2 text-[11px] text-ink-muted sm:grid-cols-4">
              <Field label="Build">
                {headline ? `#${headline.number}` : "—"}
              </Field>
              <Field label={isRunning ? "Started" : "Finished"}>
                {finishedAtLabel}
              </Field>
              <Field label="Duration">
                {headline ? formatDuration(durationMs) : "—"}
              </Field>
              <Field label="Last success">
                {job.lastSuccessfulBuild
                  ? `#${job.lastSuccessfulBuild.number} · ${relTime(job.lastSuccessfulBuild.timestamp)}`
                  : "—"}
              </Field>
            </div>
          </div>
          <div className="flex shrink-0 flex-col items-end gap-2">
            <button
              onClick={() => setConsoleFor(headlineConsoleBuild)}
              disabled={headlineConsoleBuild == null}
              className="rounded border border-line px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink disabled:cursor-not-allowed disabled:opacity-50"
            >
              Console
            </button>
            <a
              href={buildUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded border border-line px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              Open in Jenkins ↗
            </a>
            <button
              onClick={refresh}
              className="rounded border border-line px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              Refresh
            </button>
          </div>
        </div>

        {open && (
          <div className="border-t border-line">
            <StagesSection stages={stages?.stages ?? null} />
            <HistorySection
              builds={job.builds}
              onOpenConsole={(n) => setConsoleFor(n)}
              jenkinsUrl={jenkinsUrl}
            />
          </div>
        )}
      </div>

      <JenkinsConsoleDrawer
        open={consoleFor != null}
        title={title}
        jenkinsUrl={jenkinsUrl}
        buildNumber={consoleFor}
        building={isRunning && consoleFor === headlineConsoleBuild}
        onClose={() => setConsoleFor(null)}
      />
    </>
  );
}

/* ------------------------------------------------------------------ */
/* Sub-sections                                                        */
/* ------------------------------------------------------------------ */

function StagesSection({ stages }: { readonly stages: JenkinsStage[] | null }) {
  if (!stages || stages.length === 0) {
    return (
      <div className="px-4 py-3 text-[11px] text-ink-subtle">
        No pipeline stages available (freestyle job or build still queuing).
      </div>
    );
  }
  return (
    <div className="px-4 py-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
        Stages
      </div>
      <ol className="space-y-1">
        {stages.map((s) => {
          const st = stageStatus(s.status);
          return (
            <li
              key={s.id}
              className="flex items-center gap-3 rounded px-2 py-1 hover:bg-surface-2"
            >
              <StatusPill status={st} />
              <div className="min-w-0 flex-1 truncate text-xs">{s.name}</div>
              <div className="shrink-0 text-[10px] text-ink-subtle">
                {formatDuration(s.durationMillis)}
              </div>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

function HistorySection({
  builds,
  jenkinsUrl,
  onOpenConsole,
}: {
  readonly builds: JenkinsBuild[];
  readonly jenkinsUrl: string;
  readonly onOpenConsole: (n: number) => void;
}) {
  if (!builds || builds.length === 0) return null;
  return (
    <div className="border-t border-line px-4 py-3">
      <div className="mb-2 text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
        Recent builds
      </div>
      <ul className="space-y-1">
        {builds.map((b) => {
          const st = buildStatus(b);
          return (
            <li
              key={b.number}
              className="flex items-center gap-3 rounded px-2 py-1 hover:bg-surface-2"
            >
              <span className="w-12 shrink-0 font-mono text-[11px] text-ink-muted">
                #{b.number}
              </span>
              <StatusPill status={st} />
              <div className="min-w-0 flex-1 text-[11px] text-ink-muted">
                {relTime(b.timestamp)} · {formatDuration(b.duration || (b.building ? Date.now() - b.timestamp : 0))}
              </div>
              <button
                onClick={() => onOpenConsole(b.number)}
                className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-muted hover:bg-surface-1 hover:text-ink"
              >
                Console
              </button>
              <a
                href={`${jenkinsUrl}/${b.number}`}
                target="_blank"
                rel="noopener noreferrer"
                className="shrink-0 rounded border border-line px-1.5 py-0.5 text-[10px] text-ink-muted hover:bg-surface-1 hover:text-ink"
              >
                Open ↗
              </a>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/* ------------------------------------------------------------------ */
/* Small helpers                                                       */
/* ------------------------------------------------------------------ */

function Field({
  label,
  children,
}: {
  readonly label: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-ink-subtle">
        {label}
      </div>
      <div className="truncate text-ink">{children}</div>
    </div>
  );
}

function SkeletonCard({ title }: { readonly title: string }) {
  return (
    <div className="rounded border border-line bg-surface-1 px-4 py-3">
      <div className="flex items-center gap-2">
        <div className="truncate text-sm font-medium">{title}</div>
        <span className="text-[11px] text-ink-subtle">Loading…</span>
      </div>
      <div className="mt-3 h-2 w-full animate-pulse rounded bg-surface-2" />
    </div>
  );
}

function ErrorCard({
  title,
  jenkinsUrl,
  error,
  onRetry,
}: {
  readonly title: string;
  readonly jenkinsUrl: string;
  readonly error: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className="rounded border border-status-failed/40 bg-status-failed/5 px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <div className="truncate text-sm font-medium">{title}</div>
        <div className="flex shrink-0 gap-2">
          <a
            href={jenkinsUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="rounded border border-line px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            Open in Jenkins ↗
          </a>
          <button
            onClick={onRetry}
            className="rounded border border-line px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            Retry
          </button>
        </div>
      </div>
      <div className="mt-2 text-[11px] text-status-failed">{error}</div>
      <div className="mt-1 text-[10px] text-ink-subtle">
        Dev tip: restart <code>npm run dev</code> after editing <code>.env.local</code>.
      </div>
    </div>
  );
}

function NoJenkinsCard({
  title,
  reason,
}: {
  readonly title: string;
  readonly reason: string;
}) {
  return (
    <div className="rounded border border-dashed border-line bg-surface-1 px-4 py-3">
      <div className="flex items-center gap-2">
        <div className="truncate text-sm font-medium text-ink-muted">{title}</div>
        <span className="text-[11px] text-ink-subtle">{reason}</span>
      </div>
    </div>
  );
}
