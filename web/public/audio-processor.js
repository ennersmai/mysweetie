/**
 * Industry-Standard TTS-Aware VAD AudioWorkletProcessor
 *
 * Key improvements over naive RMS threshold:
 *  1. Adaptive noise floor — tracks ambient noise and sets threshold relative to it.
 *  2. Hysteresis — higher threshold to START speech, lower to STAY in speech.
 *  3. Hangover / forgiveness — a few quiet frames inside speech don't reset detection.
 *  4. Tuned timings — ~10ms to detect speech start, ~700ms silence to end utterance.
 *  5. TTS-aware — raises threshold during AI playback (echo protection).
 *
 * Frame timing at 48 kHz with 128-sample render quanta:
 *   1 frame ≈ 2.67 ms
 */

class AudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();

    // ── VAD state machine ──
    this.vadSpeaking = false;
    this.speechFrames = 0;   // consecutive frames above enter-threshold
    this.silenceFrames = 0;  // consecutive frames below stay-threshold
    this.hangoverFrames = 0; // forgiveness counter (quiet frames tolerated mid-speech)

    // ── Adaptive noise floor ──
    // Tracks the ambient noise level with a slow-attack / fast-release EMA.
    // Threshold = noiseFloor × multiplier.
    this.noiseFloor = 0.002;             // initial conservative estimate
    this.NOISE_FLOOR_ATTACK = 0.002;     // slow: noise floor rises slowly (prevents speech from raising it)
    this.NOISE_FLOOR_RELEASE = 0.05;     // fast: noise floor drops quickly when environment gets quieter
    this.NOISE_FLOOR_MIN = 0.0005;       // absolute minimum (digital silence is never truly zero)
    this.NOISE_FLOOR_MAX = 0.025;        // lowered cap — prevents loud PC fans from making threshold unachievable

    // ── Threshold multipliers (relative to noise floor) ──
    this.ENTER_MULTIPLIER = 4.0;  // RMS must exceed noiseFloor × 4.0 to START speech
    this.STAY_MULTIPLIER  = 2.0;  // RMS must stay above noiseFloor × 2.0 to REMAIN in speech (hysteresis)
    this.MIN_ENTER_THRESHOLD = 0.006; // Absolute minimum — must be above backend 0.005 noise gate

    // ── Frame counts ──
    // At 128 samples / 48 kHz ≈ 2.67 ms per frame
    this.SPEECH_FRAMES_REQUIRED     = 12;  // ~32ms of sustained energy to start — quicker trigger for desktop mics
    this.SPEECH_FRAMES_DURING_TTS   = 30;  // ~107ms during TTS — extra bar: don't barge-in unless clearly real speech
    this.SILENCE_FRAMES_REQUIRED    = 260; // ~700 ms of silence to end utterance
    this.HANGOVER_LIMIT             = 30;  // ~80 ms forgiveness — quiet frames tolerated mid-speech

    // ── Impulse / transient rejection ──
    // A mic tap or bump creates a single-frame energy spike (2.67ms) then silence.
    // Speech onset creates a gradual multi-frame rise over 50-100ms.
    // Track short-term energy EMA: if current frame spikes far above recent average
    // while NOT already speaking, discard it as an impulse.
    this.shortTermEnergy = 0.002;        // fast EMA — tracks recent ~5 frames (13ms)
    this.SHORT_TERM_ALPHA = 0.2;         // α for short-term EMA
    this.IMPULSE_RATIO = 7.0;            // spike 7× recent average = impulse, not speech (balanced: prevents false triggers but allows speech onset)
    this.impulseCooldown = 0;            // frames remaining in post-impulse freeze
    this.IMPULSE_COOLDOWN_FRAMES = 12;   // ~32ms freeze after an impulse (suppresses ringing)

    // ── TTS-aware threshold boosting ──
    this.isTTSPlaying = false;
    this.TTS_THRESHOLD_MULTIPLIER = 3.0; // raise thresholds 3× during TTS playback

    // ── Message handler ──
    this.port.onmessage = (event) => {
      if (event.data.type === 'vad_threshold') {
        // Allow external override of noise floor (e.g. calibration)
        this.noiseFloor = Math.max(this.NOISE_FLOOR_MIN, event.data.threshold || this.noiseFloor);
      } else if (event.data.type === 'tts_playing') {
        this.isTTSPlaying = !!event.data.playing;
        if (this.isTTSPlaying) {
          // Reset speech counters to prevent stale state from triggering during TTS
          this.speechFrames = 0;
          this.hangoverFrames = 0;
        }
      }
    };
  }

  /**
   * Calculate RMS (Root Mean Square) energy of audio frame
   */
  calculateRMS(channel) {
    if (!channel || channel.length === 0) return 0;
    let sum = 0;
    for (let i = 0; i < channel.length; i++) {
      sum += channel[i] * channel[i];
    }
    return Math.sqrt(sum / channel.length);
  }

  /**
   * Update adaptive noise floor using exponential moving average.
   * Only update when NOT speaking — speech energy would corrupt the estimate.
   */
  updateNoiseFloor(rms) {
    if (this.vadSpeaking) return; // freeze during speech

    const alpha = rms > this.noiseFloor ? this.NOISE_FLOOR_ATTACK : this.NOISE_FLOOR_RELEASE;
    this.noiseFloor = this.noiseFloor * (1 - alpha) + rms * alpha;
    this.noiseFloor = Math.max(this.NOISE_FLOOR_MIN, Math.min(this.NOISE_FLOOR_MAX, this.noiseFloor));
  }

  /**
   * Detect impulse/transient noise (mic tap, bump, click).
   * Returns true if this frame should be discarded as an impulse.
   * Only fires when not already in a speech segment — during speech, loud
   * plosives are normal and must not be suppressed.
   */
  isImpulseFrame(rms) {
    // Already speaking — plosives/shouts are valid, never suppress
    if (this.vadSpeaking) {
      this.shortTermEnergy = this.shortTermEnergy * (1 - this.SHORT_TERM_ALPHA)
                           + rms * this.SHORT_TERM_ALPHA;
      return false;
    }

    // If still in post-impulse cooldown, suppress and don't pollute baseline
    if (this.impulseCooldown > 0) {
      this.impulseCooldown--;
      return true;
    }

    // ── CRITICAL: check against PREVIOUS shortTermEnergy, before this frame updates it ──
    // Updating first then checking means (spike / spike) ≈ 1.0 → impulse never detected.
    const baseline = Math.max(this.noiseFloor, this.shortTermEnergy);
    if (rms > this.IMPULSE_RATIO * baseline) {
      // Impulse detected — do NOT update shortTermEnergy with the spike value
      this.impulseCooldown = this.IMPULSE_COOLDOWN_FRAMES;
      return true;
    }

    // Normal frame — update baseline
    this.shortTermEnergy = this.shortTermEnergy * (1 - this.SHORT_TERM_ALPHA)
                         + rms * this.SHORT_TERM_ALPHA;
    return false;
  }

  process(inputs, outputs) {
    const micInput = inputs[0];
    if (!micInput || !micInput[0]) return true;

    const micChannel = micInput[0];

    // Pass-through: copy input to output (for downstream nodes)
    if (outputs[0] && outputs[0][0]) {
      outputs[0][0].set(micChannel);
    }

    // ── Compute energy ──
    const rms = this.calculateRMS(micChannel);

    // ── Impulse / transient rejection ──
    // Must run before noise floor update so impulse energy doesn't corrupt the floor.
    if (this.isImpulseFrame(rms)) {
      // Forward audio to ring buffer but do NOT run VAD logic
      this.port.postMessage({ type: 'audio_data', data: micChannel });
      return true;
    }

    // ── Adaptive noise floor ──
    this.updateNoiseFloor(rms);

    // ── Compute dynamic thresholds ──
    const ttsBoost = this.isTTSPlaying ? this.TTS_THRESHOLD_MULTIPLIER : 1.0;
    const enterThreshold = Math.max(this.MIN_ENTER_THRESHOLD, this.noiseFloor * this.ENTER_MULTIPLIER * ttsBoost);
    const stayThreshold  = this.noiseFloor * this.STAY_MULTIPLIER  * ttsBoost;

    // ── Determine if this frame is speech ──
    // Hysteresis: use higher threshold to enter speech, lower to stay
    const threshold = this.vadSpeaking ? stayThreshold : enterThreshold;
    const isSpeechFrame = rms > threshold;

    // ── State machine with hangover ──
    if (isSpeechFrame) {
      this.speechFrames++;
      this.silenceFrames = 0;
      this.hangoverFrames = 0; // reset forgiveness counter

      // Trigger speech start after enough consecutive speech frames.
      // Require more frames during TTS playback — barge-in must only fire on clearly real speech.
      const framesRequired = this.isTTSPlaying ? this.SPEECH_FRAMES_DURING_TTS : this.SPEECH_FRAMES_REQUIRED;
      if (!this.vadSpeaking && this.speechFrames >= framesRequired) {
        this.vadSpeaking = true;
        this.port.postMessage({ type: 'speech_start' });
      }
    } else {
      // ── Hangover / forgiveness ──
      // While speaking, tolerate a few quiet frames before counting silence.
      // This prevents brief pauses (plosives, breaths) from ending the utterance.
      if (this.vadSpeaking && this.hangoverFrames < this.HANGOVER_LIMIT) {
        this.hangoverFrames++;
        // Don't reset speechFrames — we're forgiving this gap
      } else {
        // Either not speaking, or hangover exhausted
        this.silenceFrames++;
        this.speechFrames = 0;

        if (this.vadSpeaking && this.silenceFrames >= this.SILENCE_FRAMES_REQUIRED) {
          this.vadSpeaking = false;
          this.port.postMessage({ type: 'speech_end' });
        }
      }
    }

    // Forward audio to main thread for ring buffer / STT
    this.port.postMessage({ type: 'audio_data', data: micChannel });

    return true;
  }
}

registerProcessor('audio-processor', AudioProcessor);
