"""End-to-end /analyze using the fake LiteLLM from conftest.

This exercises orchestration without requiring real API keys.
"""
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from tests.conftest import set_fake_response, clear_fake_responses


@pytest.fixture
def app_client(tmp_path: Path, monkeypatch):
    cfg = f"""
service:
  host: 127.0.0.1
  port: 8088
  log_level: WARNING

storage:
  data_dir: {tmp_path}
  artifacts_dir: {tmp_path}/analyses
  registry_db: {tmp_path}/r.sqlite
  index_dir: {tmp_path}/index

models:
  author: gpt-5-mini-us-east-2-prod
  verifier: bedrock/claude-opus-4.7
  tiebreaker: ""
  request_timeout_s: 5
  max_retries: 1
  retry_backoff_s: 0.1
  proxy_base_url: ""
  proxy_api_key: ""

coderag:
  default_repo_root: ""
  chunk_lines: 40
  chunk_overlap: 5
  max_files_per_query: 4
  fallback_window_lines: 20
  fallback_score_threshold: 0.05

registry:
  verdict_ttl_days: 30

prompts_dir: {Path(__file__).resolve().parents[2] / "configs" / "prompts"}
policies_dir: {Path(__file__).resolve().parents[2] / "configs" / "policies"}
"""
    cfg_path = tmp_path / "app.yaml"
    cfg_path.write_text(cfg, encoding="utf-8")
    monkeypatch.setenv("WORKFLOW_D_CONFIG", str(cfg_path))

    from apps.workflow_d.api import create_app
    app = create_app(str(cfg_path))
    return TestClient(app)


def test_analyze_package_upgrade_path(app_client):
    clear_fake_responses()
    # Context, triage, fix, verifier — keyed by model name substring.
    set_fake_response("gpt", {
        "summary": "openssl runtime CVE; upstream fixed in 3.0.13",
        "code_references": [],
        "unknowns": [],
        "context_confidence": 0.8,
        # triage fields (same fake_completion for any author call)
        "verdict": "package_upgrade",
        "rationale": "Fixed version known; runtime component.",
        "evidence_ids": ["fixed_version", "runtime"],
        "triage_confidence": 0.9,
        # fix fields (won't be invoked for package_upgrade)
        "patch_unified_diff": "",
        "files_touched": [],
        "lines_added": 0, "lines_removed": 0,
        "verdict_override": None,
        "fix_confidence": 0.0,
    })
    set_fake_response("claude", {
        "verdict": "pass", "rationale": "n/a",
        "unresolved_concerns": [],
        "verifier_confidence": 0.9,
    })

    payload = {
        "mode": "standard",
        "cves": [{
            "cve_id": "CVE-2024-1234",
            "severity": {"label": "HIGH", "cvss": 8.0, "epss": 0.1, "exploited": False},
            "component": {"name": "openssl", "current_version": "3.0.11",
                           "ecosystem": "ubuntu", "fixed_version": "3.0.13"},
            "source": "dependency_track",
            "branches_affected": ["develop/9.2"],
            "external_links": [],
            "description": "Heap overflow in openssl certificate parsing."
        }]
    }
    resp = app_client.post("/analyze", json=payload)
    assert resp.status_code == 200, resp.text
    data = resp.json()
    assert data["total"] == 1
    result = data["results"][0]
    assert result["routing"]["final_verdict"] == "package_upgrade"
    assert result["routing"]["decision"] == "handoff_workflow_e"
    assert result["routing"]["auto_proceed"] is True


def test_health(app_client):
    resp = app_client.get("/health")
    assert resp.status_code == 200
    body = resp.json()
    assert body["status"] == "ok"
    assert "gpt" in body["author_model"]
    assert "claude" in body["verifier_model"]
