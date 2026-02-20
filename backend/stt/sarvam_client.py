"""
Sarvam STT Client
Uses saaras:v3 model with auto language detection (English + Hindi).
"""
import asyncio
import logging
import os
import struct
from typing import Optional

import httpx

logger = logging.getLogger(__name__)

SARVAM_STT_URL = "https://api.sarvam.ai/speech-to-text"
SAMPLE_RATE = 16000


async def transcribe_audio(audio_bytes: bytes) -> Optional[str]:
    """
    Send PCM audio bytes to Sarvam STT and return transcript.
    Reads API key lazily so dotenv is guaranteed to have loaded.
    """
    api_key = os.getenv("SARVAM_API_KEY", "")
    if not api_key or api_key == "your_sarvam_api_key_here":
        logger.error("[Sarvam STT] SARVAM_API_KEY not set or is placeholder")
        return None

    if len(audio_bytes) < 3200:  # At least 100ms of audio
        logger.warning(f"[Sarvam STT] Audio too short: {len(audio_bytes)} bytes")
        return None

    wav_bytes = _pcm_to_wav(audio_bytes, SAMPLE_RATE)
    logger.info(f"[Sarvam STT] Sending {len(audio_bytes)} PCM bytes ({len(wav_bytes)} WAV bytes)")

    try:
        async with httpx.AsyncClient(timeout=15.0) as client:
            response = await client.post(
                SARVAM_STT_URL,
                headers={"api-subscription-key": api_key},
                files={"file": ("audio.wav", wav_bytes, "audio/wav")},
                data={
                    "model": "saarika:v2.5",
                    "language_code": "en-IN",
                },
            )

            logger.info(f"[Sarvam STT] Response status: {response.status_code}")

            if response.status_code == 200:
                result = response.json()
                logger.info(f"[Sarvam STT] Raw response: {result}")
                transcript = result.get("transcript", "").strip()
                if transcript:
                    logger.info(f"[Sarvam STT] Transcript: {transcript}")
                    return transcript
                else:
                    logger.warning("[Sarvam STT] Empty transcript in response")
                    return None
            else:
                logger.error(f"[Sarvam STT] Error {response.status_code}: {response.text}")
                return None

    except httpx.TimeoutException:
        logger.error("[Sarvam STT] Request timed out")
        return None
    except Exception as e:
        logger.error(f"[Sarvam STT] Exception: {e}", exc_info=True)
        return None


async def transcribe_with_retry(audio_bytes: bytes) -> Optional[str]:
    """Transcribe with one silent retry on failure."""
    result = await transcribe_audio(audio_bytes)
    if result is not None:
        return result

    logger.info("[Sarvam STT] Retrying once after 0.5s...")
    await asyncio.sleep(0.5)
    return await transcribe_audio(audio_bytes)


def _pcm_to_wav(pcm_bytes: bytes, sample_rate: int) -> bytes:
    """Convert raw PCM Int16 LE bytes to WAV format."""
    num_channels = 1
    bits_per_sample = 16
    byte_rate = sample_rate * num_channels * bits_per_sample // 8
    block_align = num_channels * bits_per_sample // 8
    data_size = len(pcm_bytes)
    chunk_size = 36 + data_size

    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", chunk_size, b"WAVE",
        b"fmt ", 16, 1,  # PCM
        num_channels, sample_rate, byte_rate, block_align, bits_per_sample,
        b"data", data_size,
    )
    return header + pcm_bytes
