"""
Session Manager
Manages per-connection state: memory, tasks, silence detection, timeout.
"""
import asyncio
import time
import struct
import math
import logging
from typing import Optional

from backend.state_machine import StateMachine, State

logger = logging.getLogger(__name__)

# Audio config
SAMPLE_RATE = 16000          # 16kHz
FRAME_MS = 20                # 20ms per frame
FRAME_SAMPLES = int(SAMPLE_RATE * FRAME_MS / 1000)  # 320 samples
FRAME_BYTES = FRAME_SAMPLES * 2                       # 640 bytes (Int16)

# Silence detection
SILENCE_THRESHOLD_RMS = 500  # RMS energy below this = silent frame
SILENCE_TURN_END_MS = 700    # ms of silence to trigger TURN_END (reduced from 900 for speed)
SILENCE_FRAMES_NEEDED = SILENCE_TURN_END_MS // FRAME_MS  # 35 frames
MIN_VOICED_FRAMES = 400 // FRAME_MS  # Require at least 400ms of speech before triggering

# Session timeout
SESSION_TIMEOUT_S = 60


class Session:
    def __init__(self, session_id: str, websocket):
        self.session_id = session_id
        self.websocket = websocket
        self.state_machine = StateMachine(session_id)

        # Conversation memory
        self.memory: list[dict] = []

        # Audio buffering
        self.audio_buffer: bytearray = bytearray()
        self.silence_frame_count: int = 0
        self.voiced_frame_count: int = 0

        # Async tasks
        self.stt_task: Optional[asyncio.Task] = None
        self.llm_task: Optional[asyncio.Task] = None
        self.tts_task: Optional[asyncio.Task] = None
        self.timeout_task: Optional[asyncio.Task] = None

        # Timing
        self.last_speech_time: float = time.time()
        self.created_at: float = time.time()

        # Partial transcript accumulator
        self.partial_transcript: str = ""
        self.final_transcript: str = ""

        logger.info(f"[Session {session_id}] Created")

    # ── State helpers ──────────────────────────────────────────────────────

    @property
    def state(self) -> State:
        return self.state_machine.state

    def transition(self, new_state: State) -> bool:
        return self.state_machine.transition(new_state)

    # ── Audio / Silence detection ──────────────────────────────────────────

    def compute_rms(self, pcm_bytes: bytes) -> float:
        """Compute RMS energy of a PCM Int16 frame."""
        num_samples = len(pcm_bytes) // 2
        if num_samples == 0:
            return 0.0
        samples = struct.unpack(f"<{num_samples}h", pcm_bytes[:num_samples * 2])
        rms = math.sqrt(sum(s * s for s in samples) / num_samples)
        return rms

    def process_frame(self, frame: bytes) -> bool:
        """
        Process one 20ms PCM frame.
        Returns True if TURN_END should be triggered.
        """
        rms = self.compute_rms(frame)
        is_silent = rms < SILENCE_THRESHOLD_RMS

        # Log RMS every 50 frames (~1s) to help debug mic levels
        total_frames = self.silence_frame_count + self.voiced_frame_count
        if total_frames % 50 == 0:
            logger.debug(f"[Session {self.session_id}] RMS={rms:.0f} silent={is_silent} voiced={self.voiced_frame_count} silence_run={self.silence_frame_count}")

        if not is_silent:
            self.last_speech_time = time.time()
            self.silence_frame_count = 0
            self.voiced_frame_count += 1
            self.audio_buffer.extend(frame)
        else:
            self.silence_frame_count += 1
            # Still buffer during silence (for STT context)
            self.audio_buffer.extend(frame)

        # Trigger TURN_END only if we had enough voiced frames
        if (
            self.silence_frame_count >= SILENCE_FRAMES_NEEDED
            and self.voiced_frame_count >= MIN_VOICED_FRAMES
            and self.state == State.USER_SPEAKING
        ):
            logger.info(
                f"[Session {self.session_id}] TURN ENDED "
                f"(silence={self.silence_frame_count * FRAME_MS}ms, "
                f"voiced={self.voiced_frame_count * FRAME_MS}ms, "
                f"audio_buffer={len(self.audio_buffer)} bytes)"
            )
            return True

        return False

    def reset_turn(self):
        """Reset buffers after a turn completes."""
        self.audio_buffer = bytearray()
        self.silence_frame_count = 0
        self.voiced_frame_count = 0
        self.partial_transcript = ""
        self.final_transcript = ""

    # ── Memory ─────────────────────────────────────────────────────────────

    def add_user_message(self, text: str):
        self.memory.append({"role": "user", "content": text})
        logger.info(f"[Session {self.session_id}] User: {text}")

    def add_assistant_message(self, text: str):
        self.memory.append({"role": "assistant", "content": text})
        logger.info(f"[Session {self.session_id}] Assistant: {text[:80]}...")

    def get_messages(self) -> list[dict]:
        system = {
            "role": "system",
            "content": (
                "You are a helpful voice assistant. "
                "Keep every response to 1-2 short sentences — you are speaking aloud, not writing. "
                "Never use bullet points, markdown, or lists. Be direct and natural."
            ),
        }
        return [system] + self.memory

    # ── Task cancellation ──────────────────────────────────────────────────

    async def cancel_ai_tasks(self):
        """Cancel LLM and TTS tasks (used on interruption)."""
        for task_name, task in [
            ("LLM", self.llm_task),
            ("TTS", self.tts_task),
        ]:
            if task and not task.done():
                task.cancel()
                try:
                    await asyncio.wait_for(asyncio.shield(task), timeout=1.0)
                except (asyncio.CancelledError, asyncio.TimeoutError):
                    pass
                logger.info(f"[Session {self.session_id}] Cancelled {task_name} task")

        self.llm_task = None
        self.tts_task = None

    async def cleanup(self):
        """Full session cleanup — cancel all tasks, clear memory."""
        logger.info(f"[Session {self.session_id}] Cleaning up...")

        await self.cancel_ai_tasks()

        if self.stt_task and not self.stt_task.done():
            self.stt_task.cancel()
            try:
                await asyncio.wait_for(asyncio.shield(self.stt_task), timeout=1.0)
            except (asyncio.CancelledError, asyncio.TimeoutError):
                pass

        if self.timeout_task and not self.timeout_task.done():
            self.timeout_task.cancel()

        self.memory.clear()
        self.audio_buffer = bytearray()
        self.state_machine.force_idle()
        logger.info(f"[Session {self.session_id}] Cleanup complete")
