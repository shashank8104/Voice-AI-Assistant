"""Detailed ElevenLabs test — saves audio to file to confirm it works."""
import asyncio
import os
import httpx
from dotenv import load_dotenv

load_dotenv()

API_KEY = os.getenv("ELEVENLABS_API_KEY", "")
VOICE_ID = os.getenv("ELEVENLABS_VOICE_ID", "21m00Tcm4TlvDq8ikWAM")

print(f"API Key: {API_KEY[:12]}...")
print(f"Voice ID: {VOICE_ID}")

async def test():
    # Test 1: Non-streaming endpoint (simpler)
    print("\n=== Test 1: Non-streaming endpoint ===")
    url_nonstream = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}"
    headers = {"xi-api-key": API_KEY, "Content-Type": "application/json"}
    payload = {
        "text": "Hello, this is a test.",
        "model_id": "eleven_turbo_v2_5",
        "voice_settings": {"stability": 0.5, "similarity_boost": 0.75},
    }

    async with httpx.AsyncClient(timeout=30.0) as client:
        r = await client.post(url_nonstream, headers=headers, json=payload)
        print(f"Status: {r.status_code}")
        print(f"Content-Type: {r.headers.get('content-type', 'none')}")
        print(f"Content-Length: {r.headers.get('content-length', 'none')}")
        print(f"Body size: {len(r.content)} bytes")
        if len(r.content) > 0:
            with open("test_audio.mp3", "wb") as f:
                f.write(r.content)
            print("Saved to test_audio.mp3")
        else:
            print(f"Body text: {r.text[:500]}")

    # Test 2: Streaming endpoint
    print("\n=== Test 2: Streaming endpoint ===")
    url_stream = f"https://api.elevenlabs.io/v1/text-to-speech/{VOICE_ID}/stream"
    async with httpx.AsyncClient(timeout=30.0) as client:
        async with client.stream("POST", url_stream, headers=headers, json=payload) as r:
            print(f"Status: {r.status_code}")
            print(f"Content-Type: {r.headers.get('content-type', 'none')}")
            print(f"Transfer-Encoding: {r.headers.get('transfer-encoding', 'none')}")
            total = 0
            chunks = 0
            async for chunk in r.aiter_bytes(4096):
                total += len(chunk)
                chunks += 1
                print(f"  Chunk {chunks}: {len(chunk)} bytes")
            print(f"Total: {total} bytes in {chunks} chunks")

asyncio.run(test())
