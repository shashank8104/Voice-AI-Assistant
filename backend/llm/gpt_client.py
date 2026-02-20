"""
GPT-4o Streaming LLM Client
Streams tokens from OpenAI GPT-4o for real-time TTS forwarding.
"""
import asyncio
import logging
import os
from typing import AsyncGenerator, Optional

from openai import AsyncOpenAI

logger = logging.getLogger(__name__)


async def stream_llm_response(
    messages: list[dict],
) -> AsyncGenerator[str, None]:
    """
    Stream GPT tokens. Yields text chunks as they arrive.
    Reads API key lazily so dotenv is guaranteed to have loaded.
    """
    api_key = os.getenv("OPENAI_API_KEY", "")
    client = AsyncOpenAI(api_key=api_key)

    try:
        stream = await client.chat.completions.create(
            model="gpt-4o-mini",   # Faster than gpt-4o; switch to gpt-4o for quality
            messages=messages,
            stream=True,
            temperature=0.7,
            max_tokens=150,        # Short responses = lower latency for voice
        )

        async for chunk in stream:
            await asyncio.sleep(0)
            delta = chunk.choices[0].delta if chunk.choices else None
            if delta and delta.content:
                yield delta.content

    except asyncio.CancelledError:
        logger.info("[GPT] Stream cancelled")
        raise
    except Exception as e:
        logger.error(f"[GPT] Error: {type(e).__name__}: {e}")
        raise
