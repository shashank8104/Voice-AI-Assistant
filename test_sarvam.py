"""Quick Sarvam API test — generates a 1s sine wave and sends it."""
import asyncio
import struct
import math
import os
import httpx
from dotenv import load_dotenv

load_dotenv()

SARVAM_API_KEY = os.getenv("SARVAM_API_KEY", "")
print(f"API Key present: {'YES' if SARVAM_API_KEY and SARVAM_API_KEY != 'your_sarvam_api_key_here' else 'NO/PLACEHOLDER'}")

def make_test_wav(duration_s=1.0, sample_rate=16000, freq=440):
    num_samples = int(sample_rate * duration_s)
    samples = [int(32767 * math.sin(2 * math.pi * freq * i / sample_rate)) for i in range(num_samples)]
    pcm = struct.pack(f"<{num_samples}h", *samples)
    data_size = len(pcm)
    chunk_size = 36 + data_size
    header = struct.pack(
        "<4sI4s4sIHHIIHH4sI",
        b"RIFF", chunk_size, b"WAVE",
        b"fmt ", 16, 1, 1, sample_rate,
        sample_rate * 2, 2, 16,
        b"data", data_size,
    )
    return header + pcm

async def test():
    wav = make_test_wav(duration_s=2.0)
    print(f"WAV size: {len(wav)} bytes\n")

    models_to_test = [
        ("saaras:v3",   {"model": "saaras:v3",  "mode": "transcribe", "language_code": "unknown"}),
        ("saarika:v2",  {"model": "saarika:v2",  "language_code": "en-IN"}),
        ("saarika:v2.5",{"model": "saarika:v2.5","language_code": "en-IN"}),
    ]

    async with httpx.AsyncClient(timeout=20.0) as client:
        for name, data in models_to_test:
            print(f"--- {name} ---")
            r = await client.post(
                "https://api.sarvam.ai/speech-to-text",
                headers={"api-subscription-key": SARVAM_API_KEY},
                files={"file": ("audio.wav", wav, "audio/wav")},
                data=data,
            )
            print(f"Status: {r.status_code}")
            print(f"Body:   {r.text}\n")

asyncio.run(test())
