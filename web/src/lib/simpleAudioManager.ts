/**
 * Simple Audio Manager for Voice Calls
 * 
 * A simplified version that works with browser default sample rates
 * to avoid the AudioContext sample rate mismatch issues.
 */

export class SimpleAudioManager {
  private mediaStream: MediaStream | null = null;
  private mediaRecorder: MediaRecorder | null = null;
  private audioContext: AudioContext | null = null;
  private isRecording = false;
  private onAudioData: ((data: ArrayBuffer) => void) | null = null;

  /**
   * Initialize audio capture using MediaRecorder
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

      // Check if MediaRecorder supports the format we need
      const options: MediaRecorderOptions = {};
      
      if (MediaRecorder.isTypeSupported('audio/webm;codecs=pcm')) {
        options.mimeType = 'audio/webm;codecs=pcm';
      } else if (MediaRecorder.isTypeSupported('audio/webm')) {
        options.mimeType = 'audio/webm';
      } else if (MediaRecorder.isTypeSupported('audio/mp4')) {
        options.mimeType = 'audio/mp4';
      }

      this.mediaRecorder = new MediaRecorder(this.mediaStream, options);

      console.log('Simple audio capture initialized with MIME type:', options.mimeType);
      return true;

    } catch (error) {
      console.error('Failed to initialize simple audio capture:', error);
      return false;
    }
  }

  /**
   * Initialize audio playback
   */
  async initializePlayback(): Promise<boolean> {
    try {
      this.audioContext = new (window.AudioContext || (window as any).webkitAudioContext)();
      console.log('Simple audio playback initialized');
      return true;
    } catch (error) {
      console.error('Failed to initialize simple audio playback:', error);
      return false;
    }
  }

  /**
   * Start capturing audio
   */
  startCapture(onAudioData: (data: ArrayBuffer) => void): boolean {
    if (!this.mediaRecorder) {
      console.error('Media recorder not initialized');
      return false;
    }

    this.onAudioData = onAudioData;

    this.mediaRecorder.ondataavailable = (event) => {
      if (event.data.size > 0 && this.onAudioData) {
        // Convert Blob to ArrayBuffer
        event.data.arrayBuffer().then((buffer) => {
          this.onAudioData!(buffer);
        });
      }
    };

    // Start recording with small chunks for real-time streaming
    this.mediaRecorder.start(100); // 100ms chunks
    this.isRecording = true;
    
    console.log('Simple audio capture started');
    return true;
  }

  /**
   * Stop audio capture
   */
  stopCapture(): void {
    if (this.mediaRecorder && this.isRecording) {
      this.mediaRecorder.stop();
      this.isRecording = false;
      console.log('Simple audio capture stopped');
    }
  }

  /**
   * Queue audio data for playback
   */
  queueAudioData(audioData: ArrayBuffer): void {
    if (!this.audioContext) {
      console.error('Audio context not initialized');
      return;
    }

    // Decode and play the audio data
    this.audioContext.decodeAudioData(audioData.slice(0))
      .then((audioBuffer) => {
        const source = this.audioContext!.createBufferSource();
        source.buffer = audioBuffer;
        source.connect(this.audioContext!.destination);
        source.start();
      })
      .catch((error) => {
        console.warn('Error decoding audio data:', error);
      });
  }

  /**
   * Stop audio playback
   */
  stopPlayback(): void {
    // Individual sources will stop naturally
    console.log('Simple audio playback stopped');
  }

  /**
   * Clean up resources
   */
  cleanup(): void {
    this.stopCapture();
    
    if (this.mediaStream) {
      this.mediaStream.getTracks().forEach(track => track.stop());
      this.mediaStream = null;
    }

    if (this.audioContext && this.audioContext.state !== 'closed') {
      this.audioContext.close();
      this.audioContext = null;
    }

    this.mediaRecorder = null;
    this.onAudioData = null;
    this.isRecording = false;

    console.log('Simple audio manager cleanup completed');
  }
}
