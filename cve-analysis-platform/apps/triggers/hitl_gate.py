"""Human-in-the-Loop approval gate.

Pauses pipeline execution when a planned change set exceeds either of:
    - configured max files (default 5)
    - configured max lines (default 500)

The gate writes a summary JSON to `approval_file` (default
`.data/hitl/pending.json`) describing what will happen, and exposes two
operating modes:

    - "interactive" (default for CLI): prompt the operator on stdin/stdout
    - "non_interactive": write the pending file and return APPROVAL_PENDING;
       the caller decides whether to proceed (e.g. a separate `approve`
       command writes `.approved` next to the pending file).
"""
from __future__ import annotations

import json
import sys
import time
from dataclasses import dataclass, field
from enum import Enum
from pathlib import Path
from typing import Any, Optional


class ApprovalStatus(str, Enum):
    NOT_REQUIRED = "not_required"
    APPROVED = "approved"
    REJECTED = "rejected"
    PENDING = "pending"


@dataclass
class ApprovalSummary:
    files_changed: list[str]
    lines_changed: int
    stages: list[str]
    risk_level: str
    estimated_impact: str
    security_implications: list[str] = field(default_factory=list)
    triggered_thresholds: list[str] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "files_changed": list(self.files_changed),
            "files_changed_count": len(self.files_changed),
            "lines_changed": self.lines_changed,
            "stages": list(self.stages),
            "risk_level": self.risk_level,
            "estimated_impact": self.estimated_impact,
            "security_implications": list(self.security_implications),
            "triggered_thresholds": list(self.triggered_thresholds),
        }


@dataclass
class ApprovalResult:
    status: ApprovalStatus
    summary: Optional[ApprovalSummary] = None
    approver: Optional[str] = None
    pending_path: Optional[str] = None
    reason: Optional[str] = None

    def to_dict(self) -> dict[str, Any]:
        return {
            "status": self.status.value,
            "approver": self.approver,
            "pending_path": self.pending_path,
            "reason": self.reason,
            "summary": self.summary.to_dict() if self.summary else None,
        }


@dataclass
class HitlPolicy:
    enabled: bool = True
    max_files: int = 5
    max_lines: int = 500
    approval_file: str = ".data/hitl/pending.json"
    mode: str = "interactive"  # "interactive" | "non_interactive"


def _risk(files: int, lines: int, security_implications: list[str]) -> str:
    if security_implications:
        return "HIGH"
    if files >= 20 or lines >= 2000:
        return "HIGH"
    if files >= 10 or lines >= 1000:
        return "MEDIUM"
    return "LOW"


def evaluate(
    files_changed: list[str],
    lines_changed: int,
    stages: list[str],
    policy: HitlPolicy,
    security_implications: Optional[list[str]] = None,
) -> ApprovalResult:
    security_implications = security_implications or []
    if not policy.enabled:
        return ApprovalResult(status=ApprovalStatus.NOT_REQUIRED, reason="HITL disabled")

    triggered: list[str] = []
    if len(files_changed) > policy.max_files:
        triggered.append(f"files_changed={len(files_changed)} > max_files={policy.max_files}")
    if lines_changed > policy.max_lines:
        triggered.append(f"lines_changed={lines_changed} > max_lines={policy.max_lines}")

    if not triggered and not security_implications:
        return ApprovalResult(status=ApprovalStatus.NOT_REQUIRED, reason="below thresholds")

    summary = ApprovalSummary(
        files_changed=files_changed,
        lines_changed=lines_changed,
        stages=stages,
        risk_level=_risk(len(files_changed), lines_changed, security_implications),
        estimated_impact=(
            f"{len(files_changed)} file(s), {lines_changed} line(s) across stages: "
            f"{', '.join(stages) or '(none)'}"
        ),
        security_implications=security_implications,
        triggered_thresholds=triggered,
    )

    # Always persist the pending record for auditability.
    pending_path = Path(policy.approval_file)
    pending_path.parent.mkdir(parents=True, exist_ok=True)
    pending_path.write_text(
        json.dumps({
            "created_at": int(time.time()),
            "summary": summary.to_dict(),
        }, indent=2),
        encoding="utf-8",
    )

    if policy.mode == "non_interactive":
        return ApprovalResult(
            status=ApprovalStatus.PENDING,
            summary=summary,
            pending_path=str(pending_path),
            reason="awaiting human approval (non-interactive mode)",
        )

    # Interactive: prompt operator on stdin.
    _render_summary(summary, pending_path)
    try:
        raw = input("Approve and continue? [y/N]: ").strip().lower()
    except EOFError:
        raw = ""
    if raw in {"y", "yes"}:
        return ApprovalResult(
            status=ApprovalStatus.APPROVED,
            summary=summary,
            approver="stdin",
            pending_path=str(pending_path),
        )
    return ApprovalResult(
        status=ApprovalStatus.REJECTED,
        summary=summary,
        approver="stdin",
        pending_path=str(pending_path),
        reason="operator declined",
    )


def _render_summary(summary: ApprovalSummary, pending_path: Path) -> None:
    print("=" * 70, file=sys.stderr)
    print("HUMAN-IN-THE-LOOP APPROVAL REQUIRED", file=sys.stderr)
    print("-" * 70, file=sys.stderr)
    print(f"  Files changed   : {len(summary.files_changed)}", file=sys.stderr)
    print(f"  Lines changed   : {summary.lines_changed}", file=sys.stderr)
    print(f"  Risk level      : {summary.risk_level}", file=sys.stderr)
    print(f"  Pipeline stages : {', '.join(summary.stages) or '(none)'}", file=sys.stderr)
    print(f"  Impact          : {summary.estimated_impact}", file=sys.stderr)
    if summary.triggered_thresholds:
        print("  Triggered by    :", file=sys.stderr)
        for t in summary.triggered_thresholds:
            print(f"    - {t}", file=sys.stderr)
    if summary.security_implications:
        print("  Security flags  :", file=sys.stderr)
        for s in summary.security_implications:
            print(f"    - {s}", file=sys.stderr)
    print(f"  Audit record    : {pending_path}", file=sys.stderr)
    if len(summary.files_changed) <= 25:
        print("  Files:", file=sys.stderr)
        for fp in summary.files_changed:
            print(f"    - {fp}", file=sys.stderr)
    print("=" * 70, file=sys.stderr)
