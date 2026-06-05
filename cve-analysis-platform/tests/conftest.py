"""Pytest config: ensure project root is importable and provide a fake LiteLLM.

The fake LiteLLM lets unit/integration tests run without network access or API
keys. Tests can patch `apps.common.model_client.litellm` (lazy import) by
adjusting `_FAKE_RESPONSES`.
"""
from __future__ import annotations

import sys
import types
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT))


_FAKE_RESPONSES: dict[str, dict] = {}


def set_fake_response(model_substring: str, payload: dict) -> None:
    _FAKE_RESPONSES[model_substring] = payload


def clear_fake_responses() -> None:
    _FAKE_RESPONSES.clear()


def _make_response(content: str) -> dict:
    return {
        "choices": [{"message": {"content": content}}],
        "usage": {"prompt_tokens": 10, "completion_tokens": 20, "total_tokens": 30},
    }


def _fake_completion(**kwargs):  # noqa: ANN001
    import json

    model = kwargs.get("model", "")
    for key, payload in _FAKE_RESPONSES.items():
        if key in model:
            return _make_response(json.dumps(payload))
    return _make_response(json.dumps({"_unmatched_model": model}))


fake_litellm = types.ModuleType("litellm")
fake_litellm.completion = _fake_completion  # type: ignore[attr-defined]
sys.modules.setdefault("litellm", fake_litellm)
