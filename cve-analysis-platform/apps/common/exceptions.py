"""Domain exceptions for Workflow D."""
from __future__ import annotations


class WorkflowDError(Exception):
    """Base error for Workflow D."""


class ConfigError(WorkflowDError):
    """Invalid or missing configuration."""


class ModelClientError(WorkflowDError):
    """LiteLLM-side failure (timeout, auth, parsing)."""


class ModelFamilyConflictError(ConfigError):
    """Author and verifier resolved to the same model family."""


class EvidenceError(WorkflowDError):
    """Failure while building an evidence bundle."""


class RegistryError(WorkflowDError):
    """SQLite registry failure."""


class RetrievalError(WorkflowDError):
    """Code-RAG retrieval failure."""
