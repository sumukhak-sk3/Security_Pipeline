"""Unit tests for the run artifact JSON."""
from __future__ import annotations

import json
import time
from pathlib import Path

from apps.triggers.run_artifact import RunArtifact


def test_finalize_sets_duration_and_status():
    a = RunArtifact(run_id="r1", trigger_reason="manual")
    time.sleep(0.01)
    a.finalize("ok")
    assert a.execution_time_ms >= 1
    assert a.final_status == "ok"
    assert a.completed_at is not None


def test_write_round_trips(tmp_path: Path):
    a = RunArtifact(
        run_id="r2",
        trigger_reason="git diff",
        files_changed=3,
        lines_changed=42,
        pipeline_stages_executed=["index", "security"],
        pipeline_stages_skipped=["lint"],
        ubuntu_security_api_results=[{"cve_id": "CVE-1", "ok": True}],
    ).finalize("ok")
    p = a.write(tmp_path / "runs" / "r2.json")
    assert p.exists()
    data = json.loads(p.read_text())
    assert data["run_id"] == "r2"
    assert data["files_changed"] == 3
    assert data["pipeline_stages_executed"] == ["index", "security"]
    assert data["ubuntu_security_api_results"][0]["cve_id"] == "CVE-1"
    assert data["execution_time_ms"] >= 0
