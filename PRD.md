# **Real-Time Streaming Voice Assistant**

# **1\. Product Vision**

Design and build a complete real-time conversational voice assistant operating entirely through low-latency streaming pipelines.

The system must:

* Capture real-time microphone input from browser  
* Perform streaming Speech-to-Text (STT)  
* Generate streaming LLM responses  
* Convert text to streaming speech output  
* Support interruption and deterministic turn-taking  
* Maintain session-scoped memory  
* Achieve \<800–1000ms perceived latency

This is a systems engineering and streaming orchestration problem — not a UI exercise.

---

# **2\. Final Technology Stack**

| Layer | Technology | Rationale |
| ----- | ----- | ----- |
| Audio Transport | WebSockets | Full-duplex real-time streaming |
| STT | Sarvam Streaming API | India-optimized speech recognition |
| LLM | GPT-4o (Streaming) | Frontier conversational intelligence |
| TTS | ElevenLabs (Streaming) | Premium natural voice synthesis |
| Backend | FastAPI (Async) | Non-blocking orchestration |
| Frontend | Web Audio API \+ JS | Low-level audio control |

---

# **3\. High-Level Architecture**

## **3.1 Streaming Pipeline**

Browser Mic (20ms PCM frames)  
        ↓  
WebSocket (Binary Audio)  
        ↓  
Backend Session Manager  
        ↓  
Sarvam Streaming STT  
        ↓  
GPT-4o Streaming Tokens  
        ↓  
ElevenLabs Streaming Audio  
        ↓  
WebSocket (Audio Stream Back)  
        ↓  
Browser Playback (\~200ms buffer)

All components operate incrementally.

No stage waits for complete output from the previous stage.

---

# **4\. Core Functional Requirements**

## **4.1 Real-Time Audio Capture**

* Capture 20ms PCM frames via Web Audio API  
* Stream binary audio over WebSocket  
* Maintain continuous streaming during session

---

## **4.2 Streaming STT (Sarvam)**

Responsibilities:

* Buffer 20ms frames appropriately  
* Send audio to Sarvam streaming endpoint  
* Receive partial and final transcripts  
* Emit finalized transcript after silence threshold met

Failure Handling:

* One silent retry  
* If failure persists → verbal fallback message  
* Session remains active

---

## **4.3 Streaming LLM (GPT-4o)**

Responsibilities:

* Append finalized transcript to session memory  
* Send conversation context to GPT-4o  
* Stream tokens incrementally  
* Immediately forward tokens to TTS  
* Support cancellation mid-generation

Constraints:

* Non-blocking async usage  
* Per-session isolation  
* Idempotent cancellation

---

## **4.4 Streaming TTS (ElevenLabs)**

Responsibilities:

* Accept streaming text tokens  
* Generate audio chunks incrementally  
* Stream audio immediately to frontend  
* Support interruption handling

Constraints:

* No full-response batching  
* Must start playback early  
* Gracefully stop mid-speech

---

# **5\. Turn-Taking Strategy**

## **5.1 Silence Detection**

* Process 20ms frames  
* Maintain rolling silence accumulator  
* End turn after ≥ 900ms silence

Triggers:

* Final transcript emission  
* LLM generation

---

## **5.2 Session Timeout**

If no speech occurs for:

* 60 seconds

System immediately:

* Cancels tasks  
* Clears memory  
* Closes connection  
* Returns to IDLE

---

# **6\. Session Model**

## **6.1 Lifecycle**

Session starts:

* On user click

Session ends:

* Manual termination  
* 60s inactivity  
* WebSocket disconnect

Cleanup:

* Cancel STT stream  
* Cancel GPT generation  
* Cancel TTS stream  
* Clear memory  
* Release buffers

---

## **6.2 Memory Scope**

* Multi-turn memory within session  
* No persistence beyond session  
* Format:

\[  
  { role: "user", content: "..." },  
  { role: "assistant", content: "..." }  
\]

Interrupted responses are not stored.

---

# **7\. State Machine**

## **7.1 States**

* IDLE  
* USER\_SPEAKING  
* AI\_PROCESSING  
* AI\_SPEAKING

---

## **7.2 Transitions**

| From | To | Trigger |
| ----- | ----- | ----- |
| IDLE | USER\_SPEAKING | Session start |
| USER\_SPEAKING | AI\_PROCESSING | 900ms silence |
| AI\_PROCESSING | AI\_SPEAKING | First LLM tokens |
| AI\_SPEAKING | USER\_SPEAKING | User interruption |
| ANY | IDLE | Session termination |

---

# **8\. Interruption Handling**

If user speaks while AI is speaking:

System must immediately:

1. Stop browser playback  
2. Cancel ElevenLabs stream  
3. Cancel GPT stream  
4. Transition to USER\_SPEAKING  
5. Begin new speech processing

Cancellation must be:

* Idempotent  
* Async-safe  
* Free of race conditions

---

# **9\. Latency Strategy**

## **9.1 Target**

Perceived response latency:

**\<1000ms after user stops speaking**

---

## **9.2 Latency Components**

| Stage | Estimated Delay |
| ----- | ----- |
| Sarvam partial transcript | 150–300ms |
| Silence detection | 900ms |
| GPT-4o first token | 100–250ms |
| ElevenLabs first audio chunk | 200–400ms |
| Playback buffer | 200ms |

Pipeline overlap reduces effective delay.

---

# **10\. Concurrency Model**

* Single backend instance  
* Multiple concurrent WebSocket sessions  
* No shared mutable global state  
* Resource degradation acceptable under heavy load  
* No artificial session caps

---

# **11\. Repository Structure**

backend/  
    main.py  
    websocket\_gateway.py  
    session\_manager.py  
    state\_machine.py  
    stt/  
        sarvam\_client.py  
    llm/  
        gpt\_client.py  
    tts/  
        elevenlabs\_client.py

frontend/  
    index.html  
    audio\_capture.js  
    websocket\_client.js  
    playback\_engine.js

requirements.txt  
README.md

---

# **12\. Non-Goals (v1)**

* No RAG  
* No authentication  
* No observability dashboard  
* No horizontal scaling  
* No persistent storage  
* No mobile optimization

---

# **13\. Known Trade-Offs**

| Decision | Trade-Off |
| ----- | ----- |
| All-cloud stack | Network dependency |
| GPT-4o | Higher cost |
| ElevenLabs | Paid voice API |
| No observability layer | Limited production metrics |

These trade-offs are acceptable for v1 scope.

---

# **14\. Definition of Done**

The system is complete when:

* Sarvam streaming STT works reliably  
* GPT-4o tokens stream correctly  
* ElevenLabs audio streams incrementally  
* Interruption works instantly  
* 900ms silence detection works  
* 60s inactivity timeout works  
* Multi-session isolation is stable  
* No unhandled async exceptions  
* Conversation feels natural

---

# **Final Confirmed Stack**

STT → Sarvam (Streaming API)  
LLM → GPT-4o (Streaming)  
TTS → ElevenLabs (Streaming)

This system demonstrates:

* Real-time streaming architecture  
* Deterministic state management  
* Clean cancellation propagation  
* India-aligned speech input  
* Frontier-level conversational intelligence  
* Premium voice output

---

# **🏗 OVERALL BUILD STRATEGY**

You do **not** build feature by feature.

You build **pipeline layer by layer**, verifying streaming at each stage.

---

# **🧱 PHASE 0 — Environment Setup**

### **1️⃣ Backend Setup**

* Python 3.10+  
* FastAPI  
* Uvicorn  
* WebSockets support  
* httpx / aiohttp (for async API calls)

Install:

pip install fastapi uvicorn httpx websockets python-dotenv

---

### **2️⃣ API Access**

Prepare:

* Sarvam API key  
* OpenAI API key (GPT-4o)  
* ElevenLabs API key

Store in `.env`.

---

# **🧱 PHASE 1 — WebSocket Infrastructure (Foundation)**

### **Goal:**

Just stream audio from browser → backend.

No AI yet.

---

### **Backend:**

* Create `/ws` WebSocket endpoint  
* Accept binary PCM frames  
* Print received frame size  
* Handle disconnect cleanly

---

### **Frontend:**

* Capture mic via Web Audio API  
* Convert to PCM  
* Send 20ms frames over WebSocket

Test:

* Confirm backend receives continuous audio frames  
* No buffering issues  
* No blocking

Once this works, move on.

---

# **🧱 PHASE 2 — Silence Detection (Turn Logic)**

Before adding STT, implement:

### **1️⃣ Frame Buffering**

* Collect 20ms frames  
* Maintain rolling silence counter

### **2️⃣ Silence Threshold**

If silence ≥ 900ms:

* Emit TURN\_END event

For now:

* Just log `"TURN ENDED"`

Test interruption scenarios.

This gives you deterministic turn control before AI integration.

---

# **🧱 PHASE 3 — Integrate Sarvam Streaming STT**

Now connect audio to Sarvam.

---

### **Backend Flow:**

WebSocket Audio  
    ↓  
Buffer frames (\~100–200ms)  
    ↓  
Send to Sarvam streaming endpoint  
    ↓  
Receive partial transcripts  
    ↓  
Store partial transcript

---

### **Important:**

* Do NOT wait for full transcript.  
* Use 900ms silence to treat transcript as final.  
* Reset transcript after turn.

Test:

* Speak sentence  
* Silence  
* Confirm transcript logged

Only move forward once this is stable.

---

# **🧱 PHASE 4 — Integrate GPT-4o Streaming**

Now after TURN\_END:

Final Transcript  
    ↓  
Append to session memory  
    ↓  
Send to GPT-4o (streaming)  
    ↓  
Receive tokens incrementally

Important:

* Use streaming API  
* Print tokens as they arrive  
* Do NOT wait for full response

Test:

* Confirm tokens appear progressively  
* Confirm cancellation possible

---

# **🧱 PHASE 5 — Integrate ElevenLabs Streaming TTS**

Now:

LLM token  
    ↓  
Send token to ElevenLabs streaming TTS  
    ↓  
Receive audio chunks  
    ↓  
Stream back via WebSocket

Frontend:

* Receive binary audio  
* Buffer \~200ms  
* Start playback

Test:

* Hear audio while GPT is still generating  
* Ensure no waiting for full text

---

# **🧱 PHASE 6 — Interruption Handling (Critical)**

Now wire cancellation.

When user speaks during AI\_SPEAKING:

You must:

1. Stop frontend playback  
2. Cancel ElevenLabs stream  
3. Cancel GPT stream  
4. Reset state → USER\_SPEAKING

Test:

* Interrupt mid-sentence  
* Ensure no ghost audio  
* Ensure no dangling async tasks

This phase is the hardest.

---

# **🧱 PHASE 7 — Session Timeout**

Implement:

* Track last speech timestamp  
* If \>60s inactivity:  
  * Cancel all tasks  
  * Close socket  
  * Clear memory

Test edge cases.

---

# **🧱 PHASE 8 — Multi-Session Isolation**

Ensure:

* Each WebSocket has its own session object  
* No shared mutable global state  
* Tasks stored per session

Test:

* Open 2 browser tabs  
* Speak in both  
* Ensure no cross-talk

---

# **🧱 PHASE 9 — Stability Testing**

Test aggressively:

* Rapid interruption  
* Long pauses  
* Long responses  
* Network blips  
* Closing browser mid-speech

Fix:

* Hanging tasks  
* Unawaited coroutines  
* Memory leaks

---

# **🎯 FINAL PIPELINE SUMMARY**

Here is your final real-time orchestration:

Mic (20ms frames)  
    ↓  
WebSocket  
    ↓  
Frame Buffer \+ Silence Detector  
    ↓  
Sarvam Streaming STT  
    ↓  
Final Transcript (after 900ms silence)  
    ↓  
GPT-4o Streaming  
    ↓  
ElevenLabs Streaming TTS  
    ↓  
WebSocket  
    ↓  
Browser Playback (200ms buffer)

With interruption logic layered across:

* STT  
* LLM  
* TTS  
* Playback

---

# **🔥 Recommended Build Order (Short Version)**

1. WebSocket streaming  
2. Silence detection  
3. Sarvam STT  
4. GPT-4o streaming  
5. ElevenLabs streaming  
6. Cancellation logic  
7. Timeout logic  
8. Multi-session test

