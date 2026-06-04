#!/usr/bin/env python3
"""Top-level pipeline runner.

Orchestrates: git-trigger -> HITL gate -> incremental indexing -> CVE analysis
-> run-artifact JSON.

Examples:

    # Run from a git working tree; trigger off HEAD~1..HEAD
    python scripts/run_pipeline.py \
        --repo-root /path/to/nios \
        --vulns /path/to/vulns.json \
        --index-dir .data/index

    # Force-run all stages (skip trigger logic)
    python scripts/run_pipeline.py --repo-root ... --vulns ... --force-all

    # Non-interactive HITL (CI mode)
    python scripts/run_pipeline.py ... --hitl-mode non_interactive

The script always writes `.data/runs/<run_id>.json` summarizing the run.
"""
from __future__ import annotations

import argparse
import sys
import time
import uuid
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))

from apps.common.event_bus import RunEventBus  # noqa: E402
from apps.common.progress import TerminalProgressReporter  # noqa: E402
from apps.common.utils import load_dotenv_if_present, load_yaml  # noqa: E402
from apps.triggers.git_trigger import collect_changes, decide_stages  # noqa: E402
from apps.triggers.hitl_gate import ApprovalStatus, HitlPolicy, evaluate  # noqa: E402
from apps.triggers.run_artifact import RunArtifact  # noqa: E402


def _new_run_id() -> str:
    return f"run-{uuid.uuid4().hex[:12]}"


def _apply_patches_to_worktree(resp, repo_root: Path, artifact) -> None:
    """Apply code_change unified diffs to the working tree of repo_root.

    Never commits, never pushes. Uses `git apply --3way --reject` so failed
    hunks become *.rej files the engineer can inspect.
    """
    import subprocess
    import tempfile

    applied: list[dict] = []
    skipped: list[dict] = []

    is_git = (repo_root / ".git").exists()
    for r in resp.results:
        fix = getattr(r, "fix", None)
        if not fix:
            continue
        diff = getattr(fix, "patch_unified_diff", "") or ""
        if not diff.strip():
            skipped.append({"cve_id": r.cve_id, "reason": "no diff"})
            continue
        # Only apply when routing actually approved (handoff_workflow_e)
        if r.routing.decision.value != "handoff_workflow_e":
            skipped.append({
                "cve_id": r.cve_id,
                "reason": f"decision={r.routing.decision.value}; not applying"
            })
            continue
        # Write the diff next to the per-CVE artifacts for traceability
        diff_path = Path(r.artifacts_dir) / "applied_patch.diff"
        diff_path.write_text(diff, encoding="utf-8")

        with tempfile.NamedTemporaryFile(
            "w", suffix=f"_{r.cve_id}.diff", delete=False
        ) as tmp:
            tmp.write(diff)
            tmp_path = tmp.name

        if is_git:
            cmd = ["git", "apply", "--3way", "--reject", "--whitespace=nowarn", tmp_path]
        else:
            cmd = ["patch", "-p1", "-i", tmp_path, "--no-backup-if-mismatch"]
        proc = subprocess.run(
            cmd, cwd=str(repo_root), capture_output=True, text=True
        )
        ok = proc.returncode == 0
        entry = {
            "cve_id": r.cve_id,
            "files_touched": list(getattr(fix, "files_touched", []) or []),
            "lines_added": getattr(fix, "lines_added", 0),
            "lines_removed": getattr(fix, "lines_removed", 0),
            "tool": cmd[0],
            "ok": ok,
            "stdout_tail": (proc.stdout or "")[-400:],
            "stderr_tail": (proc.stderr or "")[-400:],
            "patch_file": str(diff_path),
        }
        applied.append(entry)
        print(
            f"[apply] {r.cve_id} -> {'OK' if ok else 'FAILED'} "
            f"({len(entry['files_touched'])} files)",
            file=sys.stderr,
        )

    artifact.notes.append(
        f"apply-patches: applied={sum(1 for a in applied if a['ok'])} "
        f"failed={sum(1 for a in applied if not a['ok'])} "
        f"skipped={len(skipped)}"
    )
    # Stash as a sub-field on the artifact for the run JSON / full report
    if not hasattr(artifact, "extra"):
        artifact.extra = {}  # type: ignore[attr-defined]
    artifact.security_findings.append({"_apply_patches_summary": True,
                                        "applied": applied, "skipped": skipped})


def main() -> None:
    load_dotenv_if_present()

    ap = argparse.ArgumentParser(description="Run the full CVE analysis pipeline")
    ap.add_argument("--repo-root", required=True)
    ap.add_argument("--vulns", default=None,
                    help="Path to vulns.json (required when 'security' stage runs)")
    ap.add_argument("--index-dir", default=".data/index")
    ap.add_argument("--base-ref", default="HEAD~1")
    ap.add_argument("--head-ref", default="HEAD")
    ap.add_argument("--force-all", action="store_true",
                    help="Skip trigger decision; run all stages")
    ap.add_argument("--hitl-mode", choices=["interactive", "non_interactive"],
                    default="interactive")
    ap.add_argument("--severities", nargs="*", default=["CRITICAL", "HIGH"])
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--mode", default="standard", choices=["standard", "urgent", "ad_hoc"])
    ap.add_argument("--runs-dir", default=".data/runs")
    ap.add_argument("--apply-patches", action="store_true",
                    help="Apply any code_change unified diffs into --repo-root "
                         "as working-tree edits (no commit, no push). "
                         "Patches that fail cleanly become .rej files.")
    ap.add_argument("--workers", type=int, default=None,
                    help="Number of parallel CVE workers. Overrides "
                         "cfg.workflow_d.max_parallel_cves. Default 1.")
    ap.add_argument("--no-progress", action="store_true",
                    help="Disable the live terminal progress reporter.")
    args = ap.parse_args()

    repo_root = Path(args.repo_root).resolve()
    if not repo_root.exists():
        sys.exit(f"repo root not found: {repo_root}")

    cfg = load_yaml(ROOT / "configs" / "app.yaml")
    artifact = RunArtifact(run_id=_new_run_id())

    # ---- 1. Trigger decision ------------------------------------------------
    if args.force_all:
        from apps.triggers.git_trigger import ChangeSet, TriggerDecision
        cs = ChangeSet(base_ref=args.base_ref, head_ref=args.head_ref,
                       files_changed=[], lines_added=0, lines_removed=0,
                       error="forced")
        decision = TriggerDecision(
            stages=["index", "security", "tests", "lint"],
            reason="forced via --force-all",
            changeset=cs,
        )
    else:
        cs = collect_changes(repo_root, args.base_ref, args.head_ref)
        decision = decide_stages(cs)

    artifact.trigger_reason = decision.reason
    artifact.files_changed = len(decision.changeset.files_changed)
    artifact.lines_changed = decision.changeset.total_lines
    artifact.pipeline_stages_executed = list(decision.stages)
    artifact.pipeline_stages_skipped = list(decision.skipped)

    print(f"[trigger] reason: {decision.reason}", file=sys.stderr)
    print(f"[trigger] stages: {decision.stages or '(none)'}", file=sys.stderr)
    if not decision.stages:
        artifact.finalize("skipped").write(Path(args.runs_dir) / f"{artifact.run_id}.json")
        print(f"[done] nothing to run; artifact at {artifact.run_id}.json")
        return

    # ---- 2. HITL gate -------------------------------------------------------
    hitl_cfg = cfg.get("hitl", {}) or {}
    hitl_policy = HitlPolicy(
        enabled=bool(hitl_cfg.get("enabled", True)),
        max_files=int(hitl_cfg.get("max_files_per_run", 5)),
        max_lines=int(hitl_cfg.get("max_lines_per_run", 500)),
        approval_file=str(hitl_cfg.get("approval_file", ".data/hitl/pending.json")),
        mode=args.hitl_mode,
    )
    security_flags: list[str] = []
    # Surface manifest changes as a security implication
    for f in decision.changeset.files_changed:
        low = f.lower()
        if low.endswith(("requirements.txt", "package.json", "go.mod", "cargo.lock",
                         "pipfile.lock", "package-lock.json", "yarn.lock",
                         "poetry.lock", "pnpm-lock.yaml")) or "debian/" in low:
            security_flags.append(f"dependency manifest changed: {f}")

    approval = evaluate(
        files_changed=decision.changeset.files_changed,
        lines_changed=decision.changeset.total_lines,
        stages=decision.stages,
        policy=hitl_policy,
        security_implications=security_flags,
    )
    artifact.human_approval_required = approval.status in {ApprovalStatus.PENDING,
                                                            ApprovalStatus.APPROVED,
                                                            ApprovalStatus.REJECTED}
    artifact.human_approval_status = approval.status.value
    if approval.status == ApprovalStatus.REJECTED:
        artifact.notes.append("rejected by operator")
        artifact.finalize("rejected").write(Path(args.runs_dir) / f"{artifact.run_id}.json")
        sys.exit("HITL rejected; pipeline aborted")
    if approval.status == ApprovalStatus.PENDING:
        artifact.notes.append(f"awaiting approval at {approval.pending_path}")
        artifact.finalize("pending_approval").write(Path(args.runs_dir) / f"{artifact.run_id}.json")
        print(f"[hitl] approval pending: {approval.pending_path}")
        return

    # ---- 3. Incremental indexing -------------------------------------------
    if "index" in decision.stages:
        from apps.coderag.incremental_indexer import update_index
        from apps.coderag.indexer import IndexerConfig

        coderag_cfg = cfg.get("coderag", {}) or {}
        icfg = IndexerConfig(
            chunk_lines=int(coderag_cfg.get("chunk_lines", 80)),
            chunk_overlap=int(coderag_cfg.get("chunk_overlap", 10)),
        )
        # When we have a real changeset, only re-index those paths.
        paths = decision.changeset.files_changed or None
        upd = update_index(
            repo_root=repo_root,
            out_dir=args.index_dir,
            cfg=icfg,
            workers=int(coderag_cfg.get("index_workers", 4)),
            explicit_paths=paths,
        )
        artifact.incremental_index_updates = upd.to_dict()
        print(f"[index] {len(upd.added)} added / {len(upd.modified)} modified / "
              f"{len(upd.deleted)} deleted / {upd.unchanged} unchanged "
              f"({upd.duration_ms} ms, full_rebuild={upd.full_rebuild})", file=sys.stderr)

    # ---- 4. Security (CVE analysis) ----------------------------------------
    if "security" in decision.stages:
        if not args.vulns:
            artifact.notes.append("security stage requested but --vulns not provided; skipped")
            print("[security] no --vulns supplied; skipping CVE analysis", file=sys.stderr)
        else:
            from apps.workflow_d.orchestrator import Orchestrator
            from apps.workflow_d.schemas import AnalyzeRequest
            from scripts.analyze_dt_findings import (
                filter_findings, load_findings, to_event,
            )

            findings, build_context = load_findings(Path(args.vulns).resolve())
            selected = filter_findings(findings, args.severities, None, args.limit)
            build_context["repo_root"] = str(repo_root)
            events = [to_event(f, build_context) for f in selected]

            # Honor --workers override before constructing the Orchestrator.
            if args.workers is not None:
                cfg.setdefault("workflow_d", {})["max_parallel_cves"] = max(1, int(args.workers))

            orch = Orchestrator(cfg)

            # Wire an event bus + (optional) terminal progress reporter.
            events_dir = Path(args.runs_dir) / "events"
            bus = RunEventBus(events_dir=events_dir)
            bus.open_run(artifact.run_id)
            orch.attach_event_bus(bus, artifact.run_id)
            reporter: TerminalProgressReporter | None = None
            if not args.no_progress:
                reporter = TerminalProgressReporter(bus, artifact.run_id)
            try:
                req = AnalyzeRequest(mode=args.mode, cves=events)
                resp = orch.analyze(req)
            finally:
                if reporter is not None:
                    reporter.close()
                bus.close_run(artifact.run_id)
            analysis_id = resp.analysis_id
            analysis_dir = Path(cfg.get("storage", {}).get("artifacts_dir", ".data/analyses")) / analysis_id
            for r in resp.results:
                artifact.security_findings.append({
                    "cve_id": r.cve_id,
                    "component": f"{r.component.name}@{r.component.current_version or '?'}",
                    "verdict": r.routing.final_verdict.value,
                    "decision": r.routing.decision.value,
                    "triage_confidence": r.confidence.triage_confidence,
                    "evidence_confidence": r.confidence.evidence_confidence,
                    "rationale": r.routing.reason,
                })
                ubu = (r.explanation.get("ubuntu_security_authority") or {})
                if ubu.get("queried"):
                    artifact.ubuntu_security_api_results.append({
                        "cve_id": r.cve_id,
                        "ok": ubu.get("ok"),
                        "status": ubu.get("status"),
                        "priority": ubu.get("priority"),
                        "usn_ids": ubu.get("usn_ids") or [],
                        "fixed_version": ubu.get("fixed_version"),
                        "source": ubu.get("source"),
                    })
            print(f"[security] analyzed {len(resp.results)} CVEs -> {analysis_id}",
                  file=sys.stderr)

            # Build a single comprehensive report that contains EVERYTHING:
            # summary + per-CVE analysis + evidence bundles + log.
            full_report = {
                "run_artifact": artifact.to_dict(),
                "analysis_id": analysis_id,
                "analysis_dir": str(analysis_dir),
                "analysis_result": resp.model_dump(mode="json"),
                "evidence_bundles": {},
                "analysis_log": None,
            }
            log_path = analysis_dir / "analysis_log.json"
            if log_path.exists():
                import json as _json
                try:
                    full_report["analysis_log"] = _json.loads(log_path.read_text(encoding="utf-8"))
                except Exception:  # noqa: BLE001
                    pass
            for r in resp.results:
                bp = analysis_dir / r.cve_id.replace("/", "_") / "evidence_bundle.json"
                if bp.exists():
                    import json as _json
                    try:
                        full_report["evidence_bundles"][r.cve_id] = _json.loads(
                            bp.read_text(encoding="utf-8")
                        )
                    except Exception:  # noqa: BLE001
                        pass
            full_path = Path(args.runs_dir) / f"{artifact.run_id}.full.json"
            full_path.parent.mkdir(parents=True, exist_ok=True)
            import json as _json
            full_path.write_text(_json.dumps(full_report, indent=2, default=str),
                                 encoding="utf-8")
            print(f"[report] full report -> {full_path}", file=sys.stderr)

            # ---- 4b. Apply patches (working-tree only, no commit) ----------
            if args.apply_patches:
                _apply_patches_to_worktree(resp, repo_root, artifact)

    # ---- 5. Run artifact ----------------------------------------------------
    artifact.finalize("ok").write(Path(args.runs_dir) / f"{artifact.run_id}.json")
    print(f"[done] {artifact.run_id} -> {args.runs_dir}/{artifact.run_id}.json")


if __name__ == "__main__":
    main()
