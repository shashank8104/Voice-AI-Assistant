/**
 * Audio Capture
 * Captures microphone input via Web Audio API.
 * Converts float32 samples to Int16 PCM and emits 20ms frames.
 */

const AudioCapture = (() => {
    const SAMPLE_RATE = 16000;
    const FRAME_MS = 20;
    const FRAME_SAMPLES = (SAMPLE_RATE * FRAME_MS) / 1000; // 320 samples

    let audioCtx = null;
    let mediaStream = null;
    let sourceNode = null;
    let processorNode = null;
    let isCapturing = false;
    let onFrameCallback = null;

    // Accumulate samples until we have a full 20ms frame
    let sampleBuffer = new Float32Array(0);

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

            audioCtx = new (window.AudioContext || window.webkitAudioContext)({
                sampleRate: SAMPLE_RATE,
            });

            sourceNode = audioCtx.createMediaStreamSource(mediaStream);

            // ScriptProcessorNode for broad browser compatibility
            // Buffer size 4096 @ 16kHz = 256ms — we'll slice into 20ms frames
            processorNode = audioCtx.createScriptProcessor(4096, 1, 1);

            processorNode.onaudioprocess = (event) => {
                if (!isCapturing) return;

                const inputData = event.inputBuffer.getChannelData(0); // Float32

                // Append to rolling buffer
                const combined = new Float32Array(sampleBuffer.length + inputData.length);
                combined.set(sampleBuffer);
                combined.set(inputData, sampleBuffer.length);
                sampleBuffer = combined;

                // Emit complete 20ms frames
                while (sampleBuffer.length >= FRAME_SAMPLES) {
                    const frame = sampleBuffer.slice(0, FRAME_SAMPLES);
                    sampleBuffer = sampleBuffer.slice(FRAME_SAMPLES);
                    const pcm = float32ToInt16(frame);
                    if (onFrameCallback) onFrameCallback(pcm.buffer);
                }
            };

            sourceNode.connect(processorNode);
            processorNode.connect(audioCtx.destination);

            isCapturing = true;
            console.log('[AudioCapture] Started — sample rate:', audioCtx.sampleRate);
        } catch (err) {
            console.error('[AudioCapture] Failed to start:', err);
            throw err;
        }
    }

    /**
     * Stop capturing and release all resources.
     */
    function stop() {
        isCapturing = false;
        onFrameCallback = null;
        sampleBuffer = new Float32Array(0);

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
            audioCtx.close().catch(() => { });
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
