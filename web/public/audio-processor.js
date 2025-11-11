/**
 * Echo-Aware VAD AudioWorkletProcessor
 * 
 * This processor implements an "Echo-Aware VAD" system that compares microphone
 * energy with AI TTS energy to distinguish between echo and real user speech.
 * 
 * Inputs:
 * - inputs[0]: Microphone audio (what we want to detect)
 * - inputs[1]: AI TTS audio (reference signal for echo detection)
 * 
 * Logic:
 * - When AI is speaking: Only trigger VAD if mic energy > (AI energy * multiplier) + threshold
 * - When AI is silent: Normal VAD threshold
 */

class AudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    
    // TTS state (updated via messages from main thread)
    this.isTTSSpeaking = false;
    
    // VAD state machine
    this.vadSpeaking = false;
    this.vadConsecutiveFrames = 0;
    this.vadLastAboveThreshold = 0;
    this.vadMinFrames = 2; // Minimum consecutive frames to trigger speech
    this.vadHangoverMs = 800; // Silence duration before ending speech
    this.frameCount = 0; // Frame counter for timing (since performance is not available)
    
    // VAD thresholds
    this.baseVadThreshold = 0.1;
    this.currentVadThreshold = 0.1;
    this.bargeInMultiplier = 1.5; // Mic must be 1.5x louder than TTS to barge in
    
    // Noise floor detection
    this.noiseFloor = 0.005;
    this.noiseFloorSamples = [];
    this.NOISE_FLOOR_SAMPLES = 50;
    
    // Mic boost factor (to match main thread calculation)
    this.micBoostFactor = 5.0;
    
    // Message handler for TTS state updates
    this.port.onmessage = (event) => {
      if (event.data.type === 'tts_state') {
        this.isTTSSpeaking = event.data.isPlaying;
        if (this.port) {
          this.port.postMessage({
            type: 'tts_state_ack',
            isPlaying: this.isTTSSpeaking
          });
        }
      } else if (event.data.type === 'vad_threshold') {
        // Update VAD threshold from calibration
        this.baseVadThreshold = event.data.threshold || 0.1;
        this.currentVadThreshold = this.baseVadThreshold;
      }
    };
  }
  
  /**
   * Calculate RMS (Root Mean Square) energy of audio channel
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
   * Update noise floor detection
   */
  updateNoiseFloor(rms) {
    if (!this.vadSpeaking && !this.isTTSSpeaking) {
      this.noiseFloorSamples.push(rms);
      if (this.noiseFloorSamples.length > this.NOISE_FLOOR_SAMPLES) {
        this.noiseFloorSamples.shift();
      }
      
      // Calculate adaptive noise floor (90th percentile)
      if (this.noiseFloorSamples.length >= 20) {
        const sorted = [...this.noiseFloorSamples].sort((a, b) => a - b);
        const percentile90 = Math.floor(sorted.length * 0.9);
        this.noiseFloor = Math.max(0.005, sorted[percentile90] * 1.5);
      }
    }
  }
  
  /**
   * Echo-aware VAD decision
   */
  shouldTriggerVAD(rmsMic, rmsAI) {
    // Apply mic boost factor
    const boostedRMSMic = rmsMic * this.micBoostFactor;
    
    // Update noise floor
    this.updateNoiseFloor(boostedRMSMic);
    
    // Echo-aware logic
    if (this.isTTSSpeaking && rmsAI > 0) {
      // AI is speaking: mic must be significantly louder than AI audio
      const aiEnergyThreshold = (rmsAI * this.bargeInMultiplier) + this.currentVadThreshold;
      return boostedRMSMic > aiEnergyThreshold && boostedRMSMic > this.noiseFloor;
    } else {
      // AI is silent: normal VAD threshold
      return boostedRMSMic > this.currentVadThreshold && boostedRMSMic > this.noiseFloor;
    }
  }
  
  process(inputs, outputs, parameters) {
    const micInput = inputs[0];
    const aiInput = inputs[1]; // May be undefined if TTS not playing
    
    // Check if we have valid microphone input
    if (!micInput || !micInput[0]) {
      return true; // Keep processor alive
    }
    
    const micChannel = micInput[0];
    const aiChannel = aiInput && aiInput[0] ? aiInput[0] : null;
    
    // Calculate RMS for both channels
    const rmsMic = this.calculateRMS(micChannel);
    const rmsAI = this.calculateRMS(aiChannel);
    
    // Make echo-aware VAD decision
    const isSpeech = this.shouldTriggerVAD(rmsMic, rmsAI);
    
    // VAD state machine
    // Use frame count for timing since performance is not available in AudioWorklet
    // At 48kHz, 128 samples per frame ≈ 2.67ms per frame
    const frameTimeMs = (128 / 48000) * 1000; // Approximate frame duration
    this.frameCount++;
    const now = this.frameCount * frameTimeMs; // Approximate time in ms
    
    if (isSpeech) {
      this.vadConsecutiveFrames++;
      this.vadLastAboveThreshold = now;
      
      // Trigger speech start if we've had enough consecutive frames
      if (!this.vadSpeaking && this.vadConsecutiveFrames >= this.vadMinFrames) {
        this.vadSpeaking = true;
        this.port.postMessage({
          type: 'speech_start'
        });
      }
    } else {
      // Reset consecutive frames counter
      this.vadConsecutiveFrames = 0;
      
      // Check for speech end (hangover period)
      if (this.vadSpeaking) {
        const silenceDuration = now - this.vadLastAboveThreshold;
        if (silenceDuration >= this.vadHangoverMs) {
          this.vadSpeaking = false;
          this.port.postMessage({
            type: 'speech_end'
          });
        }
      }
    }
    
    // Always forward microphone audio to main thread for STT processing
    // (when speech is detected, the main thread will use this data)
    this.port.postMessage({
      type: 'audio_data',
      data: micChannel,
      rmsMic: rmsMic,
      rmsAI: rmsAI,
      isSpeech: isSpeech,
      isTTSSpeaking: this.isTTSSpeaking
    });
    
    // Return true to keep the processor alive
    return true;
  }
}

// Register the processor so it can be instantiated
registerProcessor('audio-processor', AudioProcessor);
