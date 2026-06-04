"""Run-artifact JSON: lightweight summary written at the end of a pipeline run.

This is the artifact the user spec asked for: trigger reason, stages executed,
files/lines changed, HITL state, security findings, Ubuntu API results,
execution time, cache stats, final status.

Designed to be safe to read by other tools (CI dashboards, audit, etc.).
"""
from __future__ import annotations

import json
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional


@dataclass
class RunArtifact:
    run_id: str
    trigger_reason: str = ""
    files_changed: int = 0
    lines_changed: int = 0
    human_approval_required: bool = False
    human_approval_status: str = "not_required"
    pipeline_stages_executed: list[str] = field(default_factory=list)
    pipeline_stages_skipped: list[str] = field(default_factory=list)
    incremental_index_updates: dict[str, Any] = field(default_factory=dict)
    security_findings: list[dict[str, Any]] = field(default_factory=list)
    ubuntu_security_api_results: list[dict[str, Any]] = field(default_factory=list)
    cache_hits: int = 0
    cache_misses: int = 0
    execution_time_ms: int = 0
    final_status: str = "ok"
    started_at: float = field(default_factory=time.time)
    completed_at: Optional[float] = None
    notes: list[str] = field(default_factory=list)

    def finalize(self, status: str = "ok") -> "RunArtifact":
        self.completed_at = time.time()
        self.execution_time_ms = int((self.completed_at - self.started_at) * 1000)
        self.final_status = status
        return self

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "trigger_reason": self.trigger_reason,
            "files_changed": self.files_changed,
            "lines_changed": self.lines_changed,
            "human_approval_required": self.human_approval_required,
            "human_approval_status": self.human_approval_status,
            "pipeline_stages_executed": list(self.pipeline_stages_executed),
            "pipeline_stages_skipped": list(self.pipeline_stages_skipped),
            "incremental_index_updates": dict(self.incremental_index_updates),
            "security_findings": list(self.security_findings),
            "ubuntu_security_api_results": list(self.ubuntu_security_api_results),
            "cache_hits": self.cache_hits,
            "cache_misses": self.cache_misses,
            "execution_time_ms": self.execution_time_ms,
            "final_status": self.final_status,
            "started_at": self.started_at,
            "completed_at": self.completed_at,
            "notes": list(self.notes),
        }

    def write(self, path: str | Path) -> Path:
        p = Path(path)
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(json.dumps(self.to_dict(), indent=2), encoding="utf-8")
        return p
