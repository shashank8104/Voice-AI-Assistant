# 🎙️ Voice AI Assistant — Project Journey

> **From idea to live deployment** — a complete walkthrough of building a real-time streaming voice assistant with Sarvam STT, GPT-4o-mini, and ElevenLabs TTS.

---

## 📋 Table of Contents

1. [Project Overview](#1-project-overview)
2. [Architecture](#2-architecture)
3. [Phase 1 — STT Integration (Sarvam)](#3-phase-1--stt-integration-sarvam)
4. [Phase 2 — LLM Integration (GPT-4o-mini)](#4-phase-2--llm-integration-gpt-4o-mini)
5. [Phase 3 — TTS Integration (ElevenLabs)](#5-phase-3--tts-integration-elevenlabs)
6. [Phase 4 — Streaming Pipeline (Low Latency)](#6-phase-4--streaming-pipeline-low-latency)
7. [Phase 5 — Interruption Handling](#7-phase-5--interruption-handling)
8. [Phase 6 — Audio Playback Fixes](#8-phase-6--audio-playback-fixes)
9. [Phase 7 — Deployment on Render](#9-phase-7--deployment-on-render)
10. [Bugs & Fixes Log](#10-bugs--fixes-log)
11. [Environment Variables](#11-environment-variables)
12. [Key Design Decisions](#12-key-design-decisions)

---

## 1. Project Overview

A real-time **voice assistant** that:
- Listens to user speech via microphone
- Transcribes it using **Sarvam AI** (Indian English STT)
- Sends it to **GPT-4o-mini** for a response
- Speaks the reply back using **ElevenLabs** (Rachel voice)
- All in real-time with low perceived latency

**Stack:**
| Layer | Technology |
|---|---|
| Backend | FastAPI + Uvicorn (Python) |
| Transport | WebSockets |
| STT | Sarvam `saarika:v2.5` |
| LLM | OpenAI `gpt-4o-mini` |
| TTS | ElevenLabs `Rachel` |
| Frontend | Vanilla HTML + CSS + JavaScript |
| Deployment | Render (free tier) |

---

## 2. Architecture

```
Browser (Microphone)
    │
    │  PCM audio frames (binary WebSocket)
    ▼
FastAPI WebSocket Gateway
    │
    ├─► Session Manager (state machine, silence detection)
    │       States: IDLE → USER_SPEAKING → AI_PROCESSING → AI_SPEAKING → USER_SPEAKING
    │
    ├─► Sarvam STT  ──► transcript text
    │
    ├─► GPT-4o-mini (streaming tokens)
    │       │
    │       │  asyncio.Queue (sentence by sentence)
    │       ▼
    ├─► ElevenLabs TTS (streaming audio per sentence)
    │
    │  MP3 audio chunks (binary WebSocket)
    ▼
Browser (Speaker / AudioContext)
```

### State Machine
```
IDLE ──► USER_SPEAKING ──► AI_PROCESSING ──► AI_SPEAKING ──► USER_SPEAKING
                                │                  │
                                └──── interrupt ◄──┘
```

---

## 3. Phase 1 — STT Integration (Sarvam)

### What we built
- `backend/stt/sarvam_client.py` — sends PCM audio to Sarvam's `/speech-to-text` endpoint
- Model: `saarika:v2.5` with `language_code="en-IN"`

### Problems & Fixes

| Problem | Fix |
|---|---|
| Wrong model name caused transcription failure | Used `saarika:v2.5` exactly as specified in API docs |
| API key loaded at import time before `.env` was read | Changed to lazy loading (`os.getenv()` inside the function) |
| Silence detection too slow (900ms) | Tuned `SILENCE_TURN_END_MS` from 900ms → 700ms |
| Too little speech buffered before STT call | Tuned `MIN_VOICED_FRAMES` for robustness |

### Silence Detection
RMS (Root Mean Square) energy-based detection on each 20ms audio frame:
```python
SILENCE_THRESHOLD_RMS = 150   # below this = silence
SILENCE_TURN_END_MS   = 700   # 700ms of silence → end of turn
```

---

## 4. Phase 2 — LLM Integration (GPT-4o-mini)

### What we built
- `backend/llm/gpt_client.py` — streaming GPT responses via OpenAI async client

### Problems & Fixes

| Problem | Fix |
|---|---|
| `insufficient_quota` error | Switched to a valid API key with credits |
| Responses too long for voice | Switched to `gpt-4o-mini`, reduced `max_tokens=150` |
| Responses included markdown/bullet points | Updated system prompt to explicitly ban them |

### System Prompt
```
"You are a helpful voice assistant. Keep every response to 1-2 short sentences — 
you are speaking aloud, not writing. Never use bullet points, markdown, or lists. 
Be direct and natural."
```

### Model Config
```python
model="gpt-4o-mini",   # 2-3x faster than gpt-4o
max_tokens=150,         # Short responses = lower latency for voice
temperature=0.7,
```

---

## 5. Phase 3 — TTS Integration (ElevenLabs)

### What we built
- `backend/tts/elevenlabs_client.py` — streams ElevenLabs TTS audio

### Problems & Fixes

| Problem | Fix |
|---|---|
| ElevenLabs returned HTTP 200 with 0 audio bytes | Rewrote client to collect all LLM tokens first, then make one streaming request |
| Initial approach tried streaming tokens directly to ElevenLabs | Switched to per-sentence batching |

---

## 6. Phase 4 — Streaming Pipeline (Low Latency)

### The Breakthrough: Concurrent Sentence Streaming

Instead of waiting for the full GPT response and then synthesizing all of it:

**Before:** `GPT finishes → ElevenLabs starts → Audio plays` (~2-3s delay)

**After:** `GPT generates sentence 1 → ElevenLabs synthesizes sentence 1 (while GPT generates sentence 2) → Audio plays` (~0.8-1.5s saved)

### Implementation
```python
# asyncio.Queue connects LLM producer to TTS consumer
sentence_queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=8)

# LLM producer splits tokens into sentences, puts each in queue
async def llm_producer():
    buffer = ""
    async for token in stream_llm_response(messages):
        buffer += token
        sentences = split_sentences(buffer)
        for s in sentences:
            await sentence_queue.put(s)
    await sentence_queue.put(None)  # sentinel

# TTS consumer synthesizes each sentence as it arrives
async def tts_consumer():
    while True:
        sentence = await sentence_queue.get()
        if sentence is None:
            break
        async for chunk in stream_tts(sentence):
            await websocket.send_bytes(chunk)

# Run concurrently
llm_task = asyncio.create_task(llm_producer())
audio_bytes = await tts_consumer()
```

---

## 7. Phase 5 — Interruption Handling

### Three-layer approach

#### Layer 1: Backend State Detection
```python
# In websocket_gateway.py — checks every audio frame during AI response
if session.state in (State.AI_SPEAKING, State.AI_PROCESSING):
    rms = session.compute_rms(frame)
    if rms > 800:  # User is speaking loudly
        await session.cancel_ai_tasks()
        session.transition(State.USER_SPEAKING)
```

#### Layer 2: Frontend Audio Stop
```javascript
// In playback_engine.js — immediately stops all active AudioBufferSourceNodes
function stopAll() {
    for (const source of activeSources) {
        source.stop();
    }
    activeSources.clear();
}
```

#### Layer 3: Client-side Self-Interrupt (no server round-trip)
```javascript
// In websocket_client.js — local RMS check during AI_SPEAKING
if (currentUIState === 'AI_SPEAKING') {
    const rms = computeRMS(pcmFrame);
    if (rms > 800) {
        PlaybackEngine.stopAll();
        setUIState('USER_SPEAKING');
    }
}
```

### Key tuning: RMS threshold = 800
- Too low (500): background noise triggers false interrupts ❌
- Too high (1500+): user has to shout to interrupt ❌
- 800: comfortable speaking voice triggers it ✅

---

## 8. Phase 6 — Audio Playback Fixes

### Problem 1: Tiny chunk decode failure
Final MP3 chunks are often incomplete frames and always fail to decode.
```javascript
// Skip final chunks under 1KB — they're truncated MP3 frames
if (totalBytes >= 1024) {
    await tryDecodeAndPlay(true);
} else {
    console.log(`Skipping tiny final chunk (${totalBytes} bytes)`);
}
```

### Problem 2: First audio starts too late
```javascript
// Progressive decode every 6KB (was 8KB — smaller = sooner first audio)
if (totalBytes >= 6144) {
    await tryDecodeAndPlay();
}
```

---

## 9. Phase 7 — Deployment on Render

### Files added for deployment

**`render.yaml`**
```yaml
services:
  - type: web
    name: voice-ai-assistant
    runtime: python
    buildCommand: pip install -r requirements.txt
    startCommand: uvicorn backend.main:app --host 0.0.0.0 --port $PORT --ws-ping-interval 0
    envVars:
      - key: SARVAM_API_KEY
        sync: false
      - key: OPENAI_API_KEY
        sync: false
      - key: ELEVENLABS_API_KEY
        sync: false
      - key: ELEVENLABS_VOICE_ID
        value: 21m00Tcm4TlvDq8ikWAM
      - key: PYTHON_VERSION
        value: 3.11.9
    plan: free
```

**`runtime.txt`**
```
python-3.11.9
```

### WebSocket protocol fix
```javascript
// Auto-switch between ws:// (localhost) and wss:// (Render HTTPS)
const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
const WS_URL = `${WS_PROTOCOL}//${window.location.host}/ws`;
```

### WebSocket keepalive (Render drops idle connections after ~55s)
```python
async def websocket_keepalive(session: Session):
    """Send a ping every 25s to prevent Render proxy from closing the connection."""
    while True:
        await asyncio.sleep(25)
        try:
            await session.websocket.send_json({"type": "ping"})
        except Exception:
            break
```

---

## 10. Bugs & Fixes Log

| # | Bug | Root Cause | Fix |
|---|---|---|---|
| 1 | Sarvam returns no transcript | Wrong model name | Use `saarika:v2.5` exactly |
| 2 | API key not loaded | Loaded at import time before dotenv | Lazy load inside function |
| 3 | OpenAI `insufficient_quota` | Depleted API key | Use key with credits |
| 4 | ElevenLabs returns 0 bytes | Streaming tokens directly to ElevenLabs | Batch by sentence first |
| 5 | High perceived latency | Waiting for full GPT response before TTS | Concurrent sentence streaming |
| 6 | Audio not stopping on interrupt | AudioBufferSourceNode not tracked | Track all sources, call `.stop()` |
| 7 | False self-interrupts from noise | RMS threshold too low (500) | Raise to 800 on both frontend & backend |
| 8 | MP3 decode errors on final chunk | Incomplete last frame | Skip chunks < 1KB |
| 9 | ws:// blocked on HTTPS page | Hardcoded `ws://` protocol | Auto-detect `wss://` vs `ws://` |
| 10 | WebSocket dropped after 55s on Render | Render proxy idle timeout | Server-side ping every 25s |
| 11 | `APIConnectionError` on Render | Wrong env var name (`OPEN_API_KEY` instead of `OPENAI_API_KEY`) | Fix typo in Render dashboard |
| 12 | Python 3.14 on Render | Default Render Python version | Pin to 3.11.9 via `runtime.txt` |
| 13 | LLM cancelled by background noise | Backend interrupt threshold 500 | Raise to 800 |

---

## 11. Environment Variables

| Variable | Description | Example |
|---|---|---|
| `SARVAM_API_KEY` | Sarvam AI API key | `sk_1ucf...` |
| `OPENAI_API_KEY` | OpenAI API key (**NOT** `OPEN_API_KEY`) | `sk-proj-...` |
| `ELEVENLABS_API_KEY` | ElevenLabs API key | `sk_ee0f...` |
| `ELEVENLABS_VOICE_ID` | ElevenLabs voice (Rachel) | `21m00Tcm4TlvDq8ikWAM` |

> ⚠️ Never commit `.env` to Git. Always copy from `.env.example` and fill in real values.

---

## 12. Key Design Decisions

### Why Render over Vercel?
Vercel serverless functions don't support persistent WebSocket connections. Render runs a proper server process — essential for real-time audio streaming.

### Why sentence-by-sentence TTS?
LLM streaming gives us tokens, not sentences. Waiting for the full response adds 1-2 seconds of silence. Splitting on sentence boundaries (`. ! ?`) lets TTS start on sentence 1 while GPT is still writing sentence 2.

### Why RMS for silence/interrupt detection?
RMS (energy) is simple, low-CPU, and reliable for detecting voiced vs. silent audio frames. Complex VAD models add latency.

### Why `gpt-4o-mini` over `gpt-4o`?
2-3x faster token generation. For 1-2 sentence voice responses, quality difference is negligible. Latency matters more than depth.

### Why `--ws-ping-interval 0`?
Disables uvicorn's built-in WebSocket ping, which conflicted with Render's proxy and caused `ConnectionClosedError: keepalive ping timeout`. We handle keepalive manually via `websocket_keepalive()`.

---

## 🚀 Live URL

**https://voice-ai-assistant-6hr4.onrender.com**

> ⚠️ Free tier spins down after 15 min of inactivity. First request after sleep takes ~30-50s. Upgrade to Render Starter ($7/mo) for always-on.

---

*Built with ❤️ — Feb 2026*
