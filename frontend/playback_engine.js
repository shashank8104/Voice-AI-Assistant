/**
 * Playback Engine
 * Receives binary audio chunks (MP3) from WebSocket.
 * Accumulates chunks, decodes as MP3, and schedules for gapless playback.
 * Supports immediate stop on interruption via explicit source.stop().
 */

const PlaybackEngine = (() => {
  let audioCtx = null;
  let scheduledEndTime = 0;
  let accumulatedChunks = [];
  let totalBytes = 0;
  let isReceiving = false;
  let activeSources = [];  // Track all active AudioBufferSourceNodes for instant stop

  function getAudioContext() {
    if (!audioCtx || audioCtx.state === 'closed') {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') {
      audioCtx.resume();
    }
    return audioCtx;
  }

  /**
   * Called when audio_start is received — begin accumulation.
   */
  function startReceiving() {
    accumulatedChunks = [];
    totalBytes = 0;
    isReceiving = true;
    console.log('[Playback] Started receiving audio chunks');
  }

  /**
   * Feed an audio chunk (raw MP3 bytes as ArrayBuffer).
   */
  async function enqueueChunk(arrayBuffer) {
    if (!isReceiving) return;

    const bytes = new Uint8Array(arrayBuffer);
    accumulatedChunks.push(bytes);
    totalBytes += bytes.length;

    console.log(`[Playback] Chunk received: ${bytes.length} bytes (total: ${totalBytes})`);

    // Decode and play progressively every 6KB (was 8KB — smaller = faster first audio)
    if (totalBytes >= 6144) {
      await tryDecodeAndPlay();
    }
  }

  /**
   * Called when audio_end is received — decode and play remaining data.
   */
  async function finishReceiving() {
    isReceiving = false;
    console.log(`[Playback] Finished receiving. Total: ${totalBytes} bytes`);
    // Skip tiny final chunks — they're incomplete MP3 frames and always fail to decode
    if (totalBytes >= 1024) {
      await tryDecodeAndPlay(true);
    } else if (totalBytes > 0) {
      console.log(`[Playback] Skipping tiny final chunk (${totalBytes} bytes — too small to decode)`);
      accumulatedChunks = [];
      totalBytes = 0;
    }
  }

  /**
   * Merge accumulated chunks and decode as MP3.
   */
  async function tryDecodeAndPlay(force = false) {
    if (accumulatedChunks.length === 0) return;
    if (!force && totalBytes < 8192) return;

    const ctx = getAudioContext();

    const merged = new Uint8Array(totalBytes);
    let offset = 0;
    for (const chunk of accumulatedChunks) {
      merged.set(chunk, offset);
      offset += chunk.length;
    }

    // Reset accumulator so new chunks can accumulate while this decodes
    accumulatedChunks = [];
    totalBytes = 0;

    try {
      const audioBuffer = await ctx.decodeAudioData(merged.buffer.slice(0));
      schedulePlayback(audioBuffer, ctx);
    } catch (e) {
      console.warn('[Playback] Decode failed, retrying with more data:', e.message);
      // Put data back for retry with more chunks
      accumulatedChunks = [merged];
      totalBytes = merged.length;
    }
  }

  function schedulePlayback(audioBuffer, ctx) {
    const source = ctx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(ctx.destination);

    const startAt = Math.max(scheduledEndTime, ctx.currentTime + 0.02);
    source.start(startAt);
    scheduledEndTime = startAt + audioBuffer.duration;

    // Track source for immediate stop
    activeSources.push(source);

    console.log(`[Playback] Scheduled ${audioBuffer.duration.toFixed(2)}s of audio at t=${startAt.toFixed(2)}`);

    source.onended = () => {
      activeSources = activeSources.filter(s => s !== source);
    };
  }

  /**
   * Immediately stop ALL audio playback (interruption).
   * Does NOT close AudioContext — just stops all scheduled sources.
   */
  function stopAll() {
    // Stop every scheduled source immediately
    for (const source of activeSources) {
      try {
        source.stop();
      } catch (e) {
        // Already stopped or not started yet — ignore
      }
    }
    activeSources = [];
    accumulatedChunks = [];
    totalBytes = 0;
    isReceiving = false;
    scheduledEndTime = 0;

    // Reset AudioContext time so next audio starts fresh
    if (audioCtx && audioCtx.state !== 'closed') {
      scheduledEndTime = audioCtx.currentTime;
    }

    console.log('[Playback] Stopped all audio');
  }

  /**
   * Reset for a new turn (called on audio_start).
   */
  function reset() {
    // Stop any existing audio first
    stopAll();
    startReceiving();
  }

  return { enqueueChunk, stopAll, reset, finishReceiving };
})();
