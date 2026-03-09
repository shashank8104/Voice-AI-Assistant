/**
 * WebSocket Client
 * Manages the WebSocket connection, sends audio frames,
 * receives audio/status messages, and updates the UI.
 * Also handles the text chat panel: sending chat_message JSON
 * and rendering user/assistant bubbles.
 */

const VoiceClient = (() => {
    const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const WS_URL = `${WS_PROTOCOL}//${window.location.host}/ws`;

    let ws = null;
    let isSessionActive = false;
    let currentUIState = 'IDLE';

    // ── Voice UI elements ────────────────────────────────────────────────────
    const orb          = document.getElementById('orb');
    const waves        = document.getElementById('waves');
    const statusBadge  = document.getElementById('statusBadge');
    const statusText   = document.getElementById('statusText');
    const btnStart     = document.getElementById('btnStart');
    const btnStop      = document.getElementById('btnStop');
    const connDot      = document.getElementById('connDot');
    const connLabel    = document.getElementById('connLabel');
    const errorToast   = document.getElementById('errorToast');
    const iconMic      = document.getElementById('iconMic');
    const iconThink    = document.getElementById('iconThink');
    const iconSpeak    = document.getElementById('iconSpeak');

    // ── Chat UI elements ─────────────────────────────────────────────────────
    const chatPanel    = document.getElementById('chatPanel');
    const chatMessages = document.getElementById('chatMessages');
    const chatEmpty    = document.getElementById('chatEmpty');
    const chatInput    = document.getElementById('chatInput');
    const chatSendBtn  = document.getElementById('chatSendBtn');

    let errorToastTimer = null;
    let typingIndicator = null;  // Animated dots shown while assistant is thinking/speaking

    // ── Voice UI helpers ─────────────────────────────────────────────────────

    function setConnected(connected) {
        connDot.className = 'conn-dot ' + (connected ? 'connected' : 'disconnected');
        connLabel.textContent = connected ? 'Connected' : 'Disconnected';
    }

    function setUIState(state) {
        currentUIState = state;
        orb.className = 'orb';
        statusBadge.className = 'status-badge';
        waves.className = 'waves';
        iconMic.style.display = 'none';
        iconThink.style.display = 'none';
        iconSpeak.style.display = 'none';

        switch (state) {
            case 'IDLE':
                statusText.textContent = 'Click Start to begin';
                iconMic.style.display = 'block';
                statusBadge.classList.add('idle');
                break;
            case 'USER_SPEAKING':
                orb.classList.add('listening');
                statusBadge.classList.add('listening');
                statusText.textContent = 'Listening...';
                iconMic.style.display = 'block';
                removeTypingIndicator();
                break;
            case 'AI_PROCESSING':
                orb.classList.add('thinking');
                statusBadge.classList.add('thinking');
                statusText.textContent = 'Thinking...';
                iconThink.style.display = 'block';
                showTypingIndicator();
                break;
            case 'AI_SPEAKING':
                orb.classList.add('speaking');
                statusBadge.classList.add('speaking');
                statusText.textContent = 'Speaking...';
                waves.classList.add('active');
                iconSpeak.style.display = 'block';
                break;
            case 'TIMEOUT':
                statusText.textContent = 'Session timed out';
                iconMic.style.display = 'block';
                statusBadge.classList.add('idle');
                removeTypingIndicator();
                break;
        }
    }

    function showError(message) {
        errorToast.textContent = message;
        errorToast.classList.add('show');
        if (errorToastTimer) clearTimeout(errorToastTimer);
        errorToastTimer = setTimeout(() => errorToast.classList.remove('show'), 4000);
    }

    /** Compute RMS energy from Int16 PCM ArrayBuffer. */
    function computeRMS(arrayBuffer) {
        const samples = new Int16Array(arrayBuffer);
        if (samples.length === 0) return 0;
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        return Math.sqrt(sum / samples.length);
    }

    // ── Chat helpers ─────────────────────────────────────────────────────────

    function setChatEnabled(enabled) {
        chatPanel.classList.toggle('disabled', !enabled);
        chatInput.disabled = !enabled;
        chatSendBtn.disabled = !enabled;
        if (enabled) chatInput.focus();
    }

    function escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /** Add a bubble to the chat panel. role = 'user' | 'assistant' */
    function addChatBubble(role, text) {
        if (chatEmpty) chatEmpty.style.display = 'none';

        const bubble = document.createElement('div');
        bubble.className = `chat-bubble ${role}`;
        bubble.innerHTML = `
            <span class="bubble-label">${role === 'user' ? 'You' : 'Assistant'}</span>
            <div class="bubble-content">${escapeHtml(text)}</div>
        `;
        chatMessages.appendChild(bubble);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    /** Show animated typing dots while assistant is processing. */
    function showTypingIndicator() {
        if (typingIndicator) return; // Already showing
        if (chatEmpty) chatEmpty.style.display = 'none';

        typingIndicator = document.createElement('div');
        typingIndicator.className = 'chat-bubble assistant';
        typingIndicator.innerHTML = `
            <span class="bubble-label">Assistant</span>
            <div class="typing-indicator">
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
                <div class="typing-dot"></div>
            </div>
        `;
        chatMessages.appendChild(typingIndicator);
        chatMessages.scrollTop = chatMessages.scrollHeight;
    }

    function removeTypingIndicator() {
        if (typingIndicator) {
            typingIndicator.remove();
            typingIndicator = null;
        }
    }

    /** Send a text chat message over the WebSocket. */
    function sendChatMessage() {
        if (!ws || ws.readyState !== WebSocket.OPEN) return;
        if (!isSessionActive) return;

        const text = chatInput.value.trim();
        if (!text) return;

        // Optimistic UI: add user bubble immediately
        addChatBubble('user', text);
        chatInput.value = '';
        autoResizeInput();
        showTypingIndicator();

        ws.send(JSON.stringify({ type: 'chat_message', text }));
    }

    /** Auto-resize the textarea as the user types. */
    function autoResizeInput() {
        chatInput.style.height = 'auto';
        chatInput.style.height = Math.min(chatInput.scrollHeight, 100) + 'px';
    }

    // ── Browser TTS fallback (Web Speech API) ────────────────────────────────

    let speechSynth = window.speechSynthesis;
    let currentUtterance = null;

    function speakWithBrowserTTS(text) {
        if (!speechSynth) return;
        speechSynth.cancel();
        currentUtterance = new SpeechSynthesisUtterance(text);
        currentUtterance.rate = 1.0;
        currentUtterance.pitch = 1.0;
        currentUtterance.volume = 1.0;
        currentUtterance.lang = 'en-IN';
        const voices = speechSynth.getVoices();
        const preferred = voices.find(v =>
            v.lang.startsWith('en') && (v.name.includes('Google') || v.name.includes('Natural'))
        ) || voices.find(v => v.lang.startsWith('en')) || voices[0];
        if (preferred) currentUtterance.voice = preferred;
        currentUtterance.onend = () => { currentUtterance = null; };
        currentUtterance.onerror = (e) => { console.warn('[BrowserTTS] Error:', e.error); };
        speechSynth.speak(currentUtterance);
    }

    function stopBrowserTTS() {
        if (speechSynth) speechSynth.cancel();
        currentUtterance = null;
    }

    // ── Session control ───────────────────────────────────────────────────────

    async function startSession() {
        if (isSessionActive) return;

        try {
            await AudioCapture.start((pcmFrame) => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    // Client-side self-interrupt during AI playback
                    if (currentUIState === 'AI_SPEAKING') {
                        const rms = computeRMS(pcmFrame);
                        if (rms > 800) {
                            console.log('[VoiceClient] Self-interrupt: RMS=' + rms.toFixed(0));
                            PlaybackEngine.stopAll();
                            stopBrowserTTS();
                            setUIState('USER_SPEAKING');
                        }
                    }
                    ws.send(pcmFrame);
                }
            });
        } catch (err) {
            showError('Microphone access denied. Please allow mic access and try again.');
            return;
        }

        ws = new WebSocket(WS_URL);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            console.log('[WS] Connected — enabling chat panel');
            setConnected(true);
            isSessionActive = true;
            btnStart.disabled = true;
            btnStop.disabled = false;
            // Enable chat panel — force-remove disabled class and explicitly enable inputs
            chatPanel.classList.remove('disabled');
            chatInput.disabled = false;
            chatSendBtn.disabled = false;
            chatInput.focus();
            setUIState('USER_SPEAKING');
        };

        ws.onmessage = async (event) => {
            // Binary = audio chunk
            if (event.data instanceof ArrayBuffer) {
                await PlaybackEngine.enqueueChunk(event.data);
                return;
            }

            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }

            console.log('[WS] Message:', msg.type, msg);

            switch (msg.type) {
                case 'status':
                    setUIState(msg.state);
                    // Re-enable chat after each status update (it should stay enabled during session)
                    if (isSessionActive && msg.state !== 'TIMEOUT') {
                        chatPanel.classList.remove('disabled');
                        chatInput.disabled = false;
                        chatSendBtn.disabled = false;
                    }
                    if (msg.state === 'TIMEOUT') {
                        showError('Session ended due to inactivity.');
                        endSession(false);
                    }
                    break;

                case 'transcript':
                    // Voice transcripts: show in chat panel as user bubble
                    removeTypingIndicator();
                    addChatBubble('user', msg.text);
                    showTypingIndicator();
                    break;

                case 'tts_text':
                    // Assistant full response: replace typing indicator with bubble
                    removeTypingIndicator();
                    addChatBubble('assistant', msg.text);
                    if (!msg.has_audio) {
                        console.log('[WS] No ElevenLabs audio — using browser TTS fallback');
                        speakWithBrowserTTS(msg.text);
                    }
                    break;

                case 'audio_start':
                    PlaybackEngine.reset();
                    break;

                case 'audio_end':
                    PlaybackEngine.finishReceiving();
                    break;

                case 'interrupt':
                    PlaybackEngine.stopAll();
                    stopBrowserTTS();
                    removeTypingIndicator();
                    break;

                case 'ping':
                    // Keepalive ping from server — no action needed
                    break;

                case 'error':
                    removeTypingIndicator();
                    showError(msg.message);
                    break;

                default:
                    console.warn('[WS] Unknown message type:', msg.type);
            }
        };

        ws.onclose = (event) => {
            console.log('[WS] Closed:', event.code, event.reason);
            setConnected(false);
            setChatEnabled(false);
            if (isSessionActive) endSession(false);
        };

        ws.onerror = (err) => {
            console.error('[WS] Error:', err);
            showError('Connection error. Please try again.');
        };
    }

    function endSession(closeWs = true) {
        isSessionActive = false;
        AudioCapture.stop();
        PlaybackEngine.stopAll();
        removeTypingIndicator();
        setChatEnabled(false);

        if (closeWs && ws && ws.readyState === WebSocket.OPEN) {
            ws.close(1000, 'User ended session');
        }
        ws = null;

        btnStart.disabled = false;
        btnStop.disabled = true;
        setUIState('IDLE');
        setConnected(false);
        console.log('[VoiceClient] Session ended');
    }

    // ── Chat event listeners ──────────────────────────────────────────────────

    chatSendBtn.addEventListener('click', sendChatMessage);

    chatInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            sendChatMessage();
        }
    });

    chatInput.addEventListener('input', autoResizeInput);

    // ── Voice event listeners ─────────────────────────────────────────────────

    btnStart.addEventListener('click', startSession);
    btnStop.addEventListener('click', () => endSession(true));
    window.addEventListener('beforeunload', () => endSession(true));

    // Initial state
    setUIState('IDLE');
    setConnected(false);
    setChatEnabled(false);

    return { startSession, endSession };
})();
