# Real-Time Streaming Voice Assistant

A full-duplex, low-latency voice assistant built with:
- **STT**: Sarvam `saarika:v2` (English + Hindi)
- **LLM**: GPT-4o (streaming)
- **TTS**: ElevenLabs `eleven_turbo_v2_5` (streaming)
- **Backend**: FastAPI + WebSockets
- **Frontend**: Web Audio API + Vanilla JS

---

## Setup

### 1. Create virtual environment

```bash
python -m venv .venv
.venv\Scripts\activate      # Windows
# source .venv/bin/activate  # macOS/Linux
```

### 2. Install dependencies

```bash
pip install -r requirements.txt
```

### 3. Configure API keys

```bash
copy .env.example .env
```

Edit `.env` and fill in:
- `SARVAM_API_KEY`
- `OPENAI_API_KEY`
- `ELEVENLABS_API_KEY`

### 4. Run the server

```bash
python -m uvicorn backend.main:app --reload --port 8000
```

### 5. Open the app

Navigate to: [http://localhost:8000](http://localhost:8000)

---

## Usage

1. Click **Start Session** — grant microphone access
2. Speak naturally in English or Hindi
3. After ~900ms silence, the AI processes and responds
4. **Interrupt** the AI at any time by speaking
5. Click **End Session** to stop

---

## Architecture

```
Browser Mic (20ms PCM frames)
    ↓
WebSocket (Binary Audio)
    ↓
Silence Detector (900ms threshold)
    ↓
Sarvam Streaming STT
    ↓
GPT-4o Streaming Tokens
    ↓
ElevenLabs Streaming TTS
    ↓
WebSocket (Audio chunks back)
    ↓
Browser Playback (~200ms buffer)
```

---

## Project Structure

```
backend/
    main.py                  # FastAPI app
    websocket_gateway.py     # Core pipeline orchestrator
    session_manager.py       # Per-session state & silence detection
    state_machine.py         # IDLE/USER_SPEAKING/AI_PROCESSING/AI_SPEAKING
    stt/sarvam_client.py     # Sarvam STT
    llm/gpt_client.py        # GPT-4o streaming
    tts/elevenlabs_client.py # ElevenLabs streaming TTS

frontend/
    index.html               # UI with animated orb + status
    audio_capture.js         # Mic → 20ms PCM frames
    websocket_client.js      # WS connection + UI state
    playback_engine.js       # Audio buffering + playback
```
