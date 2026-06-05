"""Unit tests for HITL approval gate."""
from __future__ import annotations

import json
from pathlib import Path

from apps.triggers.hitl_gate import (
    ApprovalStatus,
    HitlPolicy,
    evaluate,
)


def _policy(tmp_path: Path, mode="non_interactive", **kw) -> HitlPolicy:
    return HitlPolicy(
        enabled=True,
        max_files=5,
        max_lines=500,
        approval_file=str(tmp_path / "pending.json"),
        mode=mode,
        **kw,
    )


def test_disabled_returns_not_required(tmp_path):
    p = _policy(tmp_path)
    p = HitlPolicy(enabled=False, approval_file=str(tmp_path / "p.json"))
    r = evaluate(["a", "b"], 10, ["index"], p)
    assert r.status is ApprovalStatus.NOT_REQUIRED


def test_below_thresholds_no_approval_needed(tmp_path):
    p = _policy(tmp_path)
    r = evaluate(["a.py", "b.py"], 50, ["tests"], p)
    assert r.status is ApprovalStatus.NOT_REQUIRED


def test_over_files_writes_pending(tmp_path):
    p = _policy(tmp_path)
    files = [f"f{i}.py" for i in range(6)]
    r = evaluate(files, 100, ["index", "tests"], p)
    assert r.status is ApprovalStatus.PENDING
    assert r.pending_path and Path(r.pending_path).exists()
    payload = json.loads(Path(r.pending_path).read_text())
    assert payload["summary"]["files_changed_count"] == 6


def test_over_lines_writes_pending(tmp_path):
    p = _policy(tmp_path)
    r = evaluate(["a.py"], 5000, ["security"], p)
    assert r.status is ApprovalStatus.PENDING
    assert any("lines_changed" in t for t in r.summary.triggered_thresholds)


def test_security_implications_always_trigger(tmp_path):
    p = _policy(tmp_path)
    r = evaluate(["a.py"], 1, ["index"], p,
                 security_implications=["CVE-2024-1234 affects openssl"])
    assert r.status is ApprovalStatus.PENDING
    assert r.summary.risk_level == "HIGH"
