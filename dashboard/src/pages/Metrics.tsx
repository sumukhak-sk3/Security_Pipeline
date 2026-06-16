import { useEffect, useState } from "react";
import { fetchCachedRP, fetchCachedRPForBranch, fetchCachedRPPrevious, type CachedRPLaunch } from "../api/cachedClient";
import { awaitPrefetch } from "../api/prefetch";

// ─── Baseline branch (develop/9.2 → develop_9.2 in RP) ─────────────────────
const BASELINE_BRANCH = "develop_9.2";

// ─── Types ──────────────────────────────────────────────────────────────────

interface UTComparison {
  current: CachedRPLaunch | null;
  baseline: CachedRPLaunch | null;
}

interface MetricsData {
  quick: UTComparison;
  slow: UTComparison;
  currentBranch: string;
  loading: boolean;
  error: string | null;
}

// ─── Stat card ──────────────────────────────────────────────────────────────

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded border border-line bg-surface-1 p-4">
      <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
        {label}
      </div>
      <div className="mt-1 text-2xl font-semibold tracking-tight">{value}</div>
      {hint && <div className="mt-1 text-xs text-ink-subtle">{hint}</div>}
    </div>
  );
}

// ─── UT Section ─────────────────────────────────────────────────────────────

function UTSection({ title, current, baseline, baselineLabel }: { title: string; current: CachedRPLaunch | null; baseline: CachedRPLaunch | null; baselineLabel: string }) {
  if (!current && !baseline) {
    return (
      <div className="rounded border border-line bg-surface-1 p-6">
        <div className="text-sm font-semibold">{title}</div>
        <p className="mt-2 text-xs text-ink-subtle">No RP data available.</p>
      </div>
    );
  }

  if (!current) {
    return (
      <div className="rounded border border-line bg-surface-1 p-6">
        <div className="text-sm font-semibold">{title}</div>
        <p className="mt-2 text-xs text-ink-subtle">No data for current run. {baselineLabel} has data.</p>
      </div>
    );
  }

  if (!baseline) {
    return (
      <div className="space-y-4">
        <div className="text-sm font-semibold">{title}</div>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Stat label="Total tests" value={String(current.total)} />
          <Stat label="Passed" value={String(current.passed)} hint={`${Math.round((current.passed / Math.max(current.total, 1)) * 100)}% pass rate`} />
          <Stat label="Failed" value={String(current.failed)} />
          <Stat label="Skipped" value={String(current.skipped)} />
        </div>
        <p className="text-xs text-ink-subtle">No previous run found to compare against.</p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <div className="text-sm font-semibold">{title}</div>

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Stat label="Total tests" value={String(current.total)} />
        <Stat label="Passed" value={String(current.passed)} hint={`${Math.round((current.passed / Math.max(current.total, 1)) * 100)}% pass rate`} />
        <Stat label="Failed" value={String(current.failed)} />
        <Stat label="Skipped" value={String(current.skipped)} />
      </div>

      {/* Comparison table */}
      <div className="rounded border border-line bg-surface-1 overflow-hidden">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-line bg-surface-2 text-left text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
              <th className="px-4 py-3">Metric</th>
              <th className="px-4 py-3">Current</th>
              <th className="px-4 py-3">{baselineLabel}</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-line">
            <tr>
              <td className="px-4 py-2 font-medium">Total</td>
              <td className="px-4 py-2">{current.total}</td>
              <td className="px-4 py-2">{baseline.total}</td>
            </tr>
            <tr>
              <td className="px-4 py-2 font-medium">Passed</td>
              <td className="px-4 py-2 text-emerald-500">{current.passed}</td>
              <td className="px-4 py-2">{baseline.passed}</td>
            </tr>
            <tr>
              <td className="px-4 py-2 font-medium">Failed</td>
              <td className="px-4 py-2 text-red-500">{current.failed}</td>
              <td className="px-4 py-2">{baseline.failed}</td>
            </tr>
            <tr>
              <td className="px-4 py-2 font-medium">Skipped</td>
              <td className="px-4 py-2">{current.skipped}</td>
              <td className="px-4 py-2">{baseline.skipped}</td>
            </tr>
          </tbody>
        </table>
      </div>

      {/* Links */}
      <div className="flex gap-4 text-xs">
        {current.url && (
          <a href={current.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
            View current launch in RP →
          </a>
        )}
        {baseline.url && (
          <a href={baseline.url} target="_blank" rel="noopener noreferrer" className="text-blue-400 hover:underline">
            View baseline launch in RP →
          </a>
        )}
      </div>
    </div>
  );
}

// ─── Main page ──────────────────────────────────────────────────────────────

export default function Metrics() {
  const [data, setData] = useState<MetricsData>({
    quick: { current: null, baseline: null },
    slow: { current: null, baseline: null },
    currentBranch: "",
    loading: true,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;

    async function load() {
      try {
        // Fetch current branch RP data
        const pre = await awaitPrefetch();
        const currentRP = pre?.rp ?? await fetchCachedRP();

        // Fetch baseline for quick_ut (develop/9.2)
        const baselineRP = await fetchCachedRPForBranch(BASELINE_BRANCH);

        // Fetch previous slow_ut run on the same branch
        const currentBranch = currentRP.branchTag || "bugfix_ubuntu-mirror";
        const prevSlow = await fetchCachedRPPrevious(currentBranch, "slow");

        if (cancelled) return;
        setData({
          quick: { current: currentRP.quick, baseline: baselineRP.quick },
          slow: { current: currentRP.slow, baseline: prevSlow },
          currentBranch,
          loading: false,
          error: null,
        });
      } catch (err: any) {
        if (cancelled) return;
        setData((d) => ({ ...d, loading: false, error: err.message }));
      }
    }

    load();
    return () => { cancelled = true; };
  }, []);

  const { quick, slow, currentBranch, loading, error } = data;

  if (loading) {
    return (
      <div className="flex h-64 items-center justify-center text-sm text-ink-subtle">
        Loading RP metrics…
      </div>
    );
  }

  if (error) {
    return (
      <div className="rounded border border-red-500/30 bg-red-500/5 p-4 text-sm text-red-400">
        Failed to load metrics: {error}
      </div>
    );
  }

  return (
    <div className="space-y-8">
      {/* Header */}
      <div>
        <div className="text-[11px] font-semibold uppercase tracking-wider text-ink-subtle">
          Metrics
        </div>
        <h1 className="mt-1 text-2xl font-semibold tracking-tight">UT — Baseline Comparison</h1>
        <p className="mt-1 text-xs text-ink-subtle">
          Comparing <span className="font-medium text-ink">{currentBranch.replace(/_/g, "/")}</span> against baseline{" "}
          <span className="font-medium text-ink">develop/9.2</span>
        </p>
      </div>

      {/* Quick UT — compared against develop/9.2 */}
      <UTSection title="Quick UT" current={quick.current} baseline={quick.baseline} baselineLabel="Baseline (develop/9.2)" />

      {/* Slow UT — compared against previous run on same branch */}
      <UTSection title="Slow UT" current={slow.current} baseline={slow.baseline} baselineLabel="Previous Run" />
    </div>
  );
}
