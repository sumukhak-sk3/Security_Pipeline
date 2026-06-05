"""Structured JSON logging setup and per-request correlation context."""
from __future__ import annotations

import contextvars
import logging
import logging.config
from pathlib import Path
from typing import Any

import yaml

_analysis_id_var: contextvars.ContextVar[str] = contextvars.ContextVar(
    "analysis_id", default="-"
)


class CorrelationFilter(logging.Filter):
    def filter(self, record: logging.LogRecord) -> bool:
        record.analysis_id = _analysis_id_var.get()
        return True


def configure_logging(config_path: str | Path | None = None) -> None:
    if config_path and Path(config_path).exists():
        with open(config_path, "r", encoding="utf-8") as f:
            cfg = yaml.safe_load(f)
        logging.config.dictConfig(cfg)
    else:
        logging.basicConfig(
            level=logging.INFO,
            format="%(asctime)s %(levelname)s %(name)s [%(analysis_id)s] %(message)s",
        )
    root = logging.getLogger()
    if not any(isinstance(f, CorrelationFilter) for f in root.filters):
        root.addFilter(CorrelationFilter())
    for handler in root.handlers:
        if not any(isinstance(f, CorrelationFilter) for f in handler.filters):
            handler.addFilter(CorrelationFilter())


def set_analysis_id(analysis_id: str) -> None:
    _analysis_id_var.set(analysis_id)


def get_analysis_id() -> str:
    return _analysis_id_var.get()


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def log_event(logger: logging.Logger, event: str, **fields: Any) -> None:
    """Emit a structured event with consistent keys."""
    payload = {"event": event, **fields}
    logger.info(payload)
