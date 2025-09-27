/**
 * Voice Activity Detection (VAD) Utility
 * 
 * This module provides server-side voice activity detection for managing
 * conversational turn-taking in real-time voice conversations.
 */

export interface VADConfig {
  sampleRate: number;
  frameSize: number; // Number of samples per frame
  energyThreshold: number; // Energy threshold for voice detection
  silenceFrames: number; // Number of consecutive silent frames to consider end of speech
  voiceFrames: number; // Number of consecutive voice frames to consider start of speech
}

export interface VADResult {
  isVoice: boolean;
  energy: number;
  confidence: number;
}

export class VoiceActivityDetector {
  private config: VADConfig;
  private voiceFrameCount: number = 0;
  private silenceFrameCount: number = 0;
  private isSpeaking: boolean = false;
  private lastVoiceTime: number = 0;
  private energyHistory: number[] = [];
  private readonly ENERGY_HISTORY_SIZE = 50;

  constructor(config: Partial<VADConfig> = {}) {
    this.config = {
      sampleRate: 16000,
      frameSize: 512, // ~32ms at 16kHz
      energyThreshold: 0.01,
      silenceFrames: 20, // ~640ms of silence
      voiceFrames: 3, // ~96ms of voice
      ...config
    };
  }

  /**
   * Process a chunk of PCM audio data and return VAD result
   * @param audioData - PCM s16le audio data
   * @returns VAD result indicating voice activity
   */
  public processAudio(audioData: Buffer): VADResult {
    // Convert PCM s16le to float32 samples
    const samples = this.bufferToFloat32(audioData);
    
    // Calculate RMS energy
    const energy = this.calculateRMSEnergy(samples);
    
    // Update energy history for adaptive thresholding
    this.updateEnergyHistory(energy);
    
    // Determine if this frame contains voice
    const isVoiceFrame = this.isVoiceActivity(energy);
    
    // Update state counters
    if (isVoiceFrame) {
      this.voiceFrameCount++;
      this.silenceFrameCount = 0;
      this.lastVoiceTime = Date.now();
    } else {
      this.silenceFrameCount++;
      this.voiceFrameCount = 0;
    }

    // Determine speaking state transitions
    const wasSpokeBefore = this.isSpeaking;
    
    if (!this.isSpeaking && this.voiceFrameCount >= this.config.voiceFrames) {
      this.isSpeaking = true;
    } else if (this.isSpeaking && this.silenceFrameCount >= this.config.silenceFrames) {
      this.isSpeaking = false;
    }

    // Calculate confidence based on energy relative to recent history
    const confidence = this.calculateConfidence(energy);

    return {
      isVoice: this.isSpeaking,
      energy,
      confidence
    };
  }

  /**
   * Check if currently in a speaking state
   */
  public isSpeakingState(): boolean {
    return this.isSpeaking;
  }

  /**
   * Reset VAD state (useful when starting a new conversation)
   */
  public reset(): void {
    this.voiceFrameCount = 0;
    this.silenceFrameCount = 0;
    this.isSpeaking = false;
    this.lastVoiceTime = 0;
    this.energyHistory = [];
  }

  /**
   * Get time since last voice activity in milliseconds
   */
  public getTimeSinceLastVoice(): number {
    return this.lastVoiceTime > 0 ? Date.now() - this.lastVoiceTime : Infinity;
  }

  private bufferToFloat32(buffer: Buffer): Float32Array {
    const samples = new Float32Array(buffer.length / 2);
    for (let i = 0; i < samples.length; i++) {
      // Read 16-bit signed integer and normalize to [-1, 1]
      const sample = buffer.readInt16LE(i * 2);
      samples[i] = sample / 32768.0;
    }
    return samples;
  }

  private calculateRMSEnergy(samples: Float32Array): number {
    if (!samples || samples.length === 0) {
      return 0;
    }
    
    let sum = 0;
    for (let i = 0; i < samples.length; i++) {
      const sample = samples[i];
      if (sample !== undefined) {
        sum += sample * sample;
      }
    }
    return Math.sqrt(sum / samples.length);
  }

  private updateEnergyHistory(energy: number): void {
    this.energyHistory.push(energy);
    if (this.energyHistory.length > this.ENERGY_HISTORY_SIZE) {
      this.energyHistory.shift();
    }
  }

  private isVoiceActivity(energy: number): boolean {
    // Use both fixed threshold and adaptive threshold
    const fixedThreshold = this.config.energyThreshold;
    const adaptiveThreshold = this.getAdaptiveThreshold();
    
    return energy > Math.max(fixedThreshold, adaptiveThreshold);
  }

  private getAdaptiveThreshold(): number {
    if (this.energyHistory.length < 10) {
      return this.config.energyThreshold;
    }

    // Calculate median energy as noise floor
    const sorted = [...this.energyHistory].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    
    // Adaptive threshold is 3x the median energy
    return (median ?? this.config.energyThreshold) * 3;
  }

  private calculateConfidence(energy: number): number {
    if (this.energyHistory.length < 5) {
      return 0.5;
    }

    const avgEnergy = this.energyHistory.reduce((sum, e) => sum + e, 0) / this.energyHistory.length;
    const ratio = energy / (avgEnergy + 1e-10); // Avoid division by zero
    
    // Normalize confidence to [0, 1]
    return Math.min(1.0, Math.max(0.0, (ratio - 1) / 4));
  }
}

/**
 * Simple VAD instance factory with sensible defaults
 */
export function createVAD(config?: Partial<VADConfig>): VoiceActivityDetector {
  return new VoiceActivityDetector(config);
}
