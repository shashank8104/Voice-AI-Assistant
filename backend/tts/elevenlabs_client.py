"""
ElevenLabs Streaming TTS Client
Streams audio chunks from ElevenLabs as LLM tokens arrive.
Fixed: uses a proper async generator without nested httpx context managers.
"""
import asyncio
import logging
import os
from typing import AsyncGenerator

import httpx

logger = logging.getLogger(__name__)

ELEVENLABS_MODEL = "eleven_turbo_v2_5"


async def stream_tts(text_generator: AsyncGenerator[str, None]) -> AsyncGenerator[bytes, None]:
    """
    Collect all LLM tokens, then stream TTS audio chunks back.
    Reads API key lazily so dotenv is guaranteed to have loaded.
    """
    api_key = os.getenv("ELEVENLABS_API_KEY", "")
    voice_id = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")

    if not api_key or api_key == "your_elevenlabs_api_key_here":
        logger.error("[ElevenLabs] ELEVENLABS_API_KEY not set or is placeholder")
        return

    # ── Collect all tokens first ──────────────────────────────────────────
    # We buffer into sentence-sized chunks for better TTS quality
    text_buffer = ""
    sentences = []

    try:
        async for token in text_generator:
            await asyncio.sleep(0)
            text_buffer += token

            # Split on sentence boundaries
            while True:
                for sep in [". ", "! ", "? ", ".\n", "!\n", "?\n"]:
                    idx = text_buffer.find(sep)
                    if idx != -1:
                        sentence = text_buffer[:idx + len(sep)].strip()
                        text_buffer = text_buffer[idx + len(sep):]
                        if sentence:
                            sentences.append(sentence)
                        break
                else:
                    break  # No separator found, keep buffering

        # Add any remaining text
        if text_buffer.strip():
            sentences.append(text_buffer.strip())

    except asyncio.CancelledError:
        logger.info("[ElevenLabs] Token collection cancelled")
        raise

    if not sentences:
        logger.warning("[ElevenLabs] No text to synthesize")
        return

    full_text = " ".join(sentences)
    logger.info(f"[ElevenLabs] Synthesizing {len(full_text)} chars: {full_text[:80]}...")

    # ── Send to ElevenLabs and stream audio back ──────────────────────────
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice_id}/stream"
    headers = {
        "xi-api-key": api_key,
        "Content-Type": "application/json",
    }
    payload = {
        "text": full_text,
        "model_id": ELEVENLABS_MODEL,
        "voice_settings": {
            "stability": 0.5,
            "similarity_boost": 0.75,
            "style": 0.0,
            "use_speaker_boost": True,
        },
    }

    try:
        async with httpx.AsyncClient(timeout=60.0) as client:
            async with client.stream("POST", url, headers=headers, json=payload) as response:
                logger.info(f"[ElevenLabs] Response status: {response.status_code}")

                if response.status_code != 200:
                    error_body = await response.aread()
                    logger.error(f"[ElevenLabs] Error {response.status_code}: {error_body.decode()}")
                    return

                chunk_count = 0
                total_bytes = 0
                async for chunk in response.aiter_bytes(chunk_size=4096):
                    if chunk:
                        await asyncio.sleep(0)  # Cancellation checkpoint
                        chunk_count += 1
                        total_bytes += len(chunk)
                        logger.debug(f"[ElevenLabs] Chunk {chunk_count}: {len(chunk)} bytes")
                        yield chunk

                logger.info(f"[ElevenLabs] Done: {total_bytes} bytes in {chunk_count} chunks")

    except asyncio.CancelledError:
        logger.info("[ElevenLabs] TTS stream cancelled")
        raise
    except Exception as e:
        logger.error(f"[ElevenLabs] Exception: {e}", exc_info=True)
        raise
