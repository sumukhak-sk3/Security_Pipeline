import { useEffect, useRef, useState } from "react";
import { fetchConsoleProgressive } from "../api/jenkinsClient";
import { config } from "../config";

interface JenkinsConsoleDrawerProps {
  readonly open: boolean;
  readonly title: string;
  readonly jenkinsUrl: string;       // real Jenkins job URL
  readonly buildNumber: number | null;
  readonly building: boolean;        // true → poll live
  readonly onClose: () => void;
}

/**
 * Slide-in drawer that streams a Jenkins build's console log.
 * Uses the progressiveText endpoint for incremental updates while running.
 */
export default function JenkinsConsoleDrawer({
  open,
  title,
  jenkinsUrl,
  buildNumber,
  building,
  onClose,
}: JenkinsConsoleDrawerProps) {
  const [text, setText] = useState("");
  const [offset, setOffset] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const preRef = useRef<HTMLPreElement>(null);
  const stickToBottomRef = useRef(true);

  // Reset when target build changes / drawer opens
  useEffect(() => {
    if (!open || !jenkinsUrl || buildNumber == null) return;
    setText("");
    setOffset(0);
    setError(null);
  }, [open, jenkinsUrl, buildNumber]);

  // Fetch loop
  useEffect(() => {
    if (!open || !jenkinsUrl || buildNumber == null) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    async function tick(since: number) {
      if (cancelled || buildNumber == null) return;
      setLoading(true);
      try {
        const chunk = await fetchConsoleProgressive(
          jenkinsUrl,
          buildNumber,
          since,
        );
        if (cancelled) return;
        setError(null);
        if (chunk.text) {
          setText((t) => t + chunk.text);
        }
        setOffset(chunk.nextOffset);
        if (chunk.more || building) {
          timer = setTimeout(() => tick(chunk.nextOffset), config.api.pollIntervalMs);
        }
      } catch (e) {
        if (!cancelled) setError((e as Error).message);
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    tick(0);
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [open, jenkinsUrl, buildNumber, building]);

  // Auto-scroll to bottom unless user scrolled away
  useEffect(() => {
    const el = preRef.current;
    if (!el) return;
    if (stickToBottomRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [text]);

  function onScroll(e: React.UIEvent<HTMLPreElement>) {
    const el = e.currentTarget;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stickToBottomRef.current = atBottom;
  }

  // Esc to close
  useEffect(() => {
    if (!open) return;
    const h = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    globalThis.addEventListener("keydown", h);
    return () => globalThis.removeEventListener("keydown", h);
  }, [open, onClose]);

  if (!open) return null;

  const realConsoleUrl =
    jenkinsUrl && buildNumber != null
      ? `${jenkinsUrl.replace(/\/+$/, "")}/${buildNumber}/console`
      : "";

  return (
    <div className="fixed inset-0 z-40 flex">
      <button
        className="flex-1 bg-black/40"
        onClick={onClose}
        aria-label="Close console"
      />
      <aside className="flex w-full max-w-3xl flex-col bg-surface-0 shadow-2xl">
        <header className="flex items-center gap-3 border-b border-line px-4 py-3">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-semibold">{title}</div>
            <div className="text-[11px] text-ink-subtle">
              Build #{buildNumber ?? "—"}
              {building && <span className="ml-2 text-status-running">● live</span>}
              {loading && <span className="ml-2 text-ink-subtle">streaming…</span>}
            </div>
          </div>
          {realConsoleUrl && (
            <a
              href={realConsoleUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="rounded border border-line px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
            >
              Open in Jenkins ↗
            </a>
          )}
          <button
            onClick={onClose}
            className="rounded border border-line px-2 py-1 text-[11px] text-ink-muted hover:bg-surface-2 hover:text-ink"
          >
            Close
          </button>
        </header>
        {error && (
          <div className="border-b border-status-failed/40 bg-status-failed/10 px-4 py-2 text-xs text-status-failed">
            {error}
          </div>
        )}
        <pre
          ref={preRef}
          onScroll={onScroll}
          className="flex-1 overflow-auto bg-surface-1 px-4 py-3 font-mono text-[11px] leading-relaxed text-ink"
        >
          {text || (loading ? "Loading console…" : "(no output yet)")}
        </pre>
        <div className="border-t border-line bg-surface-1 px-4 py-2 text-[10px] text-ink-subtle">
          {offset > 0 ? `${offset.toLocaleString()} bytes` : "—"}
          {" · "}auto-refresh every {Math.round(config.api.pollIntervalMs / 1000)}s
        </div>
      </aside>
    </div>
  );
}
