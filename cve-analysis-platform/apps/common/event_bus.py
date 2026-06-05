"""Run event bus.

A small, dependency-free pub/sub primitive that lets the pipeline emit
structured progress events to multiple consumers:

  * a JSON-Lines file on disk (`.data/runs/<run_id>.events.jsonl`) for
    audit/replay,
  * an in-memory ring buffer (so late HTTP/WebSocket subscribers can
    catch up on what they missed without reading from disk),
  * any number of synchronous callbacks (e.g. a terminal progress
    reporter),
  * any number of asyncio queues (e.g. WebSocket clients), if asyncio is
    in use.

Design notes (kept intentionally minimal):

* Thread-safe via a single `threading.RLock`. Publishers can come from
  any worker thread; subscribers iterate from any thread or coroutine.
* No PII / no raw LLM text in events by convention — callers should
  only pass identifiers, counts, durations, verdict labels, etc. Add a
  short sanitiser when accepting external input.
* Best-effort. A misbehaving subscriber must not break the publisher;
  per-subscriber exceptions are caught and logged, never raised.
* The bus owns no threads. It is purely reactive on the publish call.

This module deliberately does NOT depend on FastAPI / starlette / any
web framework — it stays usable from CLI tooling.
"""
from __future__ import annotations

import asyncio
import json
import os
import threading
import time
from collections import deque
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Callable, Iterable

from .logging_utils import get_logger

logger = get_logger(__name__)

# Cap how many events we keep in memory per run. The full history is
# always available on disk; this cap exists so a long-running daemon
# does not grow unbounded.
_DEFAULT_RING_SIZE = 5_000


@dataclass
class RunEvent:
    """A structured event in the lifecycle of one pipeline run.

    `seq` is a monotonically increasing per-run sequence number so
    late subscribers can resume from a known cursor.
    """

    run_id: str
    seq: int
    ts: float
    event: str
    data: dict[str, Any] = field(default_factory=dict)

    def to_dict(self) -> dict[str, Any]:
        return {
            "run_id": self.run_id,
            "seq": self.seq,
            "ts": self.ts,
            "event": self.event,
            "data": self.data,
        }


Callback = Callable[[RunEvent], None]


class _RunState:
    """Per-run subscriber set, ring buffer, and persistent jsonl handle."""

    __slots__ = (
        "run_id",
        "lock",
        "seq",
        "ring",
        "callbacks",
        "async_queues",
        "jsonl_path",
        "_jsonl_fh",
    )

    def __init__(self, run_id: str, jsonl_path: Path | None, ring_size: int) -> None:
        self.run_id = run_id
        self.lock = threading.RLock()
        self.seq = 0
        self.ring: deque[RunEvent] = deque(maxlen=ring_size)
        self.callbacks: list[Callback] = []
        self.async_queues: list[tuple[asyncio.AbstractEventLoop, asyncio.Queue]] = []
        self.jsonl_path = jsonl_path
        self._jsonl_fh = None  # opened lazily

    def _open_jsonl(self) -> None:
        if self.jsonl_path is None or self._jsonl_fh is not None:
            return
        self.jsonl_path.parent.mkdir(parents=True, exist_ok=True)
        # Append mode + line buffering. We do not fsync per line; the
        # OS flushes on close. The pipeline calls `close()` on
        # `run.completed`/`run.failed` so the file is durable then.
        self._jsonl_fh = open(self.jsonl_path, "a", encoding="utf-8", buffering=1)

    def close(self) -> None:
        with self.lock:
            fh = self._jsonl_fh
            self._jsonl_fh = None
        if fh is not None:
            try:
                fh.flush()
                os.fsync(fh.fileno())
            except OSError:
                pass
            try:
                fh.close()
            except OSError:
                pass


class RunEventBus:
    """Process-wide pub/sub for pipeline run events.

    A single instance is typically shared across the orchestrator,
    CLI driver, and any API server in the same process.
    """

    def __init__(
        self,
        *,
        events_dir: str | Path | None = None,
        ring_size: int = _DEFAULT_RING_SIZE,
    ) -> None:
        self._lock = threading.RLock()
        self._runs: dict[str, _RunState] = {}
        self._events_dir = Path(events_dir) if events_dir else None
        self._ring_size = ring_size

    # ------------------------------------------------------------------
    # lifecycle
    # ------------------------------------------------------------------

    def open_run(self, run_id: str) -> None:
        """Pre-register a run so subscribers can attach before the first publish."""
        self._state_for(run_id)

    def close_run(self, run_id: str) -> None:
        with self._lock:
            state = self._runs.get(run_id)
        if state is not None:
            state.close()

    # ------------------------------------------------------------------
    # publish
    # ------------------------------------------------------------------

    def publish(self, run_id: str, event: str, **data: Any) -> RunEvent:
        """Emit a structured event to all subscribers for `run_id`.

        Returns the materialized `RunEvent` for the caller's convenience.
        """
        state = self._state_for(run_id)
        with state.lock:
            state.seq += 1
            rec = RunEvent(
                run_id=run_id,
                seq=state.seq,
                ts=time.time(),
                event=event,
                data=data,
            )
            state.ring.append(rec)
            state._open_jsonl()
            if state._jsonl_fh is not None:
                try:
                    state._jsonl_fh.write(json.dumps(rec.to_dict(), default=str) + "\n")
                except OSError as exc:  # pragma: no cover
                    logger.warning("event_bus jsonl write failed: %s", exc)
            callbacks = list(state.callbacks)
            queues = list(state.async_queues)
        # Notify outside the lock to avoid deadlocks if a subscriber
        # re-publishes synchronously.
        for cb in callbacks:
            try:
                cb(rec)
            except Exception as exc:  # noqa: BLE001
                logger.warning("event_bus callback error: %s", exc)
        for loop, q in queues:
            try:
                loop.call_soon_threadsafe(q.put_nowait, rec)
            except RuntimeError:
                # Loop closed; drop silently. The /unsubscribe path is
                # expected to clean up these entries.
                pass
        return rec

    # ------------------------------------------------------------------
    # subscribe / replay
    # ------------------------------------------------------------------

    def subscribe(self, run_id: str, callback: Callback) -> Callable[[], None]:
        """Register a synchronous callback; returns an unsubscribe handle."""
        state = self._state_for(run_id)
        with state.lock:
            state.callbacks.append(callback)

        def _unsub() -> None:
            with state.lock:
                try:
                    state.callbacks.remove(callback)
                except ValueError:
                    pass

        return _unsub

    def subscribe_async(
        self, run_id: str, loop: asyncio.AbstractEventLoop | None = None
    ) -> tuple[asyncio.Queue, Callable[[], None]]:
        """Get an asyncio.Queue receiving future events, plus an unsubscribe."""
        loop = loop or asyncio.get_event_loop()
        q: asyncio.Queue = asyncio.Queue()
        state = self._state_for(run_id)
        entry = (loop, q)
        with state.lock:
            state.async_queues.append(entry)

        def _unsub() -> None:
            with state.lock:
                try:
                    state.async_queues.remove(entry)
                except ValueError:
                    pass

        return q, _unsub

    def replay(self, run_id: str, since_seq: int = 0) -> list[RunEvent]:
        """Return events from the in-memory ring with seq > since_seq."""
        with self._lock:
            state = self._runs.get(run_id)
        if state is None:
            return []
        with state.lock:
            return [e for e in state.ring if e.seq > since_seq]

    # ------------------------------------------------------------------
    # internals
    # ------------------------------------------------------------------

    def _state_for(self, run_id: str) -> _RunState:
        with self._lock:
            state = self._runs.get(run_id)
            if state is None:
                jsonl = (
                    self._events_dir / f"{run_id}.events.jsonl"
                    if self._events_dir
                    else None
                )
                state = _RunState(run_id, jsonl, self._ring_size)
                self._runs[run_id] = state
            return state


# ----------------------------------------------------------------------
# module-level default bus
# ----------------------------------------------------------------------

_default_bus: RunEventBus | None = None
_default_lock = threading.Lock()


def get_default_bus(events_dir: str | Path | None = None) -> RunEventBus:
    """Lazy module-level bus. Safe across the FastAPI app + CLI in one process."""
    global _default_bus
    with _default_lock:
        if _default_bus is None:
            _default_bus = RunEventBus(events_dir=events_dir)
        return _default_bus


def reset_default_bus_for_tests() -> None:  # pragma: no cover
    """Test helper. Never call in production code."""
    global _default_bus
    with _default_lock:
        _default_bus = None


# ----------------------------------------------------------------------
# canonical event names
# ----------------------------------------------------------------------

class Events:
    RUN_STARTED = "run.started"
    RUN_PROGRESS = "run.progress"
    RUN_COMPLETED = "run.completed"
    RUN_FAILED = "run.failed"

    STAGE_STARTED = "stage.started"
    STAGE_COMPLETED = "stage.completed"

    HITL_REQUIRED = "hitl.required"
    HITL_APPROVED = "hitl.approved"
    HITL_REJECTED = "hitl.rejected"

    CVE_QUEUED = "cve.queued"
    CVE_STARTED = "cve.started"
    CVE_ENRICHED = "cve.enriched"
    CVE_RETRIEVED = "cve.retrieved"
    CVE_TRIAGED = "cve.triaged"
    CVE_COMPLETED = "cve.completed"
    CVE_FAILED = "cve.failed"

    PATCH_AUTHORED = "patch.authored"
    PATCH_VERIFIED = "patch.verified"
    PATCH_APPLIED = "patch.applied"
