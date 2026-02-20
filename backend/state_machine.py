"""
State Machine for Voice Assistant Session
States: IDLE, USER_SPEAKING, AI_PROCESSING, AI_SPEAKING
"""
from enum import Enum
import logging

logger = logging.getLogger(__name__)


class State(str, Enum):
    IDLE = "IDLE"
    USER_SPEAKING = "USER_SPEAKING"
    AI_PROCESSING = "AI_PROCESSING"
    AI_SPEAKING = "AI_SPEAKING"


# Valid state transitions
VALID_TRANSITIONS = {
    State.IDLE: {State.USER_SPEAKING},
    State.USER_SPEAKING: {State.AI_PROCESSING, State.IDLE},
    State.AI_PROCESSING: {State.AI_SPEAKING, State.USER_SPEAKING, State.IDLE},
    State.AI_SPEAKING: {State.USER_SPEAKING, State.IDLE},
}


class StateMachine:
    def __init__(self, session_id: str):
        self.session_id = session_id
        self._state = State.IDLE

    @property
    def state(self) -> State:
        return self._state

    def transition(self, new_state: State) -> bool:
        """
        Attempt a state transition. Returns True if successful.
        """
        if new_state in VALID_TRANSITIONS.get(self._state, set()):
            logger.info(
                f"[Session {self.session_id}] State: {self._state} → {new_state}"
            )
            self._state = new_state
            return True
        else:
            logger.warning(
                f"[Session {self.session_id}] Invalid transition: {self._state} → {new_state}"
            )
            return False

    def force_idle(self):
        """Force reset to IDLE (used during cleanup)."""
        logger.info(f"[Session {self.session_id}] Force reset → IDLE")
        self._state = State.IDLE

    def is_state(self, state: State) -> bool:
        return self._state == state
