"""Terminal progress reporter.

Subscribes to a `RunEventBus` and renders a compact, single-line
progress indicator on stderr plus an end-of-run summary block.

Kept dependency-free (no rich/tqdm) so it works in plain pipes and CI.
TTY detection avoids spraying carriage returns when stderr is a log
file — in that case we print one line per CVE completion instead.
"""
from __future__ import annotations

import sys
import threading
import time
from collections import Counter
from typing import TextIO

from .event_bus import Events, RunEvent, RunEventBus


_VERDICT_GLYPH = {
    "code_change": "🛠",
    "package_upgrade": "📦",
    "not_applicable": "✅",
    "needs_human": "👀",
}


def _fmt_secs(s: float) -> str:
    s = int(s)
    if s < 60:
        return f"{s}s"
    if s < 3600:
        return f"{s // 60}m{s % 60:02d}s"
    return f"{s // 3600}h{(s % 3600) // 60:02d}m"


class TerminalProgressReporter:
    """Render `[run] 23/65  ETA 18m  ✅12  📦8  🛠0  👀3  CVE-2026-7168 curl ...`."""

    def __init__(
        self,
        bus: RunEventBus,
        run_id: str,
        *,
        stream: TextIO | None = None,
        force_plain: bool = False,
    ) -> None:
        self.bus = bus
        self.run_id = run_id
        self.stream = stream or sys.stderr
        self._tty = (not force_plain) and self.stream.isatty()
        self._lock = threading.Lock()
        self._total = 0
        self._done = 0
        self._started_at = time.time()
        self._verdicts: Counter[str] = Counter()
        self._current = ""
        self._unsub = bus.subscribe(run_id, self._on_event)

    def close(self) -> None:
        try:
            self._unsub()
        finally:
            if self._tty:
                # leave a clean newline after the last \r line
                self.stream.write("\n")
                self.stream.flush()

    # ------------------------------------------------------------------

    def _on_event(self, ev: RunEvent) -> None:
        with self._lock:
            if ev.event == Events.CVE_QUEUED:
                self._total = int(ev.data.get("total") or self._total)
                self._render()
            elif ev.event == Events.CVE_STARTED:
                cve = ev.data.get("cve_id") or ""
                comp = ev.data.get("component") or ""
                ver = ev.data.get("version") or ""
                self._current = f"{cve} {comp} {ver}".strip()
                self._render()
            elif ev.event == Events.CVE_COMPLETED:
                self._done += 1
                v = ev.data.get("final_verdict") or "needs_human"
                self._verdicts[v] += 1
                self._render(line_after=ev)
            elif ev.event == Events.CVE_FAILED:
                self._done += 1
                self._verdicts["needs_human"] += 1
                self._render(line_after=ev)
            elif ev.event == Events.RUN_COMPLETED:
                self._render_summary()
            elif ev.event == Events.RUN_FAILED:
                self._render_summary(failed=True, reason=str(ev.data.get("reason") or ""))

    # ------------------------------------------------------------------

    def _eta_str(self) -> str:
        if self._done <= 0 or self._total <= 0:
            return "?"
        elapsed = time.time() - self._started_at
        rate = self._done / max(1e-6, elapsed)
        remaining = max(0, self._total - self._done)
        return _fmt_secs(remaining / max(1e-6, rate))

    def _tally_str(self) -> str:
        parts = []
        for k in ("not_applicable", "package_upgrade", "code_change", "needs_human"):
            parts.append(f"{_VERDICT_GLYPH[k]}{self._verdicts.get(k, 0)}")
        return " ".join(parts)

    def _render(self, line_after: RunEvent | None = None) -> None:
        if self._total <= 0:
            return
        pct = (self._done * 100 // self._total) if self._total else 0
        msg = (
            f"[{self.run_id}] {self._done}/{self._total} ({pct:3d}%)"
            f"  ETA {self._eta_str()}  {self._tally_str()}"
        )
        if self._current and self._done < self._total:
            msg += f"  ▶ {self._current[:60]}"
        if self._tty:
            # carriage-return overwrite
            self.stream.write("\r\x1b[2K" + msg)
            self.stream.flush()
            if line_after is not None:
                # print a permanent line for the completed CVE above the live bar
                self._print_done_line(line_after)
                self.stream.write("\r\x1b[2K" + msg)
                self.stream.flush()
        else:
            # non-TTY: print one line per completed CVE only
            if line_after is not None:
                self._print_done_line(line_after)

    def _print_done_line(self, ev: RunEvent) -> None:
        cve = ev.data.get("cve_id", "?")
        comp = ev.data.get("component", "?")
        ver = ev.data.get("version", "?")
        verdict = ev.data.get("final_verdict", "?")
        dur = ev.data.get("duration_ms")
        dur_s = f" ({dur/1000:.1f}s)" if isinstance(dur, (int, float)) else ""
        glyph = _VERDICT_GLYPH.get(verdict, "·")
        line = f"\n  {glyph} [{self._done}/{self._total}] {cve} {comp} {ver} → {verdict}{dur_s}"
        self.stream.write(line)
        self.stream.flush()

    def _render_summary(self, *, failed: bool = False, reason: str = "") -> None:
        elapsed = time.time() - self._started_at
        bar = "=" * 60
        title = "RUN FAILED" if failed else "RUN SUMMARY"
        lines = [
            "",
            bar,
            f" {title}  run={self.run_id}  elapsed={_fmt_secs(elapsed)}",
            bar,
            f"  total CVEs analyzed     : {self._done}",
        ]
        for k in ("code_change", "package_upgrade", "not_applicable", "needs_human"):
            lines.append(f"  {_VERDICT_GLYPH[k]} {k:<22}: {self._verdicts.get(k, 0)}")
        if failed and reason:
            lines.append(f"  reason: {reason}")
        lines.append(bar)
        self.stream.write("\n".join(lines) + "\n")
        self.stream.flush()
