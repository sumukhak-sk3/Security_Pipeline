"""LiteLLM-based model client with role separation and family enforcement.

All LLM calls go through this module. It enforces:

- Author and verifier MUST come from different model families.
- Bounded retries + timeout per call.
- Structured JSON response parsing (`response_format=json_object` when supported,
  with a defensive JSON-extract fallback).
- Token/cost logging via LiteLLM usage data when present.
- Secret-free logging (prompts are summarized, never echoed in full).
"""
from __future__ import annotations

import json
import re
import time
from dataclasses import dataclass
from typing import Any

from tenacity import (
    retry,
    retry_if_exception_type,
    stop_after_attempt,
    wait_exponential,
)

from .exceptions import ModelClientError, ModelFamilyConflictError
from .logging_utils import get_logger, log_event
from .utils import parse_model_family

logger = get_logger(__name__)


@dataclass(frozen=True)
class ModelConfig:
    author: str
    verifier: str
    tiebreaker: str | None
    timeout_s: int
    max_retries: int
    backoff_s: float
    proxy_base_url: str | None = None
    proxy_api_key: str | None = None


@dataclass
class LLMResult:
    role: str
    model: str
    content: str
    parsed: dict[str, Any]
    usage: dict[str, Any]
    latency_ms: int


def _strict_json(text: str) -> dict[str, Any]:
    """Parse JSON robustly. Tolerates surrounding prose or markdown fences."""
    if not text:
        raise ModelClientError("empty model response")
    text = text.strip()
    # Strip ```json fences if present.
    fence = re.match(r"```(?:json)?\s*(.*?)\s*```", text, flags=re.DOTALL)
    if fence:
        text = fence.group(1).strip()
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # Fallback: grab the first {...} block.
    match = re.search(r"\{.*\}", text, flags=re.DOTALL)
    if not match:
        raise ModelClientError("model response did not contain JSON")
    try:
        return json.loads(match.group(0))
    except json.JSONDecodeError as exc:
        raise ModelClientError(f"failed to parse JSON: {exc}") from exc


class ModelClient:
    """Thin wrapper over LiteLLM with role-aware dispatch."""

    AUTHOR = "author"
    VERIFIER = "verifier"
    TIEBREAKER = "tiebreaker"
    CONTEXT = "context"  # uses author family

    def __init__(self, cfg: ModelConfig) -> None:
        self.cfg = cfg
        self._validate_families()

    def _validate_families(self) -> None:
        author_fam = parse_model_family(self.cfg.author)
        verifier_fam = parse_model_family(self.cfg.verifier)
        if not author_fam or not verifier_fam:
            raise ModelFamilyConflictError(
                "author and verifier models must both be configured"
            )
        if author_fam == verifier_fam:
            raise ModelFamilyConflictError(
                f"author ({self.cfg.author}) and verifier ({self.cfg.verifier}) "
                "share model family; choose different families"
            )

    def _model_for_role(self, role: str) -> str:
        if role == self.VERIFIER:
            return self.cfg.verifier
        if role == self.TIEBREAKER:
            if not self.cfg.tiebreaker:
                raise ModelClientError("tiebreaker model not configured")
            return self.cfg.tiebreaker
        return self.cfg.author

    def call_json(
        self,
        role: str,
        system: str,
        user: str,
        *,
        prompt_version: str | None = None,
        temperature: float = 0.1,
    ) -> LLMResult:
        model = self._model_for_role(role)
        return self._invoke(
            role=role,
            model=model,
            system=system,
            user=user,
            prompt_version=prompt_version or "n/a",
            temperature=temperature,
        )

    @retry(
        reraise=True,
        retry=retry_if_exception_type(ModelClientError),
        stop=stop_after_attempt(3),
        wait=wait_exponential(multiplier=2, min=2, max=20),
    )
    def _invoke(
        self,
        *,
        role: str,
        model: str,
        system: str,
        user: str,
        prompt_version: str,
        temperature: float,
    ) -> LLMResult:
        try:
            import litellm  # imported lazily so unit tests can stub it
        except ImportError as exc:  # pragma: no cover
            raise ModelClientError("litellm is not installed") from exc

        start = time.time()
        # When routing through a LiteLLM proxy, the SDK needs an explicit
        # provider prefix so it knows to use the OpenAI-compatible protocol.
        # We auto-prepend "openai/" when no recognized prefix is present.
        # Family detection still uses the *original* model id, so the
        # author/verifier family check is unaffected.
        proxy_model = model
        if self.cfg.proxy_base_url:
            known_prefixes = (
                "openai/", "azure/", "anthropic/", "bedrock/", "vertex_ai/",
                "gemini/", "ollama/", "huggingface/", "together_ai/",
                "groq/", "mistral/", "cohere/", "litellm_proxy/",
            )
            if not any(model.startswith(p) for p in known_prefixes):
                proxy_model = f"openai/{model}"

        common_kwargs: dict[str, Any] = {
            "model": proxy_model,
            "messages": [
                {"role": "system", "content": system},
                {"role": "user", "content": user},
            ],
            "temperature": temperature,
            "timeout": self.cfg.timeout_s,
        }
        # gpt-5 family rejects any temperature other than 1 (and reasoning
        # models like o1/o3 behave similarly). Drop the parameter so the
        # provider applies its own default rather than failing the call.
        _lower_model = model.lower()
        if (
            "gpt-5" in _lower_model
            or re.search(r"(^|/)o[13](-|$)", _lower_model)
        ):
            common_kwargs.pop("temperature", None)
        # When a LiteLLM proxy is configured, route every call through it
        # using a single API key. The model name should match what the proxy
        # exposes (e.g. "openai/gpt-4o-mini").
        if self.cfg.proxy_base_url:
            common_kwargs["api_base"] = self.cfg.proxy_base_url
        if self.cfg.proxy_api_key:
            common_kwargs["api_key"] = self.cfg.proxy_api_key

        try:
            response = litellm.completion(
                **common_kwargs,
                response_format={"type": "json_object"},
            )
        except TypeError:
            # Some providers reject response_format; retry without it.
            response = litellm.completion(**common_kwargs)
        except Exception as exc:  # noqa: BLE001
            raise ModelClientError(f"litellm call failed: {exc}") from exc

        latency_ms = int((time.time() - start) * 1000)
        try:
            content = response["choices"][0]["message"]["content"]
        except (KeyError, IndexError, TypeError) as exc:
            raise ModelClientError(f"unexpected response shape: {exc}") from exc

        usage = {}
        try:
            usage = dict(response.get("usage") or {})
        except Exception:  # noqa: BLE001
            usage = {}

        parsed = _strict_json(content)

        log_event(
            logger,
            "llm.call",
            role=role,
            model=model,
            prompt_version=prompt_version,
            latency_ms=latency_ms,
            prompt_tokens=usage.get("prompt_tokens"),
            completion_tokens=usage.get("completion_tokens"),
            total_tokens=usage.get("total_tokens"),
        )

        return LLMResult(
            role=role,
            model=model,
            content=content,
            parsed=parsed,
            usage=usage,
            latency_ms=latency_ms,
        )


def build_model_client(cfg_dict: dict[str, Any]) -> ModelClient:
    cfg = ModelConfig(
        author=cfg_dict.get("author", ""),
        verifier=cfg_dict.get("verifier", ""),
        tiebreaker=(cfg_dict.get("tiebreaker") or None),
        timeout_s=int(cfg_dict.get("request_timeout_s", 60)),
        max_retries=int(cfg_dict.get("max_retries", 3)),
        backoff_s=float(cfg_dict.get("retry_backoff_s", 2)),
        proxy_base_url=(cfg_dict.get("proxy_base_url") or None),
        proxy_api_key=(cfg_dict.get("proxy_api_key") or None),
    )
    return ModelClient(cfg)
