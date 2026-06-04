"""FastAPI surface for Workflow D.

Endpoints
---------

Core analysis (synchronous, low-level):
    GET  /health
    POST /analyze                       — run synchronously, return when done
    GET  /analysis/{analysis_id}        — fetch the analysis_result.json

Run lifecycle (asynchronous, manager-facing):
    POST /runs/start                    — kick off a pipeline run in a worker
                                          thread; returns the run_id immediately
    GET  /runs                          — list known runs (most recent first)
    GET  /runs/{run_id}                 — run artifact (summary, tallies)
    GET  /runs/{run_id}/events          — all events for the run as JSON list
                                          (supports ?since_seq=N cursor)
    GET  /runs/{run_id}/cves            — per-CVE rollup (one row per CVE)
    GET  /runs/{run_id}/cves/{cve_id}   — full per-CVE details (evidence,
                                          triage, fix, verifier, routing,
                                          explanation)
    WS   /runs/{run_id}/stream          — live event stream

Dashboard (static UI):
    GET  /                              — single-page manager dashboard

Design / security
-----------------
* ``run_id``, ``cve_id`` and ``analysis_id`` are validated against strict
  regexes to prevent path traversal when resolving filesystem artifacts.
* The event bus is a module-level singleton (see ``apps.common.event_bus``)
  so the synchronous orchestrator running inside a worker thread and the
  asyncio FastAPI WebSocket handler share the same in-memory state.
* Background runs run on a dedicated daemon thread per run; the
  Orchestrator already handles per-CVE parallelism internally, so we
  intentionally do NOT add asyncio concurrency on top of it.
* All file reads are scoped under the configured artifacts/runs dirs.
"""
from __future__ import annotations

import asyncio
import json
import os
import re
import subprocess
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
import uuid
from io import BytesIO
from pathlib import Path
from typing import Any

from fastapi import (
    FastAPI,
    File,
    HTTPException,
    Query,
    Request,
    UploadFile,
    WebSocket,
    WebSocketDisconnect,
)
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response

from ..common.event_bus import Events, RunEventBus, get_default_bus
from ..common.logging_utils import configure_logging, get_logger, log_event
from ..common.model_client import build_model_client
from ..common.utils import load_yaml
from .orchestrator import Orchestrator
from .schemas import AnalyzeRequest, AnalyzeResponse, HealthResponse

logger = get_logger(__name__)


_RUN_ID_RE = re.compile(r"^run-[a-f0-9]{6,32}$")
_CVE_ID_RE = re.compile(r"^[A-Z]+-\d{4}-\d{3,10}$")
_ANALYSIS_ID_RE = re.compile(r"^an-[a-f0-9]{6,32}$")
_JENKINS_TICKET_RE = re.compile(r"^[a-f0-9]{10,32}$")


def _resolve_config_path() -> str:
    explicit = os.environ.get("WORKFLOW_D_CONFIG")
    if explicit:
        return explicit
    candidates = [
        Path(__file__).resolve().parents[2] / "configs" / "app.yaml",
        Path.cwd() / "configs" / "app.yaml",
    ]
    for c in candidates:
        if c.exists():
            return str(c)
    raise RuntimeError("app.yaml not found; set WORKFLOW_D_CONFIG")


def _new_run_id() -> str:
    return f"run-{uuid.uuid4().hex[:12]}"


def _validate_run_id(run_id: str) -> None:
    if not _RUN_ID_RE.match(run_id):
        raise HTTPException(status_code=400, detail="invalid run_id")


def _validate_cve_id(cve_id: str) -> None:
    if not _CVE_ID_RE.match(cve_id):
        raise HTTPException(status_code=400, detail="invalid cve_id")


def _read_jsonl(path: Path) -> list[dict[str, Any]]:
    out: list[dict[str, Any]] = []
    if not path.exists():
        return out
    with path.open("r", encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                continue
    return out


# ---------------------------------------------------------------------------
# Background run dispatcher
# ---------------------------------------------------------------------------

class _RunRegistry:
    """Tracks in-flight runs started via POST /runs/start."""

    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._threads: dict[str, threading.Thread] = {}
        self._status: dict[str, dict[str, Any]] = {}
        # Per-run cooperative cancel signals; passed to the orchestrator
        # via Orchestrator.attach_cancel_token().
        self._cancel_tokens: dict[str, threading.Event] = {}

    def mark_started(self, run_id: str, payload: dict[str, Any]) -> None:
        with self._lock:
            self._status[run_id] = {
                "run_id": run_id,
                "state": "running",
                "started_at": time.time(),
                "request": payload,
            }
            self._cancel_tokens[run_id] = threading.Event()

    def mark_done(self, run_id: str, state: str, **extra: Any) -> None:
        with self._lock:
            cur = self._status.get(run_id, {"run_id": run_id})
            cur.update(state=state, ended_at=time.time(), **extra)
            self._status[run_id] = cur
            # Token stays around briefly (in case of late cancel race);
            # it's harmless because the worker thread is gone.

    def attach_thread(self, run_id: str, t: threading.Thread) -> None:
        with self._lock:
            self._threads[run_id] = t

    def status(self, run_id: str) -> dict[str, Any] | None:
        with self._lock:
            return dict(self._status.get(run_id) or {}) or None

    def cancel_token(self, run_id: str) -> threading.Event | None:
        with self._lock:
            return self._cancel_tokens.get(run_id)

    def request_cancel(self, run_id: str) -> bool:
        with self._lock:
            tok = self._cancel_tokens.get(run_id)
            st = self._status.get(run_id)
            if tok is None or st is None:
                return False
            if st.get("state") != "running":
                return False
            tok.set()
            st["cancel_requested_at"] = time.time()
            return True


def _derive_project_name(
    *, vulns_path: str | None, repo_root: str | None, git_url: str | None
) -> str:
    """Best-effort project name derived from inputs."""
    if repo_root:
        name = Path(repo_root).name
        if name:
            return name
    if git_url:
        tail = git_url.rstrip("/").split("/")[-1]
        return tail[:-4] if tail.endswith(".git") else tail
    if vulns_path:
        return Path(vulns_path).stem
    return "project"


# ---------------------------------------------------------------------------
# Path helpers
# ---------------------------------------------------------------------------

def _runs_dir(cfg: dict[str, Any]) -> Path:
    return Path(cfg.get("storage", {}).get("runs_dir") or ".data/runs")


def _artifacts_dir(cfg: dict[str, Any]) -> Path:
    return Path(cfg.get("storage", {}).get("artifacts_dir", ".data/analyses"))


def _events_dir(cfg: dict[str, Any]) -> Path:
    return _runs_dir(cfg) / "events"


def _jenkins_dir(cfg: dict[str, Any]) -> Path:
    return _runs_dir(cfg) / "jenkins"


def _jenkins_uploads_dir(cfg: dict[str, Any]) -> Path:
    return _jenkins_dir(cfg) / "uploads"


def _jenkins_upload_dir(cfg: dict[str, Any], ticket: str) -> Path:
    return _jenkins_uploads_dir(cfg) / ticket


def _jenkins_ticket_path(cfg: dict[str, Any], ticket: str) -> Path:
    return _jenkins_dir(cfg) / f"{ticket}.json"


def _jenkins_upload_meta_path(cfg: dict[str, Any], ticket: str) -> Path:
    return _jenkins_upload_dir(cfg, ticket) / "meta.json"


def _validate_jenkins_ticket(ticket: str) -> None:
    if not _JENKINS_TICKET_RE.match(ticket):
        raise HTTPException(status_code=400, detail="invalid ticket")


def _jenkins_job_url(base_url: str, job_name: str) -> str:
    parts = [p for p in (job_name or "").split("/") if p]
    if not parts:
        raise ValueError("jenkins.job_name is required")
    encoded = "/".join(f"job/{urllib.parse.quote(p, safe='')}" for p in parts)
    return f"{base_url.rstrip('/')}/{encoded}"


def _request_base_url(request: Request) -> str:
    return str(request.base_url).rstrip("/")


def _indexes_root(cfg: dict[str, Any]) -> Path:
    """Root for per-project indexes (one subdir per index)."""
    return Path(cfg.get("storage", {}).get("indexes_dir") or ".data/indexes")


def _legacy_index_dir(cfg: dict[str, Any]) -> Path:
    """Legacy single-index path (kept for backwards compatibility)."""
    return Path(cfg.get("storage", {}).get("index_dir") or ".data/index")


_INDEX_ID_RE = re.compile(r"^[A-Za-z0-9._\-]{1,128}$")


def _slugify(text: str) -> str:
    text = re.sub(r"[^A-Za-z0-9._\-]+", "-", text or "").strip("-._") or "x"
    return text[:48]


def _make_index_id(project: str, branch: str | None) -> str:
    proj = _slugify(project)
    br = _slugify(branch or "local")
    short = uuid.uuid4().hex[:8]
    return f"{proj}__{br}__{short}"


def _index_dir_for(cfg: dict[str, Any], index_id: str) -> Path:
    if not _INDEX_ID_RE.match(index_id):
        raise HTTPException(status_code=400, detail="invalid index_id")
    return _indexes_root(cfg) / index_id


def _list_indexes(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    """List all per-project indexes plus the legacy global index (if any)."""
    out: list[dict[str, Any]] = []
    root = _indexes_root(cfg)
    if root.exists():
        for d in sorted(root.iterdir()):
            if not d.is_dir() or not _INDEX_ID_RE.match(d.name):
                continue
            meta = _read_index_meta(d)
            if meta:
                out.append(meta)
    legacy = _legacy_index_dir(cfg)
    if (legacy / "meta.json").exists():
        meta = _read_index_meta(legacy)
        if meta:
            meta["index_id"] = "__legacy__"
            meta["name"] = meta.get("name") or "legacy (shared) index"
            meta["legacy"] = True
            out.append(meta)
    # Newest first
    out.sort(key=lambda m: m.get("updated_at") or m.get("created_at") or 0,
             reverse=True)
    return out


def _read_index_meta(index_dir: Path) -> dict[str, Any] | None:
    meta_path = index_dir / "meta.json"
    if not meta_path.exists():
        return None
    try:
        meta = json.loads(meta_path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    # Normalize a stable shape the UI can rely on.
    return {
        "index_id": meta.get("index_id") or index_dir.name,
        "name": meta.get("name") or meta.get("project") or index_dir.name,
        "source": meta.get("source"),
        "repo_root": meta.get("repo_root"),
        "git_url": meta.get("git_url"),
        "branch": meta.get("branch"),
        "files_indexed": meta.get("files_indexed"),
        "chunks": meta.get("chunks"),
        "created_at": meta.get("created_at"),
        "updated_at": meta.get("updated_at"),
        "path": str(index_dir),
    }


def _write_index_meta(index_dir: Path, meta: dict[str, Any]) -> None:
    """Merge our manifest-level fields into the existing meta.json (the
    indexer writes its own files_indexed/chunks keys; we keep them)."""
    meta_path = index_dir / "meta.json"
    cur: dict[str, Any] = {}
    if meta_path.exists():
        try:
            cur = json.loads(meta_path.read_text(encoding="utf-8")) or {}
        except (OSError, json.JSONDecodeError):
            cur = {}
    cur.update(meta)
    meta_path.parent.mkdir(parents=True, exist_ok=True)
    meta_path.write_text(json.dumps(cur, indent=2, default=str), encoding="utf-8")


def _start_meta_path(cfg: dict[str, Any], run_id: str) -> Path:
    return _runs_dir(cfg) / f"{run_id}.start.json"


def _read_start_meta(cfg: dict[str, Any], run_id: str) -> dict[str, Any] | None:
    p = _start_meta_path(cfg, run_id)
    if not p.exists():
        return None
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def _list_runs(cfg: dict[str, Any]) -> list[dict[str, Any]]:
    runs_dir = _runs_dir(cfg)
    events_dir = _events_dir(cfg)
    seen: dict[str, dict[str, Any]] = {}

    if runs_dir.exists():
        for p in runs_dir.glob("run-*.json"):
            rid = p.stem.replace(".full", "")
            if not _RUN_ID_RE.match(rid):
                continue
            seen.setdefault(rid, {"run_id": rid})
            seen[rid]["artifact_path"] = str(p)
            seen[rid]["mtime"] = p.stat().st_mtime

    if events_dir.exists():
        for p in events_dir.glob("run-*.events.jsonl"):
            rid = p.name.replace(".events.jsonl", "")
            if not _RUN_ID_RE.match(rid):
                continue
            seen.setdefault(rid, {"run_id": rid})
            seen[rid]["events_path"] = str(p)
            seen[rid].setdefault("mtime", p.stat().st_mtime)

    out = list(seen.values())
    out.sort(key=lambda r: r.get("mtime", 0), reverse=True)
    return out


def _load_run_artifact(cfg: dict[str, Any], run_id: str) -> dict[str, Any] | None:
    runs_dir = _runs_dir(cfg)
    for name in (f"{run_id}.full.json", f"{run_id}.json"):
        p = runs_dir / name
        if p.exists():
            try:
                return json.loads(p.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                log_event(logger, "api.read_artifact_failed",
                          run_id=run_id, error=str(exc))
                return None
    return None


def _load_run_events(
    cfg: dict[str, Any], run_id: str, since_seq: int = 0
) -> list[dict[str, Any]]:
    bus = get_default_bus(events_dir=str(_events_dir(cfg)))
    mem = bus.replay(run_id, since_seq=since_seq)
    if mem:
        return [ev.to_dict() for ev in mem]
    rows = _read_jsonl(_events_dir(cfg) / f"{run_id}.events.jsonl")
    return [r for r in rows if int(r.get("seq", 0)) > since_seq]


# ---------------------------------------------------------------------------
# create_app
# ---------------------------------------------------------------------------

def create_app(config_path: str | None = None) -> FastAPI:
    cfg_path = config_path or _resolve_config_path()
    cfg: dict[str, Any] = load_yaml(cfg_path)

    log_cfg = Path(cfg_path).parent / "logging.yaml"
    configure_logging(log_cfg if log_cfg.exists() else None)

    events_dir = _events_dir(cfg)
    events_dir.mkdir(parents=True, exist_ok=True)
    bus: RunEventBus = get_default_bus(events_dir=str(events_dir))

    orch = Orchestrator(cfg)
    runs = _RunRegistry()
    # Serializes per-run mutations of shared orchestrator attributes
    # (model_client swap, max_parallel_cves swap). Without this two
    # concurrent /runs/start calls with different model overrides could
    # race on the shared Orchestrator instance.
    orch_swap_lock = threading.Lock()

    app = FastAPI(title="CVE Analysis Platform — Workflow D", version="0.3.0")

    # CORS — React dev server runs on :5173 (Vite default) or :3000.
    # Origins are read from cfg["service"]["cors_origins"] when present;
    # default below covers local dev. Never set "*" in production.
    cors_origins = (
        cfg.get("service", {}).get("cors_origins")
        or [
            "http://localhost:5173",
            "http://127.0.0.1:5173",
            "http://localhost:3000",
            "http://127.0.0.1:3000",
        ]
    )
    app.add_middleware(
        CORSMiddleware,
        allow_origins=cors_origins,
        allow_credentials=False,
        allow_methods=["*"],
        allow_headers=["*"],
    )

    app.state.cfg = cfg
    app.state.bus = bus
    app.state.orchestrator = orch
    app.state.runs = runs
    app.state.orch_swap_lock = orch_swap_lock

    # ------------------------------------------------------------------
    # Health + legacy synchronous endpoints
    # ------------------------------------------------------------------

    @app.get("/health", response_model=HealthResponse)
    def health() -> HealthResponse:
        index_dir = cfg.get("storage", {}).get("index_dir")
        index_present = bool(index_dir and (Path(index_dir) / "meta.json").exists())
        return HealthResponse(
            author_model=cfg.get("models", {}).get("author", ""),
            verifier_model=cfg.get("models", {}).get("verifier", ""),
            index_present=index_present,
        )

    @app.post("/analyze", response_model=AnalyzeResponse)
    def analyze(request: AnalyzeRequest) -> AnalyzeResponse:
        try:
            return orch.analyze(request)
        except HTTPException:
            raise
        except Exception as exc:  # noqa: BLE001
            logger.exception("analyze failed")
            raise HTTPException(status_code=500, detail=f"analyze failed: {exc}") from exc

    @app.get("/analysis/{analysis_id}")
    def get_analysis(analysis_id: str) -> JSONResponse:
        if not _ANALYSIS_ID_RE.match(analysis_id):
            raise HTTPException(status_code=400, detail="invalid analysis_id")
        result_path = _artifacts_dir(cfg) / analysis_id / "analysis_result.json"
        if not result_path.exists():
            raise HTTPException(status_code=404, detail="analysis not found")
        try:
            data = json.loads(result_path.read_text(encoding="utf-8"))
        except OSError as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        return JSONResponse(data)

    # ------------------------------------------------------------------
    # Run lifecycle
    # ------------------------------------------------------------------

    @app.post("/runs/start")
    def start_run(payload: dict[str, Any]) -> JSONResponse:
        """Kick off a pipeline run asynchronously.

        Body schema (all optional except ``vulns_path``)::

            {
              "vulns_path": "/abs/path/to/sbom.csv|.xlsx|.json",
              "severities": ["CRITICAL","HIGH"],
              "limit": 20,
              "mode": "standard",
              "workers": 4,
              "repo_root": "/abs/path/to/repo",
              "index_id": "myproject__main__a1b2c3d4",
              "author_model": "...",
              "verifier_model": "..."
            }
        """
        vulns_path = payload.get("vulns_path")
        if not vulns_path or not Path(vulns_path).exists():
            raise HTTPException(status_code=400, detail="vulns_path missing or not found")

        severities = payload.get("severities") or ["CRITICAL", "HIGH"]
        limit = int(payload.get("limit") or 0) or None
        mode = payload.get("mode") or "standard"
        workers = payload.get("workers")
        repo_root = payload.get("repo_root") or cfg.get("coderag", {}).get("default_repo_root")
        author_model = payload.get("author_model") or None
        verifier_model = payload.get("verifier_model") or None
        index_id = payload.get("index_id") or None

        # Resolve per-project index directory when index_id is provided.
        index_dir_override: str | None = None
        index_meta: dict[str, Any] | None = None
        if index_id:
            if index_id == "__legacy__":
                index_dir_override = str(_legacy_index_dir(cfg))
                index_meta = _read_index_meta(_legacy_index_dir(cfg))
            else:
                if not _INDEX_ID_RE.match(index_id):
                    raise HTTPException(status_code=400, detail="invalid index_id")
                idx_path = _index_dir_for(cfg, index_id)
                if not (idx_path / "meta.json").exists():
                    raise HTTPException(status_code=404, detail="index_id not found")
                index_dir_override = str(idx_path)
                index_meta = _read_index_meta(idx_path)

        project = _derive_project_name(
            vulns_path=str(vulns_path),
            repo_root=repo_root,
            git_url=(index_meta or {}).get("git_url"),
        )

        run_id = _new_run_id()
        bus.open_run(run_id)
        runs.mark_started(run_id, payload)

        # Persist a sidecar so the dashboard can show project + index
        # name + per-CVE severity (severity is read off the loaded
        # events before analyze() runs) even after restart.
        start_meta = {
            "run_id": run_id,
            "project": project,
            "vulns_path": str(vulns_path),
            "repo_root": str(repo_root) if repo_root else None,
            "index_id": index_id,
            "index_dir": index_dir_override,
            "started_at": time.time(),
            "request": {k: v for k, v in payload.items() if k != "vulns_path"} | {
                "vulns_path": str(vulns_path),
            },
            "events": [],
        }

        def _worker() -> None:
            try:
                # Import lazily so the module loads even if scripts/ is
                # not on sys.path (e.g. when running under pytest).
                import sys as _sys
                root = str(Path(__file__).resolve().parents[2])
                if root not in _sys.path:
                    _sys.path.insert(0, root)
                from scripts.analyze_dt_findings import (  # noqa: WPS433
                    filter_findings, load_findings, to_event,
                )

                findings, build_context = load_findings(Path(vulns_path).resolve())
                if repo_root:
                    build_context["repo_root"] = str(repo_root)
                selected = filter_findings(findings, severities, None, limit or 0)
                events = [to_event(f, build_context) for f in selected]

                # Capture lightweight per-CVE metadata in the start sidecar
                # so the dashboard can show severity even after the run.
                # ``to_event`` may return either a CVEEvent pydantic model
                # or a plain dict depending on the loader path, so handle
                # both shapes defensively.
                def _ev_field(ev: Any, *names: str) -> Any:
                    for n in names:
                        if isinstance(ev, dict):
                            if n in ev and ev[n] is not None:
                                return ev[n]
                        else:
                            val = getattr(ev, n, None)
                            if val is not None:
                                return val
                    return None

                def _nested(ev: Any, parent: str, child: str) -> Any:
                    p = _ev_field(ev, parent)
                    if p is None:
                        return None
                    if isinstance(p, dict):
                        return p.get(child)
                    return getattr(p, child, None)

                start_meta["events"] = [
                    {
                        "cve_id": _ev_field(e, "cve_id"),
                        "severity": _nested(e, "severity", "label"),
                        "cvss": _nested(e, "severity", "cvss"),
                        "component": _nested(e, "component", "name"),
                        "version": _nested(e, "component", "current_version"),
                    }
                    for e in events
                ]
                start_meta["total"] = len(events)
                _start_meta_path(cfg, run_id).parent.mkdir(parents=True, exist_ok=True)
                _start_meta_path(cfg, run_id).write_text(
                    json.dumps(start_meta, indent=2, default=str), encoding="utf-8"
                )

                # Serialize attribute swaps on the shared Orchestrator so
                # concurrent /runs/start calls with different overrides
                # do not race. The actual analyze() call still runs in
                # parallel across CVEs internally.
                with orch_swap_lock:
                    prev_workers = orch.max_parallel_cves
                    prev_model_client = orch.model_client
                    prev_index_dir = getattr(
                        orch.evidence_builder, "default_index_dir", None
                    )
                    if workers is not None:
                        try:
                            orch.max_parallel_cves = max(1, int(workers))
                        except (TypeError, ValueError):
                            pass
                    if author_model or verifier_model:
                        new_models = dict(cfg.get("models") or {})
                        if author_model:
                            new_models["author"] = author_model
                        if verifier_model:
                            new_models["verifier"] = verifier_model
                        try:
                            orch.model_client = build_model_client(new_models)
                        except Exception as exc:  # noqa: BLE001
                            log_event(logger, "model_override.failed",
                                      run_id=run_id, error=str(exc))
                    if index_dir_override:
                        try:
                            orch.evidence_builder.default_index_dir = index_dir_override
                        except Exception as exc:  # noqa: BLE001
                            log_event(logger, "index_override.failed",
                                      run_id=run_id, error=str(exc))
                    try:
                        orch.attach_event_bus(bus, run_id)
                        orch.attach_cancel_token(runs.cancel_token(run_id))
                        req = AnalyzeRequest(mode=mode, cves=events)
                        resp = orch.analyze(req)
                    finally:
                        orch.attach_cancel_token(None)
                        orch.max_parallel_cves = prev_workers
                        orch.model_client = prev_model_client
                        if index_dir_override:
                            orch.evidence_builder.default_index_dir = prev_index_dir

                summary = {
                    "run_id": run_id,
                    "analysis_id": resp.analysis_id,
                    "mode": resp.mode.value,
                    "total": resp.total,
                    "project": project,
                    "index_id": index_id,
                    "results": [
                        {
                            "cve_id": r.cve_id,
                            "component": (
                                f"{r.component.name}@"
                                f"{r.component.current_version or '?'}"
                            ),
                            "verdict": r.routing.final_verdict.value,
                            "decision": r.routing.decision.value,
                        }
                        for r in resp.results
                    ],
                }
                runs_path = _runs_dir(cfg) / f"{run_id}.json"
                runs_path.parent.mkdir(parents=True, exist_ok=True)
                runs_path.write_text(
                    json.dumps(summary, indent=2, default=str), encoding="utf-8"
                )

                # ---- Assemble <run_id>.full.json for XLSX export ---------
                # The CLI run_pipeline.py writes this same shape; without
                # it the GET /runs/{rid}/report.xlsx endpoint 404s. We
                # synthesise a minimal but compatible run_artifact and
                # collect per-CVE evidence bundles from disk.
                try:
                    analysis_dir = _artifacts_dir(cfg) / resp.analysis_id
                    started_ts = start_meta.get("started_at")
                    run_artifact_dict: dict[str, Any] = {
                        "run_id": run_id,
                        "status": "ok",  # backfilled below if cancelled
                        "started_at": started_ts,
                        "ended_at": time.time(),
                        "repo_root": str(repo_root) if repo_root else None,
                        "pipeline_stages_executed": ["analyze"],
                        "files_changed": 0,
                        "index_update": {},
                        "ubuntu_security_api_results": [],
                    }
                    evidence_bundles: dict[str, Any] = {}
                    for r in resp.results:
                        bp = analysis_dir / r.cve_id.replace("/", "_") / "evidence_bundle.json"
                        if bp.exists():
                            try:
                                evidence_bundles[r.cve_id] = json.loads(
                                    bp.read_text(encoding="utf-8")
                                )
                            except (OSError, json.JSONDecodeError):
                                pass
                        # Surface Ubuntu enrichment in run_artifact so the
                        # XLSX "Ubuntu Status" columns populate. The
                        # bundle has historically stored this under
                        # advisory_status.ubuntu (when advisory_status
                        # is a dict) or as a top-level ubuntu_security
                        # block on newer runs — accept both shapes.
                        bundle = evidence_bundles.get(r.cve_id) or {}
                        ubu: dict[str, Any] = {}
                        adv = bundle.get("advisory_status")
                        if isinstance(adv, dict):
                            cand = adv.get("ubuntu")
                            if isinstance(cand, dict):
                                ubu = cand
                        if not ubu:
                            cand2 = bundle.get("ubuntu_security")
                            if isinstance(cand2, dict):
                                ubu = cand2
                        if ubu.get("queried") or ubu.get("ok") or ubu.get("status"):
                            run_artifact_dict["ubuntu_security_api_results"].append({
                                "cve_id": r.cve_id,
                                "ok": ubu.get("ok"),
                                "status": ubu.get("status"),
                                "priority": ubu.get("priority"),
                                "usn_ids": ubu.get("usn_ids") or [],
                                "fixed_version": ubu.get("fixed_version"),
                                "source": ubu.get("source"),
                            })
                    analysis_log: Any = None
                    log_path = analysis_dir / "analysis_log.json"
                    if log_path.exists():
                        try:
                            analysis_log = json.loads(
                                log_path.read_text(encoding="utf-8")
                            )
                        except (OSError, json.JSONDecodeError):
                            analysis_log = None
                    full_report = {
                        "run_artifact": run_artifact_dict,
                        "analysis_id": resp.analysis_id,
                        "analysis_dir": str(analysis_dir),
                        "analysis_result": resp.model_dump(mode="json"),
                        "evidence_bundles": evidence_bundles,
                        "analysis_log": analysis_log,
                    }
                    full_path = _runs_dir(cfg) / f"{run_id}.full.json"
                    full_path.write_text(
                        json.dumps(full_report, indent=2, default=str),
                        encoding="utf-8",
                    )
                    log_event(logger, "run.full_report_written",
                              run_id=run_id, path=str(full_path),
                              bundles=len(evidence_bundles))
                except Exception as exc:  # noqa: BLE001
                    log_event(logger, "run.full_report_failed",
                              run_id=run_id, error=str(exc))

                # If the run was cancelled cooperatively, surface that as
                # the registry state so the dashboard renders correctly.
                tok = runs.cancel_token(run_id)
                final_state = "cancelled" if (tok and tok.is_set()) else "ok"
                # Backfill the actual status into the full report now that
                # we know whether the run was cancelled.
                try:
                    full_path = _runs_dir(cfg) / f"{run_id}.full.json"
                    if full_path.exists():
                        fr = json.loads(full_path.read_text(encoding="utf-8"))
                        fr.setdefault("run_artifact", {})["status"] = final_state
                        full_path.write_text(
                            json.dumps(fr, indent=2, default=str),
                            encoding="utf-8",
                        )
                except Exception:  # noqa: BLE001
                    pass
                runs.mark_done(run_id, final_state,
                               analysis_id=resp.analysis_id, total=resp.total)
            except Exception as exc:  # noqa: BLE001
                logger.exception("background run failed")
                bus.publish(run_id, Events.RUN_FAILED, reason=str(exc))
                runs.mark_done(run_id, "failed", error=str(exc))
            finally:
                bus.close_run(run_id)

        t = threading.Thread(target=_worker, name=f"run-{run_id}", daemon=True)
        runs.attach_thread(run_id, t)
        t.start()
        return JSONResponse({"run_id": run_id, "state": "running"}, status_code=202)

    @app.post("/runs/{run_id}/cancel")
    def cancel_run(run_id: str) -> JSONResponse:
        """Request cooperative cancellation of an in-flight run.

        Already-running CVE analyses finish naturally; pending CVEs are
        skipped. The run resolves with state ``cancelled`` and emits
        ``run.failed`` with ``reason="cancelled"`` to the WebSocket.
        """
        _validate_run_id(run_id)
        ok = runs.request_cancel(run_id)
        if not ok:
            st = runs.status(run_id)
            if st is None:
                raise HTTPException(status_code=404, detail="run not found")
            raise HTTPException(
                status_code=409,
                detail=f"run not cancellable (state={st.get('state')})",
            )
        log_event(logger, "run.cancel_requested", run_id=run_id)
        return JSONResponse({"run_id": run_id, "cancel_requested": True})

    @app.get("/config")
    def get_config() -> JSONResponse:
        """Expose UI-relevant configuration: worker bounds, defaults.

        The UI uses this to populate the workers dropdown with valid
        values instead of accepting arbitrary user input.
        """
        wf = cfg.get("workflow_d", {}) or {}
        coderag_cfg = cfg.get("coderag", {}) or {}
        max_workers = int(wf.get("max_parallel_cves") or orch.max_parallel_cves or 4)
        # Build a sane set of selectable worker counts up to the cap.
        steps = [1, 2, 4, 8, 16, 32]
        choices = sorted({s for s in steps if s <= max_workers} | {max_workers})
        return JSONResponse({
            "max_parallel_cves": max_workers,
            "default_parallel_cves": orch.max_parallel_cves,
            "worker_choices": choices,
            "default_repo_root": coderag_cfg.get("default_repo_root"),
            "default_severities": wf.get("default_severities") or ["CRITICAL", "HIGH"],
            "models": {
                "author": (cfg.get("models") or {}).get("author"),
                "verifier": (cfg.get("models") or {}).get("verifier"),
            },
        })

    @app.get("/runs")
    def list_runs() -> JSONResponse:
        rows = _list_runs(cfg)
        for r in rows:
            st = runs.status(r["run_id"])
            if st:
                r["state"] = st.get("state")
                r["started_at"] = st.get("started_at")
                r["ended_at"] = st.get("ended_at")
            # Enrich with the persisted start-metadata so the dashboard
            # has project name + total + index even after restart.
            sm = _read_start_meta(cfg, r["run_id"])
            if sm:
                r["project"] = sm.get("project")
                r["index_id"] = sm.get("index_id")
                r["vulns_path"] = sm.get("vulns_path")
                r["total_cves"] = sm.get("total")
                r["started_at"] = r.get("started_at") or sm.get("started_at")
            # If we still don't know the state but an artifact exists, the
            # run is archived/completed.
            if not r.get("state") and r.get("artifact_path"):
                r["state"] = "completed"
        return JSONResponse({"runs": rows})

    @app.get("/runs/{run_id}")
    def get_run(run_id: str) -> JSONResponse:
        _validate_run_id(run_id)
        artifact = _load_run_artifact(cfg, run_id)
        status = runs.status(run_id)
        if not artifact and not status:
            raise HTTPException(status_code=404, detail="run not found")
        return JSONResponse({
            "run_id": run_id,
            "status": status,
            "artifact": artifact,
        })

    @app.get("/runs/{run_id}/events")
    def get_run_events(
        run_id: str, since_seq: int = Query(default=0, ge=0)
    ) -> JSONResponse:
        _validate_run_id(run_id)
        return JSONResponse({
            "run_id": run_id,
            "since_seq": since_seq,
            "events": _load_run_events(cfg, run_id, since_seq=since_seq),
        })

    @app.get("/runs/{run_id}/cves")
    def get_run_cves(run_id: str) -> JSONResponse:
        _validate_run_id(run_id)
        artifact = _load_run_artifact(cfg, run_id)
        # Index per-CVE input metadata (severity, cvss) from the start
        # sidecar so the dashboard can render severity even though
        # CVEAnalysis itself doesn't carry it.
        start_meta = _read_start_meta(cfg, run_id) or {}
        sev_by_cve: dict[str, dict[str, Any]] = {}
        for ev in start_meta.get("events") or []:
            cid = ev.get("cve_id")
            if cid:
                sev_by_cve[cid] = ev
        # Index latest HITL decisions so the UI can show human overrides
        # alongside the model verdict.
        decisions_by_cve: dict[str, dict[str, Any]] = {}
        dec_dir = _runs_dir(cfg) / "decisions" / run_id
        if dec_dir.is_dir():
            for p in dec_dir.glob("*.json"):
                try:
                    rec = json.loads(p.read_text(encoding="utf-8"))
                    latest = rec.get("latest") or {}
                    if isinstance(latest, dict):
                        decisions_by_cve[p.stem] = latest
                except (OSError, json.JSONDecodeError):
                    continue
        results: list[dict[str, Any]] = []
        if artifact:
            ar = (artifact.get("analysis_result") or artifact).get("results") or []
            for r in ar:
                # Older artifacts stored component as a plain string. Be
                # tolerant so legacy runs don't crash the dashboard.
                comp_raw = r.get("component") or {}
                if isinstance(comp_raw, str):
                    comp = {"name": comp_raw, "current_version": None}
                elif isinstance(comp_raw, dict):
                    comp = comp_raw
                else:
                    comp = {}
                routing = r.get("routing") or {}
                if not isinstance(routing, dict):
                    routing = {}
                fix = r.get("fix") or {}
                if not isinstance(fix, dict):
                    fix = {}
                conf = r.get("confidence") or {}
                if not isinstance(conf, dict):
                    conf = {}
                cid = r.get("cve_id")
                sev = sev_by_cve.get(cid or "", {})
                dec = decisions_by_cve.get(cid or "", {})
                model_verdict = routing.get("final_verdict")
                effective_verdict = (
                    dec.get("new_verdict")
                    if dec.get("action") == "reassign" and dec.get("new_verdict")
                    else model_verdict
                )
                results.append({
                    "cve_id": cid,
                    "component": comp.get("name"),
                    "version": comp.get("current_version"),
                    "severity": sev.get("severity"),
                    "cvss": sev.get("cvss"),
                    "verdict": effective_verdict,
                    "model_verdict": model_verdict,
                    "human_action": dec.get("action"),
                    "human_verdict": dec.get("new_verdict"),
                    "human_actor": dec.get("actor"),
                    "human_note": dec.get("note"),
                    "decision": routing.get("decision"),
                    "auto_proceed": routing.get("auto_proceed"),
                    "has_patch": bool(fix.get("patch_unified_diff")),
                    "files_touched": list(fix.get("files_touched") or []),
                    "lines_added": fix.get("lines_added"),
                    "lines_removed": fix.get("lines_removed"),
                    "triage_confidence": conf.get("triage_confidence"),
                    "evidence_confidence": conf.get("evidence_confidence"),
                    "rationale": routing.get("reason"),
                })
        # For runs that have no artifact yet (still running), surface the
        # queued CVEs from the start sidecar so the UI can render the
        # rows immediately and fill in verdicts as events arrive.
        if not results and sev_by_cve:
            for cid, sev in sev_by_cve.items():
                dec = decisions_by_cve.get(cid, {})
                effective_verdict = (
                    dec.get("new_verdict")
                    if dec.get("action") == "reassign" and dec.get("new_verdict")
                    else None
                )
                results.append({
                    "cve_id": cid,
                    "component": sev.get("component"),
                    "version": sev.get("version"),
                    "severity": sev.get("severity"),
                    "cvss": sev.get("cvss"),
                    "verdict": effective_verdict,
                    "model_verdict": None,
                    "human_action": dec.get("action"),
                    "human_verdict": dec.get("new_verdict"),
                    "human_actor": dec.get("actor"),
                    "human_note": dec.get("note"),
                    "decision": None,
                    "auto_proceed": None,
                    "has_patch": False,
                    "files_touched": [],
                    "lines_added": None,
                    "lines_removed": None,
                    "triage_confidence": None,
                    "evidence_confidence": None,
                    "rationale": None,
                })
        return JSONResponse({"run_id": run_id, "cves": results})

    @app.get("/runs/{run_id}/cves/{cve_id}")
    def get_run_cve(run_id: str, cve_id: str) -> JSONResponse:
        _validate_run_id(run_id)
        _validate_cve_id(cve_id)

        # Always start with whatever we know from the start sidecar so
        # the UI can render basic info even while the run is in flight
        # (previously this endpoint returned 404 until the artifact was
        # finalised, which prevented users from opening CVE details mid-run).
        start_meta = _read_start_meta(cfg, run_id) or {}
        sev_entry: dict[str, Any] = {}
        for ev in start_meta.get("events") or []:
            if ev.get("cve_id") == cve_id:
                sev_entry = ev
                break

        # Try to discover analysis_id from registry first (set when the
        # run completes) then from the event stream (set on run.started).
        analysis_id: str | None = None
        st = runs.status(run_id) or {}
        if isinstance(st.get("analysis_id"), str):
            analysis_id = st["analysis_id"]
        if not analysis_id:
            for ev in _load_run_events(cfg, run_id):
                d = ev.get("data") or {}
                if isinstance(d.get("analysis_id"), str):
                    analysis_id = d["analysis_id"]
                    break

        # Try the run-level artifact for the finalised CVEAnalysis.
        artifact = _load_run_artifact(cfg, run_id)
        match: dict[str, Any] | None = None
        if artifact:
            ar = (artifact.get("analysis_result") or artifact).get("results") or []
            match = next((r for r in ar if r.get("cve_id") == cve_id), None)

        # Per-CVE evidence_bundle.json is written incrementally by the
        # orchestrator during the run, so it may exist even when the
        # run-level summary doesn't yet.
        bundle: dict[str, Any] | None = None
        analysis_only: dict[str, Any] | None = None
        if analysis_id:
            cve_dir = _artifacts_dir(cfg) / analysis_id / cve_id
            bp = cve_dir / "evidence_bundle.json"
            if bp.exists():
                try:
                    bundle = json.loads(bp.read_text(encoding="utf-8"))
                except (OSError, json.JSONDecodeError):
                    bundle = None
            # Fall back to the per-analysis result file when the run-level
            # artifact hasn't been written yet (e.g. cancelled runs).
            if match is None:
                rp = _artifacts_dir(cfg) / analysis_id / "analysis_result.json"
                if rp.exists():
                    try:
                        full = json.loads(rp.read_text(encoding="utf-8"))
                        ar = (full.get("analysis_result") or full).get("results") or []
                        match = next(
                            (r for r in ar if r.get("cve_id") == cve_id), None
                        )
                        analysis_only = full
                    except (OSError, json.JSONDecodeError):
                        pass

        # Synthesise an `event` object from the bundle (preferred) or the
        # start sidecar so the UI can show severity / description / CVSS.
        event_payload: dict[str, Any] = {}
        if bundle and isinstance(bundle.get("cve_event"), dict):
            event_payload = dict(bundle["cve_event"])
        if sev_entry:
            # Sidecar fields fill in anything missing.
            event_payload.setdefault("cve_id", cve_id)
            sev = event_payload.get("severity")
            if not sev and sev_entry.get("severity"):
                event_payload["severity"] = {
                    "label": sev_entry.get("severity"),
                    "cvss": sev_entry.get("cvss"),
                }
            comp = event_payload.get("component")
            if not comp and sev_entry.get("component"):
                event_payload["component"] = {
                    "name": sev_entry.get("component"),
                    "current_version": sev_entry.get("version"),
                }

        # When nothing is known at all (unknown run_id), preserve the
        # original 404 contract.
        if not start_meta and not artifact and not bundle and not match:
            raise HTTPException(status_code=404, detail="run not found")

        envelope: dict[str, Any] = {
            "run_id": run_id,
            "cve_id": cve_id,
            "state": (
                "completed" if match else ("running" if start_meta else "unknown")
            ),
            "analysis_id": analysis_id,
            "event": event_payload or None,
            "evidence_bundle": bundle,
        }
        if match:
            envelope.update(match)  # routing, fix, triage, verifier, etc.
        elif analysis_only:
            envelope["analysis_partial"] = True
        # Attach the latest HITL decision (if any) and expose an
        # `effective_verdict` so the UI can render the human override
        # without re-fetching the decisions endpoint.
        dec_path = _runs_dir(cfg) / "decisions" / run_id / f"{cve_id}.json"
        if dec_path.exists():
            try:
                dec_rec = json.loads(dec_path.read_text(encoding="utf-8"))
                latest = (dec_rec.get("latest") or {}) if isinstance(dec_rec, dict) else {}
                if latest:
                    envelope["decision"] = {
                        "latest": latest,
                        "history": dec_rec.get("history") or [],
                        "reanalysis": dec_rec.get("reanalysis"),
                    }
                    model_verdict = (
                        (envelope.get("routing") or {}).get("final_verdict")
                        if isinstance(envelope.get("routing"), dict)
                        else None
                    )
                    envelope["model_verdict"] = model_verdict
                    if latest.get("action") == "reassign" and latest.get("new_verdict"):
                        envelope["effective_verdict"] = latest["new_verdict"]
                        envelope["verdict"] = latest["new_verdict"]
                    else:
                        envelope["effective_verdict"] = model_verdict
                    # If a HITL-triggered re-analysis has landed, surface
                    # its evidence/fix in place of (or alongside) the
                    # original so the UI shows the post-reassign result.
                    rean = dec_rec.get("reanalysis") if isinstance(dec_rec, dict) else None
                    if isinstance(rean, dict) and rean.get("analysis_id"):
                        rean_dir = _artifacts_dir(cfg) / rean["analysis_id"] / cve_id
                        for fname, key in (
                            ("evidence_bundle.json", "reanalysis_evidence"),
                            ("fix_proposal.json", "reanalysis_fix"),
                            ("routing_decision.json", "reanalysis_routing"),
                        ):
                            fp = rean_dir / fname
                            if fp.exists():
                                try:
                                    envelope[key] = json.loads(fp.read_text(encoding="utf-8"))
                                except (OSError, json.JSONDecodeError):
                                    pass
            except (OSError, json.JSONDecodeError):
                pass
        return JSONResponse(envelope)

    # ------------------------------------------------------------------
    # Apply / preview an authored patch against the indexed repo.
    # ------------------------------------------------------------------

    def _load_fix_proposal(run_id: str, cve_id: str) -> tuple[dict[str, Any], str]:
        """Return (fix_proposal_dict, repo_root) or raise HTTPException."""
        sm = _read_start_meta(cfg, run_id) or {}
        repo_root = sm.get("repo_root")
        if not repo_root:
            raise HTTPException(
                status_code=400,
                detail="run has no repo_root recorded; cannot apply patch",
            )
        # Resolve analysis_id from registry then event stream.
        analysis_id: str | None = None
        st = runs.status(run_id) or {}
        if isinstance(st.get("analysis_id"), str):
            analysis_id = st["analysis_id"]
        if not analysis_id:
            for ev in _load_run_events(cfg, run_id):
                d = ev.get("data") or {}
                if isinstance(d.get("analysis_id"), str):
                    analysis_id = d["analysis_id"]
                    break
        if not analysis_id:
            raise HTTPException(status_code=404, detail="analysis not found")
        fp_path = (
            _artifacts_dir(cfg) / analysis_id / cve_id / "fix_proposal.json"
        )
        if not fp_path.exists():
            raise HTTPException(
                status_code=404, detail="no fix_proposal.json for this CVE"
            )
        try:
            fp = json.loads(fp_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise HTTPException(
                status_code=500, detail=f"unreadable fix_proposal.json: {exc}"
            ) from exc
        return fp, str(repo_root)

    @app.get("/runs/{run_id}/cves/{cve_id}/patch")
    def get_run_cve_patch(run_id: str, cve_id: str) -> JSONResponse:
        """Return the raw fix_proposal.json so the UI can render the diff."""
        _validate_run_id(run_id)
        _validate_cve_id(cve_id)
        fp, repo_root = _load_fix_proposal(run_id, cve_id)
        return JSONResponse({"repo_root": repo_root, "fix": fp})

    @app.post("/runs/{run_id}/cves/{cve_id}/apply_patch")
    def apply_run_cve_patch(
        run_id: str, cve_id: str, payload: dict[str, Any] | None = None
    ) -> JSONResponse:
        """Apply the authored patch via `git apply` against the recorded repo_root.

        Body (optional):
          - check_only: bool — run `git apply --check` and do not modify files.
        Returns a structured result so the UI can display stdout/stderr.
        """
        _validate_run_id(run_id)
        _validate_cve_id(cve_id)
        check_only = bool((payload or {}).get("check_only"))
        fp, repo_root = _load_fix_proposal(run_id, cve_id)
        diff = str(fp.get("patch_unified_diff") or "")
        if not diff.strip():
            raise HTTPException(status_code=400, detail="patch is empty")
        repo_path = Path(repo_root)
        if not repo_path.exists() or not repo_path.is_dir():
            raise HTTPException(
                status_code=400, detail=f"repo_root does not exist: {repo_root}"
            )
        # Require a git working tree so `git apply` semantics are well defined
        # and operators can `git diff`/`git restore` to undo.
        if not (repo_path / ".git").exists():
            raise HTTPException(
                status_code=400,
                detail=(
                    f"repo_root is not a git working tree: {repo_root}. "
                    "Initialise the repo or apply manually."
                ),
            )
        cmd = ["git", "apply", "--whitespace=nowarn"]
        if check_only:
            cmd.append("--check")
        try:
            proc = subprocess.run(  # noqa: S603 - explicit list, no shell
                cmd,
                input=diff,
                cwd=str(repo_path),
                capture_output=True,
                text=True,
                timeout=60,
                check=False,
            )
        except subprocess.TimeoutExpired:
            raise HTTPException(status_code=504, detail="git apply timed out")
        ok = proc.returncode == 0
        log_event(
            logger,
            "patch.apply" if not check_only else "patch.check",
            run_id=run_id,
            cve_id=cve_id,
            repo_root=str(repo_path),
            ok=ok,
            files=fp.get("files_touched") or [],
        )
        return JSONResponse(
            {
                "ok": ok,
                "check_only": check_only,
                "repo_root": str(repo_path),
                "files_touched": fp.get("files_touched") or [],
                "stdout": proc.stdout,
                "stderr": proc.stderr,
                "returncode": proc.returncode,
            },
            status_code=200 if ok else 409,
        )

    # ------------------------------------------------------------------
    # WebSocket: live event stream
    # ------------------------------------------------------------------

    @app.websocket("/runs/{run_id}/stream")
    async def ws_stream(ws: WebSocket, run_id: str) -> None:
        if not _RUN_ID_RE.match(run_id):
            await ws.close(code=4400)
            return
        await ws.accept()
        loop = asyncio.get_running_loop()
        queue, unsubscribe = bus.subscribe_async(run_id, loop=loop)
        try:
            # Replay history so reconnects see the full timeline.
            for ev in bus.replay(run_id):
                await ws.send_json(ev.to_dict())
            while True:
                ev = await queue.get()
                await ws.send_json(ev.to_dict())
                if ev.event in (Events.RUN_COMPLETED, Events.RUN_FAILED):
                    await asyncio.sleep(0.1)
                    break
        except WebSocketDisconnect:
            pass
        except Exception as exc:  # noqa: BLE001
            log_event(logger, "ws.error", run_id=run_id, error=str(exc))
        finally:
            unsubscribe()
            try:
                await ws.close()
            except Exception:  # noqa: BLE001
                pass

    # ------------------------------------------------------------------
    # Models — dropdown source for the UI
    # ------------------------------------------------------------------

    _models_cache: dict[str, Any] = {"at": 0.0, "data": None}

    @app.get("/models")
    def list_models() -> JSONResponse:
        """List models available on the configured LiteLLM proxy.

        Strategy:
          1. Try ``GET {proxy_base_url}/v1/models`` (10s cache).
          2. Fall back to ``cfg["models"]["available"]`` when set.
          3. Always include the currently-configured author + verifier so
             the dropdown is never empty.
        """
        now = time.time()
        if _models_cache["data"] is not None and (now - _models_cache["at"]) < 30:
            return JSONResponse(_models_cache["data"])

        models_cfg = cfg.get("models", {}) or {}
        base = (models_cfg.get("proxy_base_url") or "").rstrip("/")
        api_key = models_cfg.get("proxy_api_key") or ""
        proxy_models: list[str] = []
        proxy_error: str | None = None

        if base:
            url = base + "/v1/models"
            # Build an SSL context that works on corporate Macs. Priority:
            #   1. Honor ``cfg.models.proxy_ca_bundle`` (path to CA file).
            #   2. Use ``certifi.where()`` if certifi is installed (very
            #      common; bypasses the broken system trust store).
            #   3. Honor ``cfg.models.proxy_verify_ssl: false`` to fall
            #      back to an unverified context (logged as a warning).
            #   4. Otherwise use the default context.
            ssl_ctx = None
            verify = models_cfg.get("proxy_verify_ssl", True)
            ca_bundle = models_cfg.get("proxy_ca_bundle")
            try:
                import ssl as _ssl  # noqa: WPS433
                if ca_bundle and Path(ca_bundle).exists():
                    ssl_ctx = _ssl.create_default_context(cafile=str(ca_bundle))
                elif verify:
                    try:
                        import certifi  # noqa: WPS433
                        ssl_ctx = _ssl.create_default_context(cafile=certifi.where())
                    except ImportError:
                        ssl_ctx = _ssl.create_default_context()
                else:
                    ssl_ctx = _ssl._create_unverified_context()  # noqa: SLF001
                    log_event(logger, "models.proxy_ssl_disabled")
            except Exception as exc:  # noqa: BLE001
                log_event(logger, "models.ssl_setup_failed", error=str(exc))
                ssl_ctx = None
            try:
                req = urllib.request.Request(url)
                if api_key:
                    req.add_header("Authorization", f"Bearer {api_key}")
                opener_args: dict[str, Any] = {"timeout": 8}
                if ssl_ctx is not None:
                    opener_args["context"] = ssl_ctx
                with urllib.request.urlopen(req, **opener_args) as resp:
                    raw = json.loads(resp.read().decode("utf-8"))
                items = raw.get("data") or raw.get("models") or []
                for it in items:
                    if isinstance(it, dict):
                        mid = it.get("id") or it.get("model")
                    else:
                        mid = it
                    if isinstance(mid, str):
                        proxy_models.append(mid)
            except (urllib.error.URLError, urllib.error.HTTPError,
                    TimeoutError, json.JSONDecodeError, OSError) as exc:
                proxy_error = str(exc)
                log_event(logger, "models.proxy_unreachable", error=str(exc))

        fallback = models_cfg.get("available") or []
        # Always surface the active defaults
        seed = [models_cfg.get("author"), models_cfg.get("verifier")]
        all_models = []
        seen: set[str] = set()
        for m in proxy_models + list(fallback) + seed:
            if not m or not isinstance(m, str) or m in seen:
                continue
            seen.add(m)
            all_models.append(m)

        out = {
            "author_default": models_cfg.get("author"),
            "verifier_default": models_cfg.get("verifier"),
            "models": all_models,
            "source": "proxy" if proxy_models else ("config" if fallback else "default"),
            "proxy_error": proxy_error,
        }
        _models_cache["at"] = now
        _models_cache["data"] = out
        return JSONResponse(out)

    # ------------------------------------------------------------------
    # XLSX report download
    # ------------------------------------------------------------------

    @app.get("/runs/{run_id}/report.xlsx")
    def download_report(run_id: str) -> Response:
        _validate_run_id(run_id)
        full_path = _runs_dir(cfg) / f"{run_id}.full.json"
        if not full_path.exists():
            raise HTTPException(
                status_code=404,
                detail="full report not found (run must have completed via run_pipeline)",
            )
        try:
            import sys as _sys
            root = str(Path(__file__).resolve().parents[2])
            if root not in _sys.path:
                _sys.path.insert(0, root)
            from scripts.export_report_xlsx import build_workbook  # noqa: WPS433
        except Exception as exc:  # noqa: BLE001
            raise HTTPException(
                status_code=500, detail=f"export module unavailable: {exc}"
            ) from exc
        try:
            report = json.loads(full_path.read_text(encoding="utf-8"))
            wb = build_workbook(report)
            buf = BytesIO()
            wb.save(buf)
            buf.seek(0)
        except (OSError, json.JSONDecodeError, ValueError) as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc
        return Response(
            content=buf.read(),
            media_type=(
                "application/vnd.openxmlformats-officedocument."
                "spreadsheetml.sheet"
            ),
            headers={
                "Content-Disposition": f'attachment; filename="{run_id}.xlsx"',
            },
        )

    # ------------------------------------------------------------------
    # Index management — build/update against local path OR git URL+branch
    # ------------------------------------------------------------------

    _index_state: dict[str, Any] = {
        "running": False,
        "last": None,
        "lock": threading.Lock(),
    }

    @app.get("/index/status")
    def index_status() -> JSONResponse:
        index_dir = _legacy_index_dir(cfg)
        meta_path = index_dir / "meta.json"
        meta: dict[str, Any] | None = None
        if meta_path.exists():
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                meta = None
        return JSONResponse({
            "index_dir": str(index_dir),
            "present": meta is not None,
            "files_indexed": (meta or {}).get("files_indexed"),
            "chunks": (meta or {}).get("chunks"),
            "repo_root": (meta or {}).get("repo_root"),
            "running": _index_state["running"],
            "last": _index_state["last"],
            "indexes": _list_indexes(cfg),
        })

    @app.get("/indexes")
    def list_indexes_route() -> JSONResponse:
        return JSONResponse({"indexes": _list_indexes(cfg)})

    @app.post("/index/build")
    def index_build(payload: dict[str, Any]) -> JSONResponse:
        """Build / update the code RAG index.

        Body schema::

            {
              "repo_root": "/abs/path",     # OR
              "git_url": "https://...",
              "branch": "main",             # optional, default HEAD
              "mode": "incremental",        # or "full"
              "index_id": "...",            # optional — update existing
              "project": "myrepo",          # optional friendly name
              "name": "myrepo · main"       # optional display label
            }

        When ``index_id`` is supplied, the named index is updated in
        place. Otherwise a fresh per-project index is created under
        ``.data/indexes/<id>/``. The legacy shared ``.data/index/`` is
        still used when neither ``index_id`` nor any project info is
        provided (backwards-compat).
        """
        with _index_state["lock"]:
            if _index_state["running"]:
                raise HTTPException(status_code=409, detail="index build already running")
            _index_state["running"] = True
            _index_state["last"] = {"state": "running", "started_at": time.time()}

        repo_root = payload.get("repo_root")
        git_url = payload.get("git_url")
        branch = payload.get("branch") or None
        mode = (payload.get("mode") or "incremental").lower()
        if mode not in ("incremental", "full"):
            mode = "incremental"
        explicit_index_id = payload.get("index_id") or None
        project_name = payload.get("project") or None
        display_name = payload.get("name") or None

        if not repo_root and not git_url and not explicit_index_id:
            with _index_state["lock"]:
                _index_state["running"] = False
            raise HTTPException(
                status_code=400, detail="provide repo_root OR git_url"
            )

        # Validate git_url format minimally (no shell metacharacters)
        if git_url and not re.match(r"^(https?://|git@)[^\s'\"`$;|&<>]+$", git_url):
            with _index_state["lock"]:
                _index_state["running"] = False
            raise HTTPException(status_code=400, detail="invalid git_url")

        # Resolve the destination index directory.
        legacy_mode = False
        index_id: str | None = None
        if explicit_index_id:
            if explicit_index_id == "__legacy__":
                index_dir = _legacy_index_dir(cfg)
                legacy_mode = True
            else:
                if not _INDEX_ID_RE.match(explicit_index_id):
                    with _index_state["lock"]:
                        _index_state["running"] = False
                    raise HTTPException(status_code=400, detail="invalid index_id")
                index_dir = _index_dir_for(cfg, explicit_index_id)
                index_id = explicit_index_id
        elif project_name or display_name or repo_root or git_url:
            proj = project_name or _derive_project_name(
                vulns_path=None, repo_root=repo_root, git_url=git_url
            )
            index_id = _make_index_id(proj, branch)
            index_dir = _index_dir_for(cfg, index_id)
        else:
            index_dir = _legacy_index_dir(cfg)
            legacy_mode = True
        checkouts_dir = Path(cfg.get("storage", {}).get("data_dir", ".data")) / "checkouts"
        coderag_cfg = cfg.get("coderag", {}) or {}

        def _worker() -> None:
            # ``branch`` is read AND reassigned below (when updating an
            # existing index we fall back to the recorded branch), so it
            # must be declared nonlocal to avoid Python treating it as a
            # fresh local and raising UnboundLocalError on first read.
            nonlocal branch
            from apps.coderag.indexer import IndexerConfig, build_index  # noqa: WPS433
            from apps.coderag.incremental_indexer import update_index  # noqa: WPS433

            t0 = time.monotonic()
            target_repo: str | None = repo_root
            log_lines: list[str] = []
            try:
                if git_url:
                    checkouts_dir.mkdir(parents=True, exist_ok=True)
                    checkout_id = uuid.uuid4().hex[:8]
                    target = checkouts_dir / checkout_id
                    cmd = ["git", "clone", "--depth", "1"]
                    if branch:
                        cmd += ["--branch", branch]
                    cmd += ["--", git_url, str(target)]
                    log_lines.append("$ " + " ".join(cmd))
                    proc = subprocess.run(
                        cmd, capture_output=True, text=True, timeout=600
                    )
                    log_lines.append(proc.stdout.strip())
                    log_lines.append(proc.stderr.strip())
                    if proc.returncode != 0:
                        raise RuntimeError(f"git clone failed: {proc.stderr[-400:]}")
                    target_repo = str(target)

                # When updating an existing index without supplying a
                # repo path, fall back to the meta.json's recorded path.
                if not target_repo and explicit_index_id:
                    prev_meta = _read_index_meta(index_dir) or {}
                    target_repo = prev_meta.get("repo_root")
                    if not branch:
                        branch = prev_meta.get("branch")

                if not target_repo or not Path(target_repo).exists():
                    raise RuntimeError("repo path not found after checkout")

                icfg = IndexerConfig(
                    chunk_lines=int(coderag_cfg.get("chunk_lines", 80)),
                    chunk_overlap=int(coderag_cfg.get("chunk_overlap", 10)),
                )
                if mode == "full":
                    meta = build_index(target_repo, str(index_dir), icfg)
                    summary = {
                        "mode": "full",
                        "files_indexed": meta.get("files_indexed"),
                        "chunks": meta.get("chunks"),
                    }
                else:
                    upd = update_index(
                        repo_root=Path(target_repo),
                        out_dir=str(index_dir),
                        cfg=icfg,
                        workers=int(coderag_cfg.get("index_workers", 4)),
                    )
                    summary = {
                        "mode": "incremental",
                        "added": len(upd.added),
                        "modified": len(upd.modified),
                        "deleted": len(upd.deleted),
                        "unchanged": upd.unchanged,
                        "chunks_total": upd.chunks_total,
                        "full_rebuild": upd.full_rebuild,
                    }

                # Enrich meta.json with our project-level fields so the
                # UI dropdown has rich labels.
                if not legacy_mode:
                    proj = project_name or _derive_project_name(
                        vulns_path=None, repo_root=target_repo, git_url=git_url
                    )
                    label = display_name or f"{proj}{' · ' + branch if branch else ''}"
                    now_ts = time.time()
                    prev = _read_index_meta(index_dir) or {}
                    _write_index_meta(index_dir, {
                        "index_id": index_id or index_dir.name,
                        "name": label,
                        "project": proj,
                        "branch": branch or prev.get("branch"),
                        "repo_root": target_repo,
                        "git_url": git_url or prev.get("git_url"),
                        "source": "git" if git_url else "local",
                        "created_at": prev.get("created_at") or now_ts,
                        "updated_at": now_ts,
                    })
                with _index_state["lock"]:
                    _index_state["last"] = {
                        "state": "ok",
                        "started_at": _index_state["last"]["started_at"],
                        "ended_at": time.time(),
                        "duration_ms": int((time.monotonic() - t0) * 1000),
                        "repo_root": target_repo,
                        "git_url": git_url,
                        "index_id": index_id,
                        "index_dir": str(index_dir),
                        "branch": branch,
                        "summary": summary,
                        "log_tail": "\n".join(log_lines)[-2000:],
                    }
            except Exception as exc:  # noqa: BLE001
                logger.exception("index build failed")
                with _index_state["lock"]:
                    _index_state["last"] = {
                        "state": "failed",
                        "started_at": _index_state["last"]["started_at"],
                        "ended_at": time.time(),
                        "error": str(exc),
                        "log_tail": "\n".join(log_lines)[-2000:],
                    }
            finally:
                with _index_state["lock"]:
                    _index_state["running"] = False

        threading.Thread(target=_worker, name="index-build", daemon=True).start()
        return JSONResponse({"state": "running"}, status_code=202)

    # ------------------------------------------------------------------
    # Jenkins trigger + upload handoff
    # ------------------------------------------------------------------

    @app.post("/jenkins/upload-sbom")
    async def jenkins_upload_sbom(sbom_file: UploadFile = File(...)) -> JSONResponse:
        """Accept an SBOM upload and persist it under .data/runs/jenkins/uploads.

        The returned ticket can then be passed to /jenkins/trigger.
        """
        name = Path(sbom_file.filename or "sbom.yaml").name
        if not name:
            raise HTTPException(status_code=400, detail="empty filename")
        suffix = Path(name).suffix.lower()
        if suffix not in {".yaml", ".yml", ".json", ".xml"}:
            raise HTTPException(status_code=400, detail="unsupported SBOM file extension")

        content = await sbom_file.read()
        if not content:
            raise HTTPException(status_code=400, detail="empty file")

        ticket = uuid.uuid4().hex[:12]
        token = uuid.uuid4().hex
        up_dir = _jenkins_upload_dir(cfg, ticket)
        up_dir.mkdir(parents=True, exist_ok=True)
        sbom_path = up_dir / name
        sbom_path.write_bytes(content)

        meta = {
            "ticket": ticket,
            "token": token,
            "filename": name,
            "content_type": sbom_file.content_type,
            "stored_path": str(sbom_path),
            "size_bytes": len(content),
            "created_at": time.time(),
            "state": "uploaded",
        }
        _jenkins_upload_meta_path(cfg, ticket).write_text(
            json.dumps(meta, indent=2), encoding="utf-8"
        )
        log_event(logger, "jenkins.upload_sbom", ticket=ticket, size=len(content))
        return JSONResponse(
            {
                "ticket": ticket,
                "filename": name,
                "size_bytes": len(content),
                "state": "uploaded",
            },
            status_code=201,
        )

    @app.get("/jenkins/uploads/{ticket}/sbom")
    def jenkins_get_uploaded_sbom(
        ticket: str, token: str = Query(default="")
    ) -> FileResponse:
        """Serves the uploaded SBOM to Jenkins using a ticket-scoped token."""
        _validate_jenkins_ticket(ticket)
        meta_path = _jenkins_upload_meta_path(cfg, ticket)
        if not meta_path.exists():
            raise HTTPException(status_code=404, detail="ticket not found")
        try:
            meta = json.loads(meta_path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=500, detail=f"invalid upload meta: {exc}") from exc
        if not token or token != meta.get("token"):
            raise HTTPException(status_code=403, detail="invalid token")
        sbom_path = Path(meta.get("stored_path") or "")
        if not sbom_path.exists():
            raise HTTPException(status_code=404, detail="uploaded SBOM missing")
        return FileResponse(path=sbom_path, filename=meta.get("filename") or "sbom.yaml")

    @app.post("/jenkins/trigger")
    def jenkins_trigger(payload: dict[str, Any], request: Request) -> JSONResponse:
        """Trigger a Jenkins job for end-to-end SBOM -> CVE analysis.

        Supported input modes:
          * payload["ticket"]: previously uploaded file from /jenkins/upload-sbom
          * payload["sbom_path"]: server-local path (advanced/manual)
        """
        jcfg = (cfg.get("jenkins") or {})
        jbase = (payload.get("jenkins_url") or jcfg.get("base_url") or "").strip()
        jjob = (payload.get("job_name") or jcfg.get("job_name") or "").strip()
        if not jbase or not jjob:
            raise HTTPException(
                status_code=400,
                detail="Jenkins not configured; set jenkins.base_url and jenkins.job_name",
            )

        ticket = (payload.get("ticket") or "").strip()
        sbom_source = "uploaded"
        sbom_upload_url = ""
        sbom_upload_token = ""
        sbom_filename = "sbom.yaml"
        sbom_path = ""

        if ticket:
            _validate_jenkins_ticket(ticket)
            meta_path = _jenkins_upload_meta_path(cfg, ticket)
            if not meta_path.exists():
                raise HTTPException(status_code=404, detail="ticket not found")
            try:
                meta = json.loads(meta_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError) as exc:
                raise HTTPException(status_code=500, detail=f"invalid upload meta: {exc}") from exc
            public_api_base = (
                (payload.get("public_api_base") or "").strip()
                or (jcfg.get("public_api_base") or "").strip()
                or _request_base_url(request)
            )
            sbom_upload_token = str(meta.get("token") or "")
            sbom_filename = str(meta.get("filename") or "sbom.yaml")
            if not sbom_upload_token:
                raise HTTPException(status_code=500, detail="upload token missing")
            sbom_upload_url = (
                f"{public_api_base.rstrip('/')}/jenkins/uploads/{ticket}/sbom"
                f"?token={urllib.parse.quote(sbom_upload_token, safe='')}"
            )
        else:
            sbom_path = (payload.get("sbom_path") or "").strip()
            if not sbom_path:
                raise HTTPException(status_code=400, detail="ticket or sbom_path is required")
            if not Path(sbom_path).exists():
                raise HTTPException(status_code=400, detail="sbom_path not found")
            sbom_source = "workspace"

        severities_raw = payload.get("severities")
        if isinstance(severities_raw, list):
            severities = ",".join(str(s).strip().upper() for s in severities_raw if str(s).strip())
        else:
            severities = str(severities_raw or "CRITICAL,HIGH")

        params = {
            "SBOM_SOURCE": sbom_source,
            "SBOM_UPLOAD_URL": sbom_upload_url,
            "SBOM_UPLOAD_TOKEN": sbom_upload_token,
            "SBOM_FILENAME": sbom_filename,
            "SBOM_PATH": sbom_path,
            "DTRACK_URL": str(
                payload.get("dtrack_url")
                or jcfg.get("dtrack_url")
                or cfg.get("dtrack", {}).get("base_url")
                or ""
            ),
            "SECOND_SERVICE_API_URL": str(
                payload.get("analysis_api_url")
                or jcfg.get("second_service_api_url")
                or ""
            ),
            "ANALYSIS_REPO_ROOT": str(
                payload.get("repo_root")
                or jcfg.get("analysis_repo_root")
                or cfg.get("coderag", {}).get("default_repo_root")
                or ""
            ),
            "WORKFLOW_MODE": str(payload.get("mode") or jcfg.get("mode") or "standard"),
            "SEVERITIES": severities,
            "LIMIT": str(payload.get("limit") or ""),
            "WAIT_MINUTES": str(payload.get("wait_minutes") or jcfg.get("wait_minutes") or 30),
            "OUTPUT_SUBDIR": str(payload.get("output_subdir") or ticket or uuid.uuid4().hex[:8]),
        }

        trigger_token = (
            (payload.get("jenkins_trigger_token") or "").strip()
            or (jcfg.get("trigger_token") or "").strip()
        )
        if trigger_token:
            params["token"] = trigger_token

        def _auth_header() -> dict[str, str]:
            user = (payload.get("jenkins_user") or jcfg.get("user") or "").strip()
            tok = (payload.get("jenkins_api_token") or jcfg.get("api_token") or "").strip()
            if not user or not tok:
                return {}
            basic = base64.b64encode(f"{user}:{tok}".encode("utf-8")).decode("ascii")
            return {"Authorization": f"Basic {basic}"}

        headers = {
            "Content-Type": "application/x-www-form-urlencoded",
            "Accept": "application/json,text/plain,*/*",
        }
        headers.update(_auth_header())

        # Best-effort crumb support for Jenkins setups that require CSRF crumbs.
        try:
            crumb_req = urllib.request.Request(
                f"{jbase.rstrip('/')}/crumbIssuer/api/json",
                headers=headers,
                method="GET",
            )
            with urllib.request.urlopen(crumb_req, timeout=15) as resp:
                body = json.loads(resp.read().decode("utf-8"))
                crumb_field = body.get("crumbRequestField")
                crumb = body.get("crumb")
                if crumb_field and crumb:
                    headers[str(crumb_field)] = str(crumb)
        except Exception:  # noqa: BLE001
            pass

        build_url = f"{_jenkins_job_url(jbase, jjob)}/buildWithParameters"
        encoded = urllib.parse.urlencode({k: v for k, v in params.items() if v is not None}).encode("utf-8")
        record: dict[str, Any] = {
            "ticket": ticket or uuid.uuid4().hex[:10],
            "received_at": time.time(),
            "state": "queued",
            "jenkins_url": jbase,
            "job_name": jjob,
            "params": {k: (v if k not in {"SBOM_UPLOAD_TOKEN"} else "***") for k, v in params.items()},
            "sbom_source": sbom_source,
            "sbom_path": sbom_path,
            "sbom_upload_url": sbom_upload_url,
        }

        try:
            req = urllib.request.Request(build_url, data=encoded, headers=headers, method="POST")
            with urllib.request.urlopen(req, timeout=20) as resp:
                queue_url = resp.headers.get("Location")
                record["state"] = "queued"
                record["http_status"] = getattr(resp, "status", 201)
                if queue_url:
                    record["queue_url"] = queue_url
        except urllib.error.HTTPError as exc:
            detail = exc.read().decode("utf-8", errors="ignore")[:1200]
            record["state"] = "failed"
            record["http_status"] = exc.code
            record["error"] = detail or str(exc)
            _jenkins_dir(cfg).mkdir(parents=True, exist_ok=True)
            _jenkins_ticket_path(cfg, record["ticket"]).write_text(
                json.dumps(record, indent=2), encoding="utf-8"
            )
            log_event(logger, "jenkins.trigger_failed", ticket=record["ticket"], error=record.get("error"))
            raise HTTPException(status_code=502, detail=f"jenkins trigger failed: HTTP {exc.code}") from exc
        except Exception as exc:  # noqa: BLE001
            record["state"] = "failed"
            record["error"] = str(exc)
            _jenkins_dir(cfg).mkdir(parents=True, exist_ok=True)
            _jenkins_ticket_path(cfg, record["ticket"]).write_text(
                json.dumps(record, indent=2), encoding="utf-8"
            )
            log_event(logger, "jenkins.trigger_failed", ticket=record["ticket"], error=record.get("error"))
            raise HTTPException(status_code=502, detail=f"jenkins trigger failed: {exc}") from exc

        _jenkins_dir(cfg).mkdir(parents=True, exist_ok=True)
        _jenkins_ticket_path(cfg, record["ticket"]).write_text(
            json.dumps(record, indent=2), encoding="utf-8"
        )
        log_event(
            logger,
            "jenkins.triggered",
            ticket=record["ticket"],
            sbom_source=sbom_source,
            queue_url=record.get("queue_url"),
        )
        return JSONResponse(record, status_code=202)

    # ------------------------------------------------------------------
    # HITL decisions on individual CVEs
    # ------------------------------------------------------------------

    def _decisions_path(run_id: str, cve_id: str) -> Path:
        return _runs_dir(cfg) / "decisions" / run_id / f"{cve_id}.json"

    _ALLOWED_ACTIONS = {"approve", "reject", "reassign", "note"}
    _ALLOWED_REASSIGN = {"package_upgrade", "not_applicable",
                         "needs_human", "code_change"}

    @app.post("/runs/{run_id}/cves/{cve_id}/decision")
    def post_decision(
        run_id: str, cve_id: str, payload: dict[str, Any]
    ) -> JSONResponse:
        _validate_run_id(run_id)
        _validate_cve_id(cve_id)
        action = (payload.get("action") or "").strip().lower()
        if action not in _ALLOWED_ACTIONS:
            raise HTTPException(
                status_code=400,
                detail=f"action must be one of {sorted(_ALLOWED_ACTIONS)}",
            )
        new_verdict = payload.get("new_verdict")
        if action == "reassign":
            if new_verdict not in _ALLOWED_REASSIGN:
                raise HTTPException(
                    status_code=400,
                    detail=f"new_verdict must be one of {sorted(_ALLOWED_REASSIGN)}",
                )
        note = (payload.get("note") or "").strip()
        actor = (payload.get("actor") or "human").strip()[:64]
        # Read existing history (append-only ledger).
        path = _decisions_path(run_id, cve_id)
        path.parent.mkdir(parents=True, exist_ok=True)
        history: list[dict[str, Any]] = []
        if path.exists():
            try:
                history = json.loads(path.read_text(encoding="utf-8")).get("history", [])
            except (OSError, json.JSONDecodeError):
                history = []
        entry = {
            "ts": time.time(),
            "actor": actor,
            "action": action,
            "new_verdict": new_verdict if action == "reassign" else None,
            "note": note,
        }
        history.append(entry)
        record = {
            "run_id": run_id,
            "cve_id": cve_id,
            "latest": entry,
            "history": history,
        }
        path.write_text(json.dumps(record, indent=2), encoding="utf-8")
        log_event(logger, "hitl.decision",
                  run_id=run_id, cve_id=cve_id, action=action, actor=actor)

        # If the human reassigned this CVE to code_change, kick off a
        # focused single-CVE re-analysis so the UI can show fresh
        # code_evidence + fix_proposal (or confirm not-vulnerable) for
        # the override. Runs in a background thread so the request returns
        # immediately; result lands at .data/analyses/<aid>/<cve>/ and a
        # pointer is written back into the decision record.
        if action == "reassign" and new_verdict == "code_change":
            def _reanalyze() -> None:
                try:
                    import sys as _sys
                    root = str(Path(__file__).resolve().parents[2])
                    if root not in _sys.path:
                        _sys.path.insert(0, root)
                    from scripts.analyze_dt_findings import (  # noqa: WPS433
                        filter_findings, load_findings, to_event,
                    )
                    start = _read_start_meta(cfg, run_id) or {}
                    vulns_path = start.get("vulns_path")
                    repo_root = start.get("repo_root")
                    if not vulns_path or not Path(vulns_path).exists():
                        log_event(logger, "hitl.reanalyze.skip",
                                  run_id=run_id, cve_id=cve_id,
                                  reason="vulns_path missing")
                        return
                    findings, build_context = load_findings(Path(vulns_path).resolve())
                    if repo_root:
                        build_context["repo_root"] = str(repo_root)
                    # Filter to just this CVE.
                    matching = [
                        f for f in findings
                        if (f.get("vulnerability") or {}).get("vulnId") == cve_id
                    ]
                    if not matching:
                        log_event(logger, "hitl.reanalyze.skip",
                                  run_id=run_id, cve_id=cve_id,
                                  reason="cve not in source findings")
                        return
                    events = [to_event(f, build_context) for f in matching]
                    with orch_swap_lock:
                        req = AnalyzeRequest(mode="full", cves=events)
                        resp = orch.analyze(req)
                    # Persist a pointer back into the decision ledger.
                    try:
                        cur = json.loads(path.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError):
                        cur = record
                    cur["reanalysis"] = {
                        "analysis_id": resp.analysis_id,
                        "ts": time.time(),
                        "verdict": (
                            resp.results[0].routing.final_verdict.value
                            if resp.results else None
                        ),
                    }
                    path.write_text(json.dumps(cur, indent=2), encoding="utf-8")
                    log_event(logger, "hitl.reanalyze.done",
                              run_id=run_id, cve_id=cve_id,
                              analysis_id=resp.analysis_id,
                              verdict=cur["reanalysis"]["verdict"])
                except Exception as exc:  # noqa: BLE001
                    log_event(logger, "hitl.reanalyze.failed",
                              run_id=run_id, cve_id=cve_id, error=str(exc))

            threading.Thread(target=_reanalyze, daemon=True).start()
            record["reanalysis_pending"] = True

        return JSONResponse(record)

    @app.get("/runs/{run_id}/cves/{cve_id}/decision")
    def get_decision(run_id: str, cve_id: str) -> JSONResponse:
        _validate_run_id(run_id)
        _validate_cve_id(cve_id)
        path = _decisions_path(run_id, cve_id)
        if not path.exists():
            return JSONResponse({
                "run_id": run_id, "cve_id": cve_id,
                "latest": None, "history": [],
            })
        try:
            return JSONResponse(json.loads(path.read_text(encoding="utf-8")))
        except (OSError, json.JSONDecodeError) as exc:
            raise HTTPException(status_code=500, detail=str(exc)) from exc

    # ------------------------------------------------------------------
    # Static dashboard
    # ------------------------------------------------------------------

    ui_dir = Path(__file__).parent / "ui"
    index_html = ui_dir / "index.html"

    @app.get("/")
    def root() -> FileResponse:
        if not index_html.exists():
            raise HTTPException(status_code=404, detail="dashboard not bundled")
        return FileResponse(index_html, media_type="text/html")

    return app


app = None  # populated lazily by run_workflow_d.py
