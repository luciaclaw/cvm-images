"""
LLM inference client — proxies to any OpenAI-compatible API.

Default backend: Phala Confidential AI API (https://api.redpill.ai/v1)
All models on Phala run inside GPU TEEs with hardware attestation.

For local dev: Ollama, vLLM, or any local model server.
"""

import asyncio
import logging

import httpx
from typing import AsyncIterator

from . import config

logger = logging.getLogger(__name__)

# Default STT model — Whisper Small V3 Turbo for low-latency on CPU TEE
STT_MODEL = "whisper-small-v3-turbo"

# Persistent HTTP client — reuses TCP connections to the LLM backend.
_http_client: httpx.AsyncClient | None = None


def _get_client() -> httpx.AsyncClient:
    global _http_client
    if _http_client is None or _http_client.is_closed:
        _http_client = httpx.AsyncClient(
            timeout=httpx.Timeout(120.0, connect=10.0),
            limits=httpx.Limits(max_connections=10, max_keepalive_connections=5),
        )
    return _http_client


def _headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if config.LLM_API_KEY:
        headers["Authorization"] = f"Bearer {config.LLM_API_KEY}"
    return headers


async def list_models() -> list[dict]:
    """Fetch available models from the LLM backend."""
    client = _get_client()
    response = await client.get(
        f"{config.LLM_BACKEND_URL}/models",
        headers=_headers(),
    )
    response.raise_for_status()
    data = response.json()
    # OpenAI-compatible /v1/models returns { data: [...] }
    return data.get("data", [])


async def chat_completion(
    messages: list[dict],
    model: str | None = None,
    temperature: float = 0.7,
    max_tokens: int = 8192,
    stream: bool = False,
    tools: list[dict] | None = None,
    tool_choice: str | None = None,
) -> dict:
    """Call the LLM backend with an OpenAI-compatible request."""
    payload = {
        "model": model or config.MODEL_NAME,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": stream,
    }

    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = tool_choice or "auto"

    client = _get_client()

    tool_count = len(payload.get("tools", []))

    # Retry on 400 — some aggregator backends intermittently reject tool-calling
    # payloads when routed to an instance that doesn't support them.
    max_retries = 2
    for attempt in range(max_retries + 1):
        response = await client.post(
            f"{config.LLM_BACKEND_URL}/chat/completions",
            json=payload,
            headers=_headers(),
        )
        if response.status_code == 400 and attempt < max_retries:
            body = response.text
            logger.warning(
                "LLM backend returned 400 (attempt %d/%d): %s",
                attempt + 1, max_retries + 1, body[:500],
            )
            if tool_count > 0:
                # Log tool names for debugging
                tool_names = [t.get("function", {}).get("name", "?") for t in payload.get("tools", [])]
                logger.warning("Tools in request: %s", tool_names)
            await asyncio.sleep(0.5 * (attempt + 1))
            continue
        response.raise_for_status()
        return response.json()

    # Should not reach here, but just in case
    raise httpx.HTTPStatusError(
        "Max retries exceeded", request=response.request, response=response  # type: ignore[possibly-undefined]
    )


async def audio_transcription(
    audio_data: bytes,
    filename: str = "audio.ogg",
    model: str | None = None,
    language: str | None = None,
    response_format: str = "json",
) -> dict:
    """
    Transcribe audio using the OpenAI-compatible audio transcription endpoint.

    Proxies to the backend's /audio/transcriptions endpoint.
    Falls back to local Whisper if the backend doesn't support audio.
    """
    use_model = model or STT_MODEL

    headers: dict[str, str] = {}
    if config.LLM_API_KEY:
        headers["Authorization"] = f"Bearer {config.LLM_API_KEY}"

    # Build multipart form data (OpenAI Whisper API format)
    files = {"file": (filename, audio_data, "application/octet-stream")}
    data: dict[str, str] = {
        "model": use_model,
        "response_format": response_format,
    }
    if language:
        data["language"] = language

    client = _get_client()
    response = await client.post(
        f"{config.LLM_BACKEND_URL}/audio/transcriptions",
        files=files,
        data=data,
        headers=headers,
    )
    response.raise_for_status()
    return response.json()


async def stream_chat_completion(
    messages: list[dict],
    model: str | None = None,
    temperature: float = 0.7,
    max_tokens: int = 8192,
) -> AsyncIterator[str]:
    """Stream chat completion chunks as SSE data lines."""
    payload = {
        "model": model or config.MODEL_NAME,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }

    client = _get_client()
    async with client.stream(
        "POST",
        f"{config.LLM_BACKEND_URL}/chat/completions",
        json=payload,
        headers=_headers(),
    ) as response:
        response.raise_for_status()
        async for line in response.aiter_lines():
            if line.startswith("data: "):
                yield line[6:]
