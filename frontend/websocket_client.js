/**
 * WebSocket Client
 * Manages the WebSocket connection, sends audio frames,
 * receives audio/status messages, and updates the UI.
 */

const VoiceClient = (() => {
    const WS_PROTOCOL = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const WS_URL = `${WS_PROTOCOL}//${window.location.host}/ws`;

    let ws = null;
    let isSessionActive = false;
    let currentUIState = 'IDLE'; // Track current state for client-side interruption

    // ── UI elements ──────────────────────────────────────────────────────────
    const orb = document.getElementById('orb');
    const waves = document.getElementById('waves');
    const statusBadge = document.getElementById('statusBadge');
    const statusText = document.getElementById('statusText');
    const btnStart = document.getElementById('btnStart');
    const btnStop = document.getElementById('btnStop');
    const transcriptBox = document.getElementById('transcriptBox');
    const transcriptEmpty = document.getElementById('transcriptEmpty');
    const connDot = document.getElementById('connDot');
    const connLabel = document.getElementById('connLabel');
    const errorToast = document.getElementById('errorToast');
    const iconMic = document.getElementById('iconMic');
    const iconThink = document.getElementById('iconThink');
    const iconSpeak = document.getElementById('iconSpeak');

    let errorToastTimer = null;

    // ── UI helpers ───────────────────────────────────────────────────────────

    function setConnected(connected) {
        connDot.className = 'conn-dot ' + (connected ? 'connected' : 'disconnected');
        connLabel.textContent = connected ? 'Connected' : 'Disconnected';
    }

    function setUIState(state) {
        currentUIState = state;  // Track for client-side interrupt detection
        // Remove all state classes
        orb.className = 'orb';
        statusBadge.className = 'status-badge';
        waves.className = 'waves';

        // Hide all icons
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
                break;

            case 'AI_PROCESSING':
                orb.classList.add('thinking');
                statusBadge.classList.add('thinking');
                statusText.textContent = 'Thinking...';
                iconThink.style.display = 'block';
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
                break;
        }
    }

    function showError(message) {
        errorToast.textContent = message;
        errorToast.classList.add('show');
        if (errorToastTimer) clearTimeout(errorToastTimer);
        errorToastTimer = setTimeout(() => errorToast.classList.remove('show'), 4000);
    }

    function addTranscriptEntry(role, text) {
        if (transcriptEmpty) transcriptEmpty.style.display = 'none';

        const entry = document.createElement('div');
        entry.className = 'transcript-entry';
        entry.innerHTML = `
      <span class="transcript-label ${role}">${role === 'user' ? 'You' : 'Assistant'}</span>
      <span class="transcript-text">${escapeHtml(text)}</span>
    `;
        transcriptBox.appendChild(entry);
        transcriptBox.scrollTop = transcriptBox.scrollHeight;
    }

    function escapeHtml(text) {
        return text
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;');
    }

    /** Compute RMS energy from Int16 PCM ArrayBuffer. */
    function computeRMS(arrayBuffer) {
        const samples = new Int16Array(arrayBuffer);
        if (samples.length === 0) return 0;
        let sum = 0;
        for (let i = 0; i < samples.length; i++) sum += samples[i] * samples[i];
        return Math.sqrt(sum / samples.length);
    }

    // ── Browser TTS fallback (Web Speech API) ───────────────────────────────

    let speechSynth = window.speechSynthesis;
    let currentUtterance = null;

    function speakWithBrowserTTS(text) {
        if (!speechSynth) {
            console.warn('[BrowserTTS] SpeechSynthesis not supported');
            return;
        }
        // Cancel any ongoing speech
        speechSynth.cancel();

        currentUtterance = new SpeechSynthesisUtterance(text);
        currentUtterance.rate = 1.0;
        currentUtterance.pitch = 1.0;
        currentUtterance.volume = 1.0;
        currentUtterance.lang = 'en-IN';

        // Pick a good voice if available
        const voices = speechSynth.getVoices();
        const preferred = voices.find(v =>
            v.lang.startsWith('en') && (v.name.includes('Google') || v.name.includes('Natural'))
        ) || voices.find(v => v.lang.startsWith('en')) || voices[0];
        if (preferred) currentUtterance.voice = preferred;

        currentUtterance.onend = () => {
            console.log('[BrowserTTS] Speech ended');
            currentUtterance = null;
        };
        currentUtterance.onerror = (e) => {
            console.warn('[BrowserTTS] Error:', e.error);
        };

        speechSynth.speak(currentUtterance);
        console.log('[BrowserTTS] Speaking:', text.slice(0, 60) + '...');
    }

    function stopBrowserTTS() {
        if (speechSynth) speechSynth.cancel();
        currentUtterance = null;
    }

    // ── Session control ──────────────────────────────────────────────────────

    async function startSession() {
        if (isSessionActive) return;

        try {
            // Start audio capture first
            await AudioCapture.start((pcmFrame) => {
                if (ws && ws.readyState === WebSocket.OPEN) {
                    // Client-side self-interrupt: stop audio immediately if user speaks
                    // during AI response (don't wait for server round-trip)
                    if (currentUIState === 'AI_SPEAKING' || currentUIState === 'AI_PROCESSING') {
                        const rms = computeRMS(pcmFrame);
                        if (rms > 500) {
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

        // Connect WebSocket
        ws = new WebSocket(WS_URL);
        ws.binaryType = 'arraybuffer';

        ws.onopen = () => {
            console.log('[WS] Connected');
            setConnected(true);
            isSessionActive = true;
            btnStart.disabled = true;
            btnStop.disabled = false;
            setUIState('USER_SPEAKING');
        };

        ws.onmessage = async (event) => {
            // Binary = audio chunk
            if (event.data instanceof ArrayBuffer) {
                await PlaybackEngine.enqueueChunk(event.data);
                return;
            }

            // JSON = control message
            let msg;
            try { msg = JSON.parse(event.data); } catch { return; }

            console.log('[WS] Message:', msg);

            switch (msg.type) {
                case 'status':
                    setUIState(msg.state);
                    if (msg.state === 'TIMEOUT') {
                        showError('Session ended due to inactivity.');
                        endSession(false);
                    }
                    break;

                case 'transcript':
                    addTranscriptEntry('user', msg.text);
                    break;

                case 'tts_text':
                    // Display assistant response in transcript
                    addTranscriptEntry('assistant', msg.text);
                    // Use browser TTS if ElevenLabs had no audio
                    if (!msg.has_audio) {
                        console.log('[WS] No ElevenLabs audio — using browser TTS fallback');
                        speakWithBrowserTTS(msg.text);
                    }
                    break;

                case 'audio_start':
                    PlaybackEngine.reset();
                    break;

                case 'audio_end':
                    // Flush any remaining accumulated audio chunks
                    PlaybackEngine.finishReceiving();
                    break;

                case 'interrupt':
                    PlaybackEngine.stopAll();
                    stopBrowserTTS();
                    break;

                case 'error':
                    showError(msg.message);
                    break;
            }
        };

        ws.onclose = (event) => {
            console.log('[WS] Closed:', event.code, event.reason);
            setConnected(false);
            if (isSessionActive) {
                endSession(false);
            }
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

    // ── Event listeners ──────────────────────────────────────────────────────

    btnStart.addEventListener('click', startSession);
    btnStop.addEventListener('click', () => endSession(true));

    // Cleanup on page unload
    window.addEventListener('beforeunload', () => endSession(true));

    // Initial UI state
    setUIState('IDLE');
    setConnected(false);

    return { startSession, endSession };
})();
