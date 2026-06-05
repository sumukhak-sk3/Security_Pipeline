"""Shared helpers: config loading, env expansion, IO, sanitization."""
from __future__ import annotations

import json
import os
import re
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

import yaml

from .exceptions import ConfigError

_ENV_PATTERN = re.compile(r"\$\{([A-Z0-9_]+)(?::-(.*?))?\}")
_SECRET_KEY_PATTERN = re.compile(
    r"(api[_-]?key|secret|token|password|authorization)", re.IGNORECASE
)

_DOTENV_LOADED = False


def load_dotenv_if_present(extra_paths: list[str | os.PathLike[str]] | None = None) -> str | None:
    """Load environment variables from `.env` files if python-dotenv is installed.

    Resolution order (first existing file wins, then merges):
      1. $DOTENV_PATH if set
      2. ./.env in the current working directory
      3. <repo_root>/.env (parent of the `apps/` directory)
      4. Any additional paths supplied by the caller

    Existing process env vars are NOT overwritten. Idempotent: only loads once
    per process.
    """
    global _DOTENV_LOADED
    if _DOTENV_LOADED:
        return None
    try:
        from dotenv import load_dotenv  # type: ignore
    except ImportError:
        return None

    candidates: list[Path] = []
    explicit = os.environ.get("DOTENV_PATH")
    if explicit:
        candidates.append(Path(explicit))
    candidates.append(Path.cwd() / ".env")
    # Walk up from this file to find a sibling `.env` at repo root.
    here = Path(__file__).resolve()
    for parent in here.parents:
        if (parent / "apps").is_dir():
            candidates.append(parent / ".env")
            break
    for p in extra_paths or []:
        candidates.append(Path(p))

    loaded_from: str | None = None
    seen: set[Path] = set()
    for c in candidates:
        c_resolved = c.resolve() if c.exists() else c
        if c_resolved in seen or not c.exists():
            continue
        seen.add(c_resolved)
        load_dotenv(dotenv_path=c, override=False)
        loaded_from = loaded_from or str(c)
    _DOTENV_LOADED = True
    return loaded_from


def _expand_env(value: Any) -> Any:
    if isinstance(value, str):
        def repl(m: re.Match[str]) -> str:
            name, default = m.group(1), m.group(2) or ""
            return os.environ.get(name, default)

        return _ENV_PATTERN.sub(repl, value)
    if isinstance(value, list):
        return [_expand_env(v) for v in value]
    if isinstance(value, dict):
        return {k: _expand_env(v) for k, v in value.items()}
    return value


def load_yaml(path: str | os.PathLike[str]) -> dict[str, Any]:
    # Make sure .env values are present before we expand ${VAR} placeholders.
    load_dotenv_if_present()
    p = Path(path)
    if not p.exists():
        raise ConfigError(f"Config file not found: {p}")
    with p.open("r", encoding="utf-8") as f:
        raw = yaml.safe_load(f) or {}
    return _expand_env(raw)


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds")


def new_id(prefix: str = "an") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:12]}"


def ensure_dir(path: str | os.PathLike[str]) -> Path:
    p = Path(path)
    p.mkdir(parents=True, exist_ok=True)
    return p


def write_json(path: str | os.PathLike[str], data: Any) -> None:
    p = Path(path)
    ensure_dir(p.parent)
    with p.open("w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, default=str)


def sanitize_for_log(data: Any) -> Any:
    """Recursively redact obvious secret values for logging."""
    if isinstance(data, dict):
        out: dict[str, Any] = {}
        for k, v in data.items():
            if isinstance(k, str) and _SECRET_KEY_PATTERN.search(k):
                out[k] = "<redacted>"
            else:
                out[k] = sanitize_for_log(v)
        return out
    if isinstance(data, list):
        return [sanitize_for_log(v) for v in data]
    if isinstance(data, str) and len(data) > 4000:
        return data[:4000] + "...<truncated>"
    return data


def parse_model_family(model_name: str) -> str:
    """Return the family token from a LiteLLM model id.

    Scans the whole id (including any vendor / route prefix) for known family
    tokens so that proxy-style names work correctly. For example:

        gpt-5-mini-us-east-2-prod        -> "gpt"
        bedrock/claude-opus-4.7          -> "claude"
        vertex_ai/claude-opus-4.7        -> "claude"
        vertex_ai/gemini-3.1-pro-preview -> "gemini"
        Llama-3.3-70B-Instruct           -> "llama"

    If no known family token is found, falls back to the vendor prefix (text
    before the first "/") or the lowercased model id.
    """
    if not model_name:
        return ""
    lowered = model_name.lower()
    # Order matters only if family tokens overlap; these don't.
    known_families = (
        "gpt",
        "claude",
        "gemini",
        "llama",
        "mistral",
        "mixtral",
        "deepseek",
        "qwen",
        "command",  # cohere command-*
        "titan",    # amazon titan-*
    )
    for fam in known_families:
        # Match the family token as a whole word (delimited by start/end or
        # non-alphanumeric) anywhere in the id.
        if re.search(rf"(?:^|[^a-z0-9]){fam}(?:[^a-z]|$)", lowered):
            return fam
    if "/" in model_name:
        return model_name.split("/", 1)[0].lower()
    return lowered
