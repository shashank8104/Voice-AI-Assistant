/**
 * PCM Processor AudioWorklet
 * Runs in the audio rendering thread. Converts Float32 samples to Int16 PCM
 * and posts 20ms frames back to the main thread.
 */
class PCMProcessor extends AudioWorkletProcessor {
    constructor() {
        super();
        // Use the actual context sample rate (may differ from requested 16000)
        this.FRAME_MS = 20;
        this.FRAME_SAMPLES = Math.floor((sampleRate * this.FRAME_MS) / 1000);
        this.buffer = new Float32Array(0);
    }

    process(inputs) {
        const input = inputs[0];
        if (!input || !input[0]) return true;

        const channelData = input[0]; // Float32

        // Append to rolling buffer
        const combined = new Float32Array(this.buffer.length + channelData.length);
        combined.set(this.buffer);
        combined.set(channelData, this.buffer.length);
        this.buffer = combined;

        // Emit complete 20ms frames
        while (this.buffer.length >= this.FRAME_SAMPLES) {
            const frame = this.buffer.slice(0, this.FRAME_SAMPLES);
            this.buffer = this.buffer.slice(this.FRAME_SAMPLES);

            // Convert Float32 → Int16 PCM
            const int16 = new Int16Array(frame.length);
            for (let i = 0; i < frame.length; i++) {
                const clamped = Math.max(-1, Math.min(1, frame[i]));
                int16[i] = clamped < 0 ? clamped * 32768 : clamped * 32767;
            }

            // Send to main thread (transferable for zero-copy)
            this.port.postMessage(int16.buffer, [int16.buffer]);
        }

        return true; // Keep processor alive
    }
}

registerProcessor('pcm-processor', PCMProcessor);
