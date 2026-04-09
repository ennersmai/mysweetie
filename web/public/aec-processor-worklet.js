/**
 * AEC (Acoustic Echo Canceller) AudioWorkletProcessor
 * 
 * Real-time echo cancellation using webrtcaec3.js library.
 * Processes microphone input against TTS playback to produce echo-free audio.
 * 
 * This is a PRE-COMPILED plain JavaScript file. It is combined with the
 * webrtcaec3 library code at runtime and loaded as a single AudioWorklet module.
 * WebRtcAec3 will be available in scope when this code executes.
 * 
 * DO NOT use import/export, TypeScript syntax, or any module features here.
 */

// AudioWorkletProcessor and registerProcessor are globals in AudioWorklet context
var AudioWorkletProcessorClass = globalThis.AudioWorkletProcessor;
var registerProcessorFn = globalThis.registerProcessor;

class AECProcessor extends AudioWorkletProcessorClass {
  constructor() {
    super();

    this.aec = null;
    this.outBuf = null;
    this.sampleRate = 48000;
    this.aecFrameSize = 0;
    this.micBuffer = new Float32Array(0);
    this.ttsBuffer = new Float32Array(0);
    this.aecReady = false;
    this.ttsActive = false;
    // Count consecutive frames since TTS stopped — gives AEC time to flush
    this.framesSinceTTSStopped = 0;
    // How many frames to keep running AEC after TTS stops (allows tail echo removal)
    this.AEC_TAIL_FRAMES = 150; // ~400ms at 128 samples/frame @ 48kHz — covers hardware speaker drain time on mobile

    this.port.onmessage = function (ev) {
      if (ev.data.type === 'tts_stopped') {
        // TTS has stopped — clear both buffers to prevent desync.
        // If mic buffer is ahead of TTS buffer, analyze() gets a too-short array → RangeError.
        this.ttsActive = false;
        this.framesSinceTTSStopped = 0;
        this.ttsBuffer = new Float32Array(0);
        this.micBuffer = new Float32Array(0);
        console.log('[AEC] TTS stopped — cleared both buffers, starting tail processing');
        return;
      }

      if (ev.data.type === 'tts_started') {
        // TTS is about to play — mark active so we feed reference audio to AEC
        this.ttsActive = true;
        this.framesSinceTTSStopped = 0;
        console.log('[AEC] TTS started — echo cancellation active');
        return;
      }

      if (ev.data.type === 'init') {
        this._handleInit(ev.data).catch(function (err) {
          console.error('[AEC] Init failed:', err);
          var msg = (err && typeof err === 'object' && err.message) ? err.message : String(err);
          this.port.postMessage({ type: 'init-error', error: msg });
        }.bind(this));
      }
    }.bind(this);
  }

  async _handleInit(data) {
    var sampleRate = data.sampleRate || 48000;
    var wasm = data.wasm;
    this.sampleRate = sampleRate;

    if (typeof WebRtcAec3 === 'undefined') {
      throw new Error('WebRtcAec3 not found in scope — library code may not have loaded correctly');
    }

    // Initialize the AEC module with pre-fetched WASM binary
    var AEC3Module = await WebRtcAec3({ wasmBinary: wasm });

    // Create AEC instance: (sampleRate, renderChannels, captureChannels)
    this.aec = new AEC3Module.AEC3(this.sampleRate, 1, 1);

    // Determine required frame size (WebRTC AEC3 = 10ms frames)
    // At 48kHz: 480 samples, at 16kHz: 160 samples, etc.
    var expectedFrameSize = Math.floor(this.sampleRate / 100); // 10ms worth of samples
    var tempInput = [new Float32Array(expectedFrameSize)];
    this.aecFrameSize = this.aec.processSize(tempInput);

    if (this.aecFrameSize === 0 || this.aecFrameSize < 128) {
      console.warn('[AEC] processSize returned ' + this.aecFrameSize + ', using calculated ' + expectedFrameSize + ' (10ms at ' + this.sampleRate + 'Hz)');
      this.aecFrameSize = expectedFrameSize;
    }

    this.outBuf = [new Float32Array(this.aecFrameSize)];

    console.log('[AEC] Initialized at ' + this.sampleRate + 'Hz, frame size: ' + this.aecFrameSize);
    this.port.postMessage({ type: 'init-done' });
  }

  process(inputs, outputs) {
    var micInput = inputs[0];
    var ttsInput = inputs[1];
    var cleanOutput = outputs[0];

    // Guard: pass through mic if AEC not ready
    if (!this.aec || !this.outBuf || this.aecFrameSize === 0) {
      if (micInput && micInput[0] && cleanOutput && cleanOutput[0]) {
        cleanOutput[0].set(micInput[0]);
      }
      return true;
    }

    if (!micInput || !micInput[0] || !cleanOutput || !cleanOutput[0]) {
      return true;
    }

    var frameSize = micInput[0].length;
    var cleanOutputChannel = cleanOutput[0];

    // Determine if TTS reference audio is present in this frame
    var hasTTSAudio = false;
    if (ttsInput && ttsInput[0] && ttsInput[0].length > 0) {
      // Check if the TTS channel has any non-zero samples
      var ttsChannel = ttsInput[0];
      for (var i = 0; i < ttsChannel.length; i++) {
        if (ttsChannel[i] !== 0) {
          hasTTSAudio = true;
          break;
        }
      }
    }

    if (hasTTSAudio) {
      this.ttsActive = true;
      this.framesSinceTTSStopped = 0;
    } else if (this.ttsActive) {
      // TTS signal just went silent — let the tail processing handle it
      this.ttsActive = false;
      this.framesSinceTTSStopped = 0;
    } else {
      this.framesSinceTTSStopped++;
    }

    // Optimization: avoid constant reallocations by using fixed buffers or more efficient growth
    var growBuffer = function(oldBuf, newData) {
      var combined = new Float32Array(oldBuf.length + newData.length);
      combined.set(oldBuf);
      combined.set(newData, oldBuf.length);
      return combined;
    };

    var shouldRunAEC = this.ttsActive || (this.framesSinceTTSStopped < this.AEC_TAIL_FRAMES);

    if (!shouldRunAEC) {
      // No TTS and tail period is over — pure passthrough for maximum voice clarity
      cleanOutputChannel.set(micInput[0]);
      // Keep buffers clear
      this.micBuffer = new Float32Array(0);
      this.ttsBuffer = new Float32Array(0);
      return true;
    }

    // --- AEC Processing Path ---
    this.micBuffer = growBuffer(this.micBuffer, micInput[0]);
    var ttsFrame = (hasTTSAudio) ? ttsInput[0] : new Float32Array(frameSize);
    this.ttsBuffer = growBuffer(this.ttsBuffer, ttsFrame);


    // Process accumulated frames
    var outputOffset = 0;
    var processedAny = false;

    while (this.micBuffer.length >= this.aecFrameSize && this.ttsBuffer.length >= this.aecFrameSize && outputOffset < frameSize) {
      processedAny = true;
      try {
        var micChunk = this.micBuffer.subarray(0, this.aecFrameSize);
        var ttsChunk = this.ttsBuffer.subarray(0, this.aecFrameSize);

        // Feed the render (TTS) stream to AEC
        this.aec.analyze([ttsChunk]);
        // Process the capture (mic) stream — result written to outBuf
        this.aec.process(this.outBuf, [micChunk]);

        var processed = this.outBuf[0];
        var copyLen = Math.min(processed.length, frameSize - outputOffset);
        cleanOutputChannel.set(processed.subarray(0, copyLen), outputOffset);
        outputOffset += copyLen;

        // Advance buffers
        this.micBuffer = this.micBuffer.subarray(this.aecFrameSize);
        this.ttsBuffer = this.ttsBuffer.subarray(this.aecFrameSize);
      } catch (error) {
        console.error('[AEC] Processing error:', error);
        cleanOutputChannel.set(micInput[0]);
        this.micBuffer = new Float32Array(0);
        this.ttsBuffer = new Float32Array(0);
        return true;
      }
    }

    if (!processedAny) {
      // Not enough data accumulated yet — passthrough so VAD still works
      cleanOutputChannel.set(micInput[0]);
    } else {
      this.aecReady = true;
      // Fill remaining output with passthrough
      if (outputOffset < frameSize) {
        var remaining = frameSize - outputOffset;
        cleanOutputChannel.set(micInput[0].subarray(0, remaining), outputOffset);
      }
    }

    return true;
  }
}

registerProcessorFn('aec-processor', AECProcessor);
