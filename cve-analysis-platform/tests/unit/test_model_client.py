from apps.common.utils import parse_model_family
from apps.common.exceptions import ModelFamilyConflictError
from apps.common.model_client import ModelClient, ModelConfig

import pytest


def test_parse_model_family_vendor_prefix():
    # Proxy-style ids: family token wins over the vendor route prefix.
    assert parse_model_family("openai/gpt-4o-mini") == "gpt"
    assert parse_model_family("anthropic/claude-3-5-sonnet") == "claude"


def test_parse_model_family_bare():
    assert parse_model_family("gpt-4o-mini") == "gpt"
    assert parse_model_family("claude-3-haiku") == "claude"


def test_parse_model_family_infoblox_proxy_ids():
    # Real model ids from the Infoblox LiteLLM proxy.
    assert parse_model_family("gpt-5-mini-us-east-2-prod") == "gpt"
    assert parse_model_family("gpt-4o-mini-us-east-2-prod") == "gpt"
    assert parse_model_family("bedrock/claude-opus-4.7") == "claude"
    assert parse_model_family("vertex_ai/claude-opus-4.6") == "claude"
    assert parse_model_family("vertex_ai/gemini-3.1-pro-preview") == "gemini"
    assert parse_model_family("Llama-3.3-70B-Instruct") == "llama"


def test_proxy_routes_to_same_family_are_blocked():
    # bedrock/claude-* and vertex_ai/claude-* are the SAME family.
    with pytest.raises(ModelFamilyConflictError):
        ModelClient(ModelConfig(
            author="bedrock/claude-opus-4.7",
            verifier="vertex_ai/claude-opus-4.7",
            tiebreaker=None, timeout_s=30, max_retries=1, backoff_s=0.1,
        ))


def test_author_verifier_must_differ():
    with pytest.raises(ModelFamilyConflictError):
        ModelClient(ModelConfig(
            author="openai/gpt-4o", verifier="openai/gpt-4o-mini",
            tiebreaker=None, timeout_s=30, max_retries=1, backoff_s=0.1,
        ))


def test_author_verifier_different_ok():
    c = ModelClient(ModelConfig(
        author="gpt-5-mini-us-east-2-prod",
        verifier="bedrock/claude-opus-4.7",
        tiebreaker=None, timeout_s=30, max_retries=1, backoff_s=0.1,
    ))
    assert c.cfg.author.startswith("gpt-5")
