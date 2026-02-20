"""
WebSocket Gateway
Core orchestrator: routes audio frames through the full pipeline.
STT → LLM+TTS concurrent sentence streaming → playback.
Optimized for low latency: TTS starts on first sentence while GPT generates the rest.
"""
import asyncio
import logging
import time
import uuid
from typing import Dict

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from backend.session_manager import Session
from backend.state_machine import State
from backend.stt.sarvam_client import transcribe_with_retry
from backend.llm.gpt_client import stream_llm_response
from backend.tts.elevenlabs_client import stream_tts

logger = logging.getLogger(__name__)

router = APIRouter()

# Active sessions: session_id → Session
active_sessions: Dict[str, Session] = {}


# ── Helpers ────────────────────────────────────────────────────────────────────

async def send_status(session: Session, status, extra: dict = None):
    msg = {"type": "status", "state": str(status)}
    if extra:
        msg.update(extra)
    try:
        await session.websocket.send_json(msg)
    except Exception:
        pass


async def send_transcript(session: Session, text: str):
    try:
        await session.websocket.send_json({"type": "transcript", "text": text})
    except Exception:
        pass


async def send_error(session: Session, message: str):
    try:
        await session.websocket.send_json({"type": "error", "message": message})
    except Exception:
        pass


def _split_sentences(buffer: str) -> tuple[list[str], str]:
    """
    Extract complete sentences from buffer.
    Returns (list_of_sentences, remaining_buffer).
    Splits on . ! ? : ; and newlines.
    """
    sentences = []
    separators = {".", "!", "?", ":", ";"}

    while True:
        # Find earliest separator
        best_i = -1
        for i, ch in enumerate(buffer):
            if ch in separators:
                best_i = i
                break
            if ch == "\n":
                best_i = i
                break

        if best_i == -1:
            break  # No separator found — keep buffering

        # Include trailing space
        end = best_i + 1
        if end < len(buffer) and buffer[end] == " ":
            end += 1

        sentence = buffer[:end].strip()
        buffer = buffer[end:]

        if len(sentence) >= 4:  # Skip trivially short fragments
            sentences.append(sentence)

    return sentences, buffer


async def _single_gen(text: str):
    """Yield a single text string as an async generator."""
    yield text


# ── Main pipeline ──────────────────────────────────────────────────────────────

async def run_ai_pipeline(session: Session):
    """
    Low-latency streaming pipeline:
      1. STT (Sarvam)
      2. LLM producer: GPT-4o streams tokens → sentence splitter → sentence queue
      3. TTS consumer: pulls sentences from queue → ElevenLabs → audio bytes → browser
    Steps 2 & 3 run CONCURRENTLY so TTS starts on sentence 1 while GPT generates sentence 2.
    """
    t_start = time.time()
    audio_snapshot = bytes(session.audio_buffer)
    session.reset_turn()

    # ── STT ───────────────────────────────────────────────────────────────────
    await send_status(session, State.AI_PROCESSING, {"stage": "transcribing"})
    transcript = await transcribe_with_retry(audio_snapshot)

    if not transcript:
        logger.warning(f"[Session {session.session_id}] STT empty")
        await send_error(session, "Sorry, I didn't catch that. Could you repeat?")
        session.transition(State.USER_SPEAKING)
        await send_status(session, State.USER_SPEAKING)
        return

    t_stt = time.time()
    logger.info(f"[Session {session.session_id}] STT: '{transcript}' ({t_stt - t_start:.2f}s)")
    await send_transcript(session, transcript)
    session.add_user_message(transcript)

    # ── LLM + TTS concurrent ──────────────────────────────────────────────────
    await send_status(session, State.AI_PROCESSING, {"stage": "thinking"})

    messages = session.get_messages()
    sentence_queue: asyncio.Queue[str | None] = asyncio.Queue(maxsize=8)
    full_response = ""
    first_token_time = None

    # ── LLM producer ──────────────────────────────────────────────────────────
    async def llm_producer():
        nonlocal full_response, first_token_time
        buffer = ""
        try:
            async for token in stream_llm_response(messages):
                await asyncio.sleep(0)
                if first_token_time is None:
                    first_token_time = time.time()
                    logger.info(f"[Session {session.session_id}] First LLM token in {first_token_time - t_stt:.2f}s")
                full_response += token
                buffer += token

                # Split and enqueue complete sentences
                sentences, buffer = _split_sentences(buffer)
                for s in sentences:
                    await sentence_queue.put(s)

        except asyncio.CancelledError:
            logger.info(f"[Session {session.session_id}] LLM producer cancelled")
            raise
        except Exception as e:
            logger.error(f"[Session {session.session_id}] LLM error: {type(e).__name__}: {e}")
        finally:
            # Flush remaining buffer
            if buffer.strip():
                await sentence_queue.put(buffer.strip())
            await sentence_queue.put(None)  # End sentinel

    # ── TTS consumer ──────────────────────────────────────────────────────────
    async def tts_consumer() -> int:
        audio_bytes_sent = 0
        first_sentence = True

        while True:
            sentence = await sentence_queue.get()
            if sentence is None:
                break

            logger.info(f"[Session {session.session_id}] TTS: '{sentence[:60]}'")

            # On first sentence: transition state and open audio stream
            if first_sentence:
                first_sentence = False
                t_first = time.time()
                logger.info(f"[Session {session.session_id}] First TTS sentence in {t_first - t_start:.2f}s (total latency)")
                session.transition(State.AI_SPEAKING)
                await send_status(session, State.AI_SPEAKING)
                await session.websocket.send_json({"type": "audio_start"})

            try:
                async for chunk in stream_tts(_single_gen(sentence)):
                    await asyncio.sleep(0)
                    await session.websocket.send_bytes(chunk)
                    audio_bytes_sent += len(chunk)
            except asyncio.CancelledError:
                raise
            except Exception as e:
                logger.error(f"[Session {session.session_id}] TTS chunk error: {e}")

        return audio_bytes_sent

    # Run LLM producer concurrently with TTS consumer
    llm_task = asyncio.create_task(llm_producer())
    session.llm_task = llm_task

    audio_bytes_sent = 0
    try:
        audio_bytes_sent = await tts_consumer()
    except asyncio.CancelledError:
        logger.info(f"[Session {session.session_id}] Pipeline cancelled")
        llm_task.cancel()
        raise
    except Exception as e:
        logger.error(f"[Session {session.session_id}] Pipeline error: {e}", exc_info=True)
    finally:
        # Ensure LLM task finishes and audio_end is always sent
        try:
            await asyncio.wait_for(asyncio.shield(llm_task), timeout=1.0)
        except Exception:
            llm_task.cancel()

        await session.websocket.send_json({
            "type": "audio_end",
            "audio_bytes_sent": audio_bytes_sent,
        })

    t_end = time.time()
    logger.info(
        f"[Session {session.session_id}] Turn done: {audio_bytes_sent} bytes | "
        f"'{full_response[:60]}' | total={t_end - t_start:.2f}s"
    )

    # Send text to frontend (transcript + browser TTS fallback)
    if full_response:
        session.add_assistant_message(full_response)
        await session.websocket.send_json({
            "type": "tts_text",
            "text": full_response,
            "has_audio": audio_bytes_sent > 0,
        })

    session.transition(State.USER_SPEAKING)
    await send_status(session, State.USER_SPEAKING)


# ── Timeout watcher ────────────────────────────────────────────────────────────

async def session_timeout_watcher(session: Session):
    """Close session after 60s of inactivity."""
    while True:
        await asyncio.sleep(5)
        idle_time = time.time() - session.last_speech_time
        if idle_time > 60:
            logger.info(f"[Session {session.session_id}] Timeout after {idle_time:.0f}s")
            await send_status(session, "TIMEOUT")
            await session.cleanup()
            try:
                await session.websocket.close(code=1000, reason="Session timeout")
            except Exception:
                pass
            break


# ── WebSocket endpoint ─────────────────────────────────────────────────────────

@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket):
    await websocket.accept()

    session_id = str(uuid.uuid4())[:8]
    session = Session(session_id, websocket)
    active_sessions[session_id] = session

    logger.info(f"[Session {session_id}] Connected. Total: {len(active_sessions)}")

    session.timeout_task = asyncio.create_task(session_timeout_watcher(session))
    session.transition(State.USER_SPEAKING)
    await send_status(session, State.USER_SPEAKING)

    try:
        async for message in websocket.iter_bytes():
            if isinstance(message, bytes):
                frame = message

                # ── Interruption: user speaks during AI response ───────────
                if session.state in (State.AI_SPEAKING, State.AI_PROCESSING):
                    rms = session.compute_rms(frame)
                    if rms > 800:  # 800 = consistent with frontend, avoids false triggers
                        logger.info(f"[Session {session_id}] INTERRUPT (state={session.state}, RMS={rms:.0f})")
                        await session.cancel_ai_tasks()
                        session.transition(State.USER_SPEAKING)
                        await send_status(session, State.USER_SPEAKING)
                        await session.websocket.send_json({"type": "interrupt"})
                        session.reset_turn()

                # ── Normal audio processing ────────────────────────────────
                if session.state == State.USER_SPEAKING:
                    turn_ended = session.process_frame(frame)
                    if turn_ended:
                        session.transition(State.AI_PROCESSING)
                        pipeline_task = asyncio.create_task(run_ai_pipeline(session))
                        session.llm_task = pipeline_task

    except WebSocketDisconnect:
        logger.info(f"[Session {session_id}] Disconnected")
    except Exception as e:
        logger.error(f"[Session {session_id}] Error: {e}", exc_info=True)
    finally:
        await session.cleanup()
        active_sessions.pop(session_id, None)
        logger.info(f"[Session {session_id}] Removed. Remaining: {len(active_sessions)}")
