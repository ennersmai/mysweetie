/**
 * TTS-Aware VAD AudioWorkletProcessor
 * 
 * Voice activity detection with adaptive threshold that rises during TTS
 * playback to prevent echo from triggering false speech detection.
 * Works as a second layer of protection alongside the AEC processor.
 * In fallback mode (no AEC), this is the primary echo defense.
 */

class AudioProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    
    // VAD state machine
    this.vadSpeaking = false;
    this.speechFrames = 0;
    this.silenceFrames = 0;
    
    // Base VAD parameters
    this.BASE_THRESHOLD = 0.0045;
    this.VAD_THRESHOLD = this.BASE_THRESHOLD;
    this.SPEECH_FRAMES_REQUIRED = 4;
    this.SILENCE_FRAMES_REQUIRED = 560; // ~1.5s at 128 samples/frame @ 48kHz (128/48000 = 2.67ms/frame)
    
    // TTS-aware threshold boosting
    this.isTTSPlaying = false;
    this.TTS_THRESHOLD_MULTIPLIER = 3.0; // Raise threshold 3x during TTS playback
    
    // Message handler for threshold updates and TTS state
    this.port.onmessage = (event) => {
      if (event.data.type === 'vad_threshold') {
        this.BASE_THRESHOLD = event.data.threshold || 0.0045;
        // Apply TTS multiplier if currently playing
        this.VAD_THRESHOLD = this.isTTSPlaying 
          ? this.BASE_THRESHOLD * this.TTS_THRESHOLD_MULTIPLIER 
          : this.BASE_THRESHOLD;
      } else if (event.data.type === 'tts_playing') {
        this.isTTSPlaying = !!event.data.playing;
        // Immediately adjust threshold
        this.VAD_THRESHOLD = this.isTTSPlaying 
          ? this.BASE_THRESHOLD * this.TTS_THRESHOLD_MULTIPLIER 
          : this.BASE_THRESHOLD;
        if (this.isTTSPlaying) {
          // Reset speech detection to prevent stale state from triggering during TTS
          this.speechFrames = 0;
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
  
  process(inputs, outputs) {
    const micInput = inputs[0];
    
    // Check if we have valid microphone input
    if (!micInput || !micInput[0]) {
      return true; // Keep processor alive
    }
    
    const micChannel = micInput[0];
    
    // Pass-through: copy input to output
    if (outputs[0] && outputs[0][0]) {
      outputs[0][0].set(micChannel);
    }
    
    // Calculate RMS for VAD
    const rmsMic = this.calculateRMS(micChannel);
    const isSpeechFrame = rmsMic > this.VAD_THRESHOLD;
    
    // Simple VAD state machine
    if (isSpeechFrame) {
      this.speechFrames++;
      this.silenceFrames = 0;
      
      // Trigger speech start if we've had enough consecutive speech frames
      if (!this.vadSpeaking && this.speechFrames >= this.SPEECH_FRAMES_REQUIRED) {
        this.vadSpeaking = true;
        this.port.postMessage({
          type: 'speech_start'
        });
      }
    } else {
      this.silenceFrames++;
      this.speechFrames = 0;
      
      // Trigger speech end if we've had enough consecutive silence frames
      if (this.vadSpeaking && this.silenceFrames >= this.SILENCE_FRAMES_REQUIRED) {
        this.vadSpeaking = false;
        this.port.postMessage({
          type: 'speech_end'
        });
      }
    }
    
    // Forward microphone audio to main thread for STT processing
    this.port.postMessage({
      type: 'audio_data',
      data: micChannel
    });
    
    // Return true to keep the processor alive
    return true;
  }
}

// Register the processor so it can be instantiated
registerProcessor('audio-processor', AudioProcessor);
