"""
LLM inference client — proxies to any OpenAI-compatible API.

Default backend: Phala Confidential AI API (https://api.redpill.ai/v1)
All models on Phala run inside GPU TEEs with hardware attestation.

For local dev: Ollama, vLLM, or any local model server.
"""

import httpx
from typing import AsyncIterator

from .config import LLM_BACKEND_URL, LLM_API_KEY, MODEL_NAME


def _headers() -> dict[str, str]:
    headers = {"Content-Type": "application/json"}
    if LLM_API_KEY:
        headers["Authorization"] = f"Bearer {LLM_API_KEY}"
    return headers


async def list_models() -> list[dict]:
    """Fetch available models from the LLM backend."""
    async with httpx.AsyncClient(timeout=30.0) as client:
        response = await client.get(
            f"{LLM_BACKEND_URL}/models",
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
    max_tokens: int = 2048,
    stream: bool = False,
) -> dict:
    """Call the LLM backend with an OpenAI-compatible request."""
    payload = {
        "model": model or MODEL_NAME,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": stream,
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        response = await client.post(
            f"{LLM_BACKEND_URL}/chat/completions",
            json=payload,
            headers=_headers(),
        )
        response.raise_for_status()
        return response.json()


async def stream_chat_completion(
    messages: list[dict],
    model: str | None = None,
    temperature: float = 0.7,
    max_tokens: int = 2048,
) -> AsyncIterator[str]:
    """Stream chat completion chunks as SSE data lines."""
    payload = {
        "model": model or MODEL_NAME,
        "messages": messages,
        "temperature": temperature,
        "max_tokens": max_tokens,
        "stream": True,
    }

    async with httpx.AsyncClient(timeout=120.0) as client:
        async with client.stream(
            "POST",
            f"{LLM_BACKEND_URL}/chat/completions",
            json=payload,
            headers=_headers(),
        ) as response:
            response.raise_for_status()
            async for line in response.aiter_lines():
                if line.startswith("data: "):
                    yield line[6:]
