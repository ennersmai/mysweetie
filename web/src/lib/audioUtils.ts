/**
 * Audio Utilities for Real-Time Voice Calls
 * 
 * This module provides Web Audio API utilities for handling PCM audio
 * encoding/decoding required for real-time voice conversations.
 */

export interface AudioConfig {
  sampleRate: number;
  channels: number;
  bitDepth: number;
}

export const DEFAULT_AUDIO_CONFIG: AudioConfig = {
  sampleRate: 16000,
  channels: 1, // Mono
  bitDepth: 16
};

/**
 * Audio Manager for real-time voice calls
 * Handles microphone capture, PCM encoding, and audio playback
 */
export class AudioManager {
  private audioContext: AudioContext | null = null;
  private mediaStream: MediaStream | null = null;
  private sourceNode: MediaStreamAudioSourceNode | null = null;
  private workletNode: AudioWorkletNode | null = null;
  private gainNode: GainNode | null = null;
  private playbackContext: AudioContext | null = null;
  private playbackQueue: ArrayBuffer[] = [];
  private isPlaying = false;
  private nextPlayTime = 0;
  private config: AudioConfig;

  constructor(config: AudioConfig = DEFAULT_AUDIO_CONFIG) {
    this.config = config;
  }

  /**
   * Initialize audio capture from microphone
   */
  async initializeCapture(): Promise<boolean> {
    try {
      // Request microphone access
      this.mediaStream = await navigator.mediaDevices.getUserMedia({
        audio: {
          echoCancellation: true,
          noiseSuppression: true,
          autoGainControl: true
        }
      });

      // Create audio context - let browser use its preferred sample rate
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      
      // Update our config to match the actual context sample rate
      this.config.sampleRate = this.audioContext.sampleRate;
      
      console.log('Audio context sample rate:', this.audioContext.sampleRate);

      // Create source from media stream
      this.sourceNode = this.audioContext.createMediaStreamSource(this.mediaStream);

      // Create gain node for volume control
      this.gainNode = this.audioContext.createGain();
      this.gainNode.gain.value = 1.0;

      // Load and create audio worklet for PCM processing
      await this.audioContext.audioWorklet.addModule('/pcm-processor.js');
      this.workletNode = new AudioWorkletNode(this.audioContext, 'pcm-processor', {
        processorOptions: {
          sampleRate: this.audioContext.sampleRate, // Use actual context sample rate
          bitDepth: this.config.bitDepth
        }
      });

      // Connect the audio graph
      this.sourceNode.connect(this.gainNode);
      this.gainNode.connect(this.workletNode);

      console.log('Audio capture initialized successfully');
      return true;

    } catch (error) {
      console.error('Failed to initialize audio capture:', error);
      return false;
    }
  }

  /**
   * Start capturing audio and return PCM data via callback
   */
  startCapture(onAudioData: (data: ArrayBuffer) => void): boolean {
    if (!this.workletNode || !this.audioContext) {
      console.error('Audio capture not initialized');
      return false;
    }

    this.workletNode.port.onmessage = (event) => {
      if (event.data.type === 'pcm-data') {
        const audioData = event.data.buffer;
        const sampleRate = this.audioContext!.sampleRate;
        
        console.log(`Sending audio chunk: ${audioData.byteLength} bytes at ${sampleRate}Hz`);
        onAudioData(audioData);
      }
    };

    this.workletNode.port.postMessage({ type: 'start' });
    console.log('Audio capture started');
    return true;
  }

  /**
   * Stop audio capture
   */
  stopCapture(): void {
    if (this.workletNode) {
      this.workletNode.port.postMessage({ type: 'stop' });
    }
    console.log('Audio capture stopped');
  }

  /**
   * Initialize audio playback context
   */
  async initializePlayback(): Promise<boolean> {
    try {
      this.playbackContext = new (window.AudioContext || (window as any).webkitAudioContext)();

      this.isPlaying = false;
      this.nextPlayTime = 0;
      this.playbackQueue = [];

      console.log('Audio playback initialized successfully');
      return true;

    } catch (error) {
      console.error('Failed to initialize audio playback:', error);
      return false;
    }
  }

  /**
   * Queue PCM audio data for playback
   */
  queueAudioData(pcmData: ArrayBuffer): void {
    if (!this.playbackContext) {
      console.error('Playback context not initialized');
      return;
    }

    console.log(`Queueing audio data: ${pcmData.byteLength} bytes, queue length: ${this.playbackQueue.length}`);
    this.playbackQueue.push(pcmData);
    
    if (!this.isPlaying) {
      console.log('Starting audio playback');
      this.startPlayback();
    }
  }

  /**
   * Start continuous playback of queued audio
   */
  private async startPlayback(): Promise<void> {
    if (!this.playbackContext || this.isPlaying) {
      return;
    }

    this.isPlaying = true;
    this.nextPlayTime = this.playbackContext.currentTime;

    const playNext = async () => {
      if (this.playbackQueue.length === 0) {
        this.isPlaying = false;
        return;
      }

      const pcmData = this.playbackQueue.shift()!;
      const audioBuffer = await this.pcmToAudioBuffer(pcmData);
      
      if (audioBuffer) {
        const source = this.playbackContext!.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.playbackContext!.destination);

        // Schedule playback
        if (this.nextPlayTime < this.playbackContext!.currentTime) {
          this.nextPlayTime = this.playbackContext!.currentTime;
        }

        source.start(this.nextPlayTime);
        this.nextPlayTime += audioBuffer.duration;

        // Continue playing next chunk
        source.onended = () => {
          if (this.isPlaying) {
            setTimeout(playNext, 0);
          }
        };
      } else {
        // Continue even if one buffer fails
        setTimeout(playNext, 0);
      }
    };

    playNext();
  }

  /**
   * Stop audio playback immediately and clear queue
   */
  stopPlayback(): void {
    this.isPlaying = false;
    this.playbackQueue = [];
    this.nextPlayTime = 0;
    
    // Note: Individual source nodes will stop naturally
    console.log('Audio playback stopped and queue cleared');
  }

  /**
   * Convert PCM data to Web Audio API AudioBuffer
   */
  private async pcmToAudioBuffer(pcmData: ArrayBuffer): Promise<AudioBuffer | null> {
    if (!this.playbackContext) return null;

    try {
      const samples = new Int16Array(pcmData);
      const audioBuffer = this.playbackContext.createBuffer(
        this.config.channels,
        samples.length,
        24000 // Rime.ai sends 24kHz PCM
      );

      // Convert int16 PCM to float32 and copy to audio buffer
      const channelData = audioBuffer.getChannelData(0);
      for (let i = 0; i < samples.length; i++) {
        channelData[i] = samples[i] / 32768.0; // Normalize to [-1, 1]
      }

      console.log(`Created audio buffer: ${samples.length} samples, ${audioBuffer.duration.toFixed(3)}s`);
      return audioBuffer;

    } catch (error) {
      console.error('Error converting PCM to AudioBuffer:', error);
      return null;
    }
  }

  /**
   * Set microphone gain/volume
   */
  setMicrophoneGain(gain: number): void {
    if (this.gainNode) {
      this.gainNode.gain.value = Math.max(0, Math.min(2, gain));
    }
  }

  /**
   * Get current audio input level (for visualization)
   */
  getInputLevel(): number {
    // This would need to be implemented with an AnalyserNode
    // for real-time audio level monitoring
    return 0;
  }

  /**
   * Clean up all audio resources
   */
  cleanup(): void {
    this.stopCapture();
    this.stopPlayback();

    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }

    if (this.playbackContext && this.playbackContext.state !== 'closed') {
      this.playbackContext.close();
      this.playbackContext = null;
    }

    this.sourceNode = null;
    this.workletNode = null;
    this.gainNode = null;

    console.log('Audio manager cleanup completed');
  }
}

/**
 * Check if Web Audio API is supported
 */
export function isWebAudioSupported(): boolean {
  return !!(window.AudioContext || (window as any).webkitAudioContext);
}

/**
 * Check if getUserMedia is supported
 */
export function isMediaStreamSupported(): boolean {
  return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
}

/**
 * Get browser audio capabilities
 */
export async function getAudioCapabilities(): Promise<{
  webAudio: boolean;
  mediaStream: boolean;
  worklet: boolean;
  sampleRates: number[];
}> {
  const webAudio = isWebAudioSupported();
  const mediaStream = isMediaStreamSupported();
  
  let worklet = false;
  let sampleRates: number[] = [];

  if (webAudio) {
    try {
      const testContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      worklet = !!testContext.audioWorklet;
      sampleRates = [8000, 16000, 22050, 24000, 32000, 44100, 48000].filter(rate => {
        try {
          new (window.AudioContext || (window as any).webkitAudioContext)({ sampleRate: rate });
          return true;
        } catch {
          return false;
        }
      });
      testContext.close();
    } catch (error) {
      console.warn('Error testing audio capabilities:', error);
    }
  }

  return {
    webAudio,
    mediaStream, 
    worklet,
    sampleRates
  };
}
