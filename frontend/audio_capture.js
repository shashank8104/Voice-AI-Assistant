/**
 * Audio Capture
 * Captures microphone input via Web Audio API (AudioWorklet).
 * Falls back to ScriptProcessorNode for older browsers.
 * Emits 20ms Int16 PCM frames via callback.
 */

const AudioCapture = (() => {
    const SAMPLE_RATE = 16000;

    let audioCtx = null;
    let mediaStream = null;
    let sourceNode = null;
    let workletNode = null;
    let processorNode = null; // fallback
    let isCapturing = false;
    let onFrameCallback = null;

    /**
     * Start capturing microphone audio.
     * @param {Function} onFrame - Called with each 20ms PCM Int16 ArrayBuffer
     */
    async function start(onFrame) {
        if (isCapturing) return;
        onFrameCallback = onFrame;

        try {
            mediaStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    sampleRate: SAMPLE_RATE,
                    channelCount: 1,
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true,
                },
                video: false,
            });
        } catch (err) {
            console.error('[AudioCapture] Mic access denied:', err);
            throw err;
        }

        audioCtx = new (window.AudioContext || window.webkitAudioContext)({
            sampleRate: SAMPLE_RATE,
        });

        sourceNode = audioCtx.createMediaStreamSource(mediaStream);

        // Try AudioWorklet first (modern, non-deprecated)
        const workletSupported = typeof AudioWorkletNode !== 'undefined';
        if (workletSupported) {
            try {
                await audioCtx.audioWorklet.addModule('/static/pcm-processor.js');
                workletNode = new AudioWorkletNode(audioCtx, 'pcm-processor', {
                    channelCount: 1,
                    processorOptions: {},
                });

                workletNode.port.onmessage = (event) => {
                    if (!isCapturing) return;
                    if (onFrameCallback) onFrameCallback(event.data);
                };

                sourceNode.connect(workletNode);
                workletNode.connect(audioCtx.destination);

                isCapturing = true;
                console.log('[AudioCapture] Started via AudioWorklet — sample rate:', audioCtx.sampleRate);
                return;
            } catch (workletErr) {
                console.warn('[AudioCapture] AudioWorklet failed, falling back to ScriptProcessor:', workletErr);
                // Fall through to ScriptProcessorNode
            }
        }

        // Fallback: ScriptProcessorNode (deprecated but still works)
        _startScriptProcessor();
    }

    function _startScriptProcessor() {
        const FRAME_SAMPLES = (SAMPLE_RATE * 20) / 1000; // 320 samples per 20ms
        let sampleBuffer = new Float32Array(0);

        processorNode = audioCtx.createScriptProcessor(4096, 1, 1);
        processorNode.onaudioprocess = (event) => {
            if (!isCapturing) return;

            const inputData = event.inputBuffer.getChannelData(0);
            const combined = new Float32Array(sampleBuffer.length + inputData.length);
            combined.set(sampleBuffer);
            combined.set(inputData, sampleBuffer.length);
            sampleBuffer = combined;

            while (sampleBuffer.length >= FRAME_SAMPLES) {
                const frame = sampleBuffer.slice(0, FRAME_SAMPLES);
                sampleBuffer = sampleBuffer.slice(FRAME_SAMPLES);
                const int16 = float32ToInt16(frame);
                if (onFrameCallback) onFrameCallback(int16.buffer);
            }
        };

        sourceNode.connect(processorNode);
        processorNode.connect(audioCtx.destination);

        isCapturing = true;
        console.log('[AudioCapture] Started via ScriptProcessor — sample rate:', audioCtx.sampleRate);
    }

    /**
     * Stop capturing and release all resources.
     */
    function stop() {
        isCapturing = false;
        onFrameCallback = null;

        if (workletNode) {
            workletNode.disconnect();
            workletNode.port.close();
            workletNode = null;
        }
        if (processorNode) {
            processorNode.disconnect();
            processorNode = null;
        }
        if (sourceNode) {
            sourceNode.disconnect();
            sourceNode = null;
        }
        if (mediaStream) {
            mediaStream.getTracks().forEach(t => t.stop());
            mediaStream = null;
        }
        if (audioCtx) {
            audioCtx.close().catch(() => {});
            audioCtx = null;
        }
        console.log('[AudioCapture] Stopped');
    }

    /**
     * Convert Float32 samples [-1, 1] to Int16 PCM.
     */
    function float32ToInt16(float32Array) {
        const int16 = new Int16Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) {
            const clamped = Math.max(-1, Math.min(1, float32Array[i]));
            int16[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
        }
        return int16;
    }

    return { start, stop };
})();
