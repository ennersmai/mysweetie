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

// ============================================================================
// TUNABLE PARAMETERS - Adjust these for manual tuning during debugging
// ============================================================================
const DECAY_FACTOR = 0.95; // Energy decays by 5% each frame (~2.67ms at 48kHz)
// This gives ~50% decay in ~13 frames (~35ms), matching acoustic latency

const BARGE_IN_MULTIPLIER = 3.5; // Mic must be this many times louder than TTS to barge in (aggressive tuning for hot mic stability)

const AI_ENERGY_FLOOR = 0.005; // AI must be louder than this to enable barge-in
// Prevents false triggers from startup artifacts when AI audio level is too low

const CALIBRATION_ENERGY_FLOOR = 0.001; // Minimum energy for calibration data collection
// Lower than AI_ENERGY_FLOOR - just ensures we're not dividing by zero
// ============================================================================

class AudioProcessor extends AudioWorkletProcessor {
  static get parameterDescriptors() {
    return [{
      name: 'isTTSSpeaking',
      defaultValue: 0,
      minValue: 0,
      maxValue: 1,
      automationRate: 'a-rate' // Sample-accurate
    }];
  }

  constructor(options) {
    super();
    
    // VAD state machine
    this.vadSpeaking = false;
    this.vadConsecutiveFrames = 0;
    this.vadLastAboveThreshold = 0;
    this.vadMinFrames = 2; // Minimum consecutive frames to trigger speech
    this.vadHangoverMs = 800; // Silence duration before ending speech
    this.frameCount = 0; // Frame counter for timing (since performance is not available)
    
    // Decaying peak RMS for latency compensation (leaky integrator)
    // This creates a smooth energy tail that blankets delayed echo during micro-gaps
    this.peakRmsAI = 0;
    
    // VAD thresholds
    this.baseVadThreshold = 0.1;
    this.currentVadThreshold = 0.1;
    
    // Noise floor detection
    this.noiseFloor = 0.005;
    this.noiseFloorSamples = [];
    this.NOISE_FLOOR_SAMPLES = 50;
    
    // Mic boost factor (to match main thread calculation)
    this.micBoostFactor = 5.0;
    
    // Dynamic calibration state for echo-aware VAD
    this.isCalibrating = false;
    this.echoRatioHistory = [];
    this.learnedEchoRatio = 0.9; // Aggressive default - "hot mic" assumption (90% echo ratio)
    
    // Message handler (no longer handles tts_state - now uses synchronous parameter)
    this.port.onmessage = (event) => {
      if (event.data.type === 'vad_threshold') {
        // Update VAD threshold from calibration
        this.baseVadThreshold = event.data.threshold || 0.1;
        this.currentVadThreshold = this.baseVadThreshold;
      } else if (event.data.type === 'start_calibration') {
        // Start calibration mode - collect echo ratio samples
        this.isCalibrating = true;
        this.echoRatioHistory = [];
        if (this.port) {
          this.port.postMessage({
            type: 'calibration_started'
          });
        }
      } else if (event.data.type === 'stop_calibration') {
        // Stop calibration mode - calculate learned echo ratio
        this.isCalibrating = false;
        
        if (this.echoRatioHistory.length > 0) {
          // Calculate average echo ratio
          const sum = this.echoRatioHistory.reduce((a, b) => a + b, 0);
          const averageRatio = sum / this.echoRatioHistory.length;
          
          // THE FINAL SAFEGUARD: Ensure result is a sane number
          if (!isNaN(averageRatio) && averageRatio > 0) {
            // M A N U A L   O V E R R I D E - Force aggressive ratio for stability testing
            this.learnedEchoRatio = 0.9; // Force a high ratio for this test
          } else {
            // If calibration failed (e.g., total silence), fallback to a safe, aggressive default
            console.warn("⚠️ Echo calibration failed to gather data. Falling back to default ratio.");
            this.learnedEchoRatio = 0.9; // The "hot mic" default
          }
          
          // Log the learned ratio
          if (this.port) {
            this.port.postMessage({
              type: 'calibration_complete',
              learnedEchoRatio: this.learnedEchoRatio,
              samples: this.echoRatioHistory.length
            });
          }
          console.log("🔧 M A N U A L   O V E R R I D E");
          console.log(`✅ Calibration complete. FORCED echo ratio: ${this.learnedEchoRatio.toFixed(4)}`);
        } else {
          // No samples collected, fallback to safe default
          console.warn("⚠️ Echo calibration failed to gather data. Falling back to default ratio.");
          this.learnedEchoRatio = 0.9; // The "hot mic" default
          
          if (this.port) {
            this.port.postMessage({
              type: 'calibration_complete',
              learnedEchoRatio: this.learnedEchoRatio,
              samples: 0
            });
          }
          console.log("🔧 M A N U A L   O V E R R I D E");
          console.log(`✅ Calibration complete. FORCED echo ratio: ${this.learnedEchoRatio.toFixed(4)} (fallback)`);
        }
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
   * @param {number} rmsMic - Microphone RMS energy
   * @param {number} peakRmsAI - Peak AI RMS energy over smoothing buffer (for latency compensation)
   * @param {boolean} isTTSSpeaking - Whether TTS is currently playing (from synchronous parameter)
   */
  shouldTriggerVAD(rmsMic, peakRmsAI, isTTSSpeaking) {
    // Apply mic boost factor
    const boostedRMSMic = rmsMic * this.micBoostFactor;
    
    // Update noise floor
    this.updateNoiseFloor(boostedRMSMic);
    
    // Echo-aware logic with smoothed reference signal and learned echo ratio
    if (isTTSSpeaking) {
      // ONLY apply barge-in logic if the AI's voice is loud enough to be a reliable reference
      if (peakRmsAI > AI_ENERGY_FLOOR) {
        // AI is speaking: use learned echo ratio to predict expected echo level
        // Then require mic to be BARGE_IN_MULTIPLIER times louder than expected echo
        const expectedEcho = peakRmsAI * this.learnedEchoRatio;
        const bargeInThreshold = expectedEcho * BARGE_IN_MULTIPLIER;
        const aiEnergyThreshold = bargeInThreshold + this.currentVadThreshold;
        return boostedRMSMic > aiEnergyThreshold && boostedRMSMic > this.noiseFloor;
      } else {
        // If the AI is "speaking" but the energy is below our floor,
        // it's likely a silent gap or startup noise. DO NOT trigger.
        return false;
      }
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
    
    // Read TTS state from synchronous parameter (guaranteed to be available for this frame)
    const isTTSSpeakingParam = parameters.isTTSSpeaking;
    const isTTSSpeaking = isTTSSpeakingParam[0] > 0.5; // It's an array, check the first value
    
    const micChannel = micInput[0];
    const aiChannel = aiInput && aiInput[0] ? aiInput[0] : null;
    
    // Calculate RMS for both channels
    const rmsMic = this.calculateRMS(micChannel);
    const rmsAI = this.calculateRMS(aiChannel);
    
    // Implement "Decaying Peak" (leaky integrator) for latency compensation
    // This creates a smooth energy tail that blankets delayed echo during micro-gaps
    // The peak is either the current AI energy, or the last peak fading away, whichever is higher
    // This mimics natural sound decay and prevents false triggers during buffer gaps
    if (isTTSSpeaking) {
      this.peakRmsAI = Math.max(rmsAI, this.peakRmsAI * DECAY_FACTOR);
      
      // Collect echo ratio samples during calibration
      // THE GUARD: Only collect data if both signals are active and meaningful
      if (this.isCalibrating) {
        if (this.peakRmsAI > CALIBRATION_ENERGY_FLOOR && rmsMic > CALIBRATION_ENERGY_FLOOR) {
          // Calculate current echo ratio (mic energy / AI peak energy)
          const currentRatio = rmsMic / this.peakRmsAI;
          
          // Another guard: Don't add absurdly high ratios (e.g., a cough during calibration)
          if (currentRatio > 0 && currentRatio < 5.0) {
            this.echoRatioHistory.push(currentRatio);
            
            // Limit history size to prevent memory issues
            if (this.echoRatioHistory.length > 1000) {
              this.echoRatioHistory.shift();
            }
          }
        }
      }
    }
    
    // Make echo-aware VAD decision using decaying peak RMS
    const isSpeech = this.shouldTriggerVAD(rmsMic, this.peakRmsAI, isTTSSpeaking);
    
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
    
    // Reset decaying peak when TTS stops (ready for next turn)
    if (!isTTSSpeaking && this.peakRmsAI > 0) {
      this.peakRmsAI = 0;
    }
    
    // Always forward microphone audio to main thread for STT processing
    // (when speech is detected, the main thread will use this data)
    this.port.postMessage({
      type: 'audio_data',
      data: micChannel,
      rmsMic: rmsMic,
      peakRmsAI: this.peakRmsAI,
      isTTSSpeaking: isTTSSpeaking
    });
    
    // Return true to keep the processor alive
    return true;
  }
}

// Register the processor so it can be instantiated
registerProcessor('audio-processor', AudioProcessor);
