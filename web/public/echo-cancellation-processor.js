/**
 * Echo Cancellation AudioWorkletProcessor using NLMS (Normalized Least Mean Squares)
 * 
 * This processor implements adaptive echo cancellation by:
 * 1. Receiving microphone input (what we want to clean)
 * 2. Receiving TTS reference signal (what's being played)
 * 3. Using NLMS adaptive filtering to predict and subtract echo
 * 4. Outputting echo-cancelled audio
 */

class EchoCancellationProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    
    // NLMS filter parameters
    // Filter length: 2048 samples at 48kHz = ~42.7ms echo path (covers most room acoustics)
    // Typical echo paths: 10-50ms for close speakers, up to 200ms for large rooms
    this.filterLength = 2048; // Increased from 512 for better echo cancellation
    this.mu = 0.8; // Step size (learning rate) - increased for faster adaptation (was 0.5)
    // Higher mu = faster adaptation but less stable. 0.8 is aggressive but should work for echo cancellation
    this.epsilon = 1e-6; // Small constant to prevent division by zero
    
    // Minimum samples needed before starting echo cancellation (reduced for faster startup)
    this.minSamplesForEchoCancel = 256; // Start after 256 samples (~5ms at 48kHz) for very fast startup
    
    // Adaptive filter coefficients (initially zero)
    this.filterCoefficients = new Float32Array(this.filterLength);
    
    // Delay line for reference signal (circular buffer)
    // Need extra buffer to handle asynchronous reference signal arrival
    this.referenceBuffer = new Float32Array(this.filterLength * 2); // Double buffer for async safety
    this.referenceIndex = 0;
    this.referenceWriteIndex = 0; // Separate write index for thread safety
    
    // Reference signal queue (for handling async message port delivery)
    this.referenceQueue = [];
    this.maxQueueSize = 10; // Prevent queue overflow
    
    // Statistics for debugging
    this.frameCount = 0;
    this.erle = 0; // Echo Return Loss Enhancement (dB)
    
    // Port for receiving reference signal from main thread
    this.port.onmessage = (event) => {
      if (event.data.type === 'reference') {
        // TTS audio reference signal received
        const referenceData = event.data.data; // Float32Array
        this.addReferenceSignal(referenceData);
      } else if (event.data.type === 'reset') {
        // Reset filter (e.g., when TTS stops)
        // Clear all filter state to prevent stale coefficients from affecting audio quality
        this.filterCoefficients.fill(0);
        this.referenceBuffer.fill(0);
        this.referenceIndex = 0;
        this.referenceWriteIndex = 0;
        this.referenceQueue = [];
        this.erle = 0;
        this.frameCount = 0;
        console.log('🔄 Echo cancellation filter reset - all coefficients cleared');
      }
    };
  }
  
  /**
   * Add reference signal (TTS audio) to the delay line
   * Called asynchronously from main thread via message port
   */
  addReferenceSignal(data) {
    // Queue reference data for processing in the audio thread
    // This prevents race conditions between async message port and real-time audio processing
    if (this.referenceQueue.length < this.maxQueueSize) {
      this.referenceQueue.push(data);
    } else {
      // Queue overflow - drop oldest samples to prevent memory issues
      console.warn('Echo cancellation: Reference queue overflow, dropping samples');
      this.referenceQueue.shift();
      this.referenceQueue.push(data);
    }
  }
  
  /**
   * Process queued reference signals (called from audio thread)
   * Handles chunked TTS audio - processes all queued chunks and adds to delay line
   */
  processReferenceQueue() {
    // Process all queued reference signal chunks
    // TTS audio arrives in chunks, so we process them all here
    let totalSamplesAdded = 0;
    while (this.referenceQueue.length > 0) {
      const data = this.referenceQueue.shift();
      // Add reference samples to delay line (circular buffer)
      for (let i = 0; i < data.length; i++) {
        this.referenceBuffer[this.referenceWriteIndex] = data[i];
        this.referenceWriteIndex = (this.referenceWriteIndex + 1) % this.referenceBuffer.length;
      }
      totalSamplesAdded += data.length;
    }
    
    // Update read index to follow write index (with filter length delay for echo path)
    // Start echo cancellation as soon as we have minimum samples (faster adaptation)
    if (this.referenceWriteIndex >= this.minSamplesForEchoCancel) {
      // Set referenceIndex to point to samples that are filterLength ago
      // But if we don't have that many yet, point to the start of the buffer
      const delaySamples = Math.min(this.filterLength, this.referenceWriteIndex);
      this.referenceIndex = (this.referenceWriteIndex - delaySamples + this.referenceBuffer.length) % this.referenceBuffer.length;
    }
    
    // Debug: Log when reference signal chunks are processed
    if (totalSamplesAdded > 0 && this.frameCount % 200 === 0) {
      const samplesInBuffer = (this.referenceWriteIndex - this.referenceIndex + this.referenceBuffer.length) % this.referenceBuffer.length;
      console.log(`🔊 Echo cancel: Processed ${totalSamplesAdded} ref samples, buffer has ${samplesInBuffer} samples, writeIdx=${this.referenceWriteIndex}, readIdx=${this.referenceIndex}`);
    }
  }
  
  /**
   * NLMS adaptive filtering
   * @param {Float32Array} micInput - Microphone input (with echo)
   * @param {Float32Array} output - Echo-cancelled output
   */
  processNLMS(micInput, output) {
    const inputLength = micInput.length;
    
    // Process queued reference signals first (thread-safe)
    this.processReferenceQueue();
    
    // Check if we have reference signal data (TTS is playing)
    // Start echo cancellation as soon as we have minimum samples (don't wait for full buffer)
    const hasReferenceSignal = this.referenceWriteIndex >= this.minSamplesForEchoCancel;
    
    // If no reference signal, bypass echo cancellation (pass through mic input)
    if (!hasReferenceSignal) {
      for (let n = 0; n < inputLength; n++) {
        output[n] = micInput[n];
      }
      return; // Early return - no echo cancellation needed
    }
    
    // Echo cancellation active - process with NLMS filter
    for (let n = 0; n < inputLength; n++) {
      
      // Get reference signal vector from delay line
      // Use referenceIndex which points to the oldest sample we need
      // Always use full filterLength (pad with zeros if needed)
      const refVector = new Float32Array(this.filterLength);
      let refIdx = this.referenceIndex;
      
      // Build reference vector (oldest to newest)
      // If we don't have enough samples yet, pad with zeros
      const availableLength = Math.min(this.filterLength, this.referenceWriteIndex);
      for (let i = 0; i < this.filterLength; i++) {
        if (i < availableLength) {
          refVector[i] = this.referenceBuffer[refIdx];
          refIdx = (refIdx + 1) % this.referenceBuffer.length;
        } else {
          refVector[i] = 0; // Pad with zeros
        }
      }
      
      // Advance reference index for next sample
      this.referenceIndex = (this.referenceIndex + 1) % this.referenceBuffer.length;
      
      // Compute filter output (predicted echo)
      let predictedEcho = 0;
      for (let i = 0; i < this.filterLength; i++) {
        predictedEcho += this.filterCoefficients[i] * refVector[i];
      }
      
      // Compute error (echo-cancelled signal)
      const error = micInput[n] - predictedEcho;
      
      // Safety check: if predicted echo is much larger than input, something is wrong
      // This can happen during filter adaptation - limit the cancellation to prevent distortion
      const maxCancellation = Math.abs(micInput[n]) * 0.9; // Don't cancel more than 90% of input
      const clampedError = Math.max(-maxCancellation, Math.min(maxCancellation, error));
      
      // Clamp output to prevent distortion (safety measure)
      output[n] = Math.max(-1, Math.min(1, clampedError));
      
      // Compute reference signal power for normalization
      let refPower = this.epsilon;
      for (let i = 0; i < this.filterLength; i++) {
        refPower += refVector[i] * refVector[i];
      }
      
      // NLMS update: w(n+1) = w(n) + mu * e(n) * x(n) / (||x(n)||^2 + epsilon)
      // Only update filter if reference signal has sufficient power (avoid updating on silence)
      if (refPower > this.epsilon * 10) { // Only update if reference signal is not silent
        const stepSize = this.mu / refPower;
        
        // Adaptive step size - use larger step when error is large (faster initial adaptation)
        const errorMagnitude = Math.abs(error);
        const adaptiveMu = errorMagnitude > 0.01 ? this.mu * 2.0 : this.mu; // 2x step size for large errors
        
        for (let i = 0; i < this.filterLength; i++) {
          this.filterCoefficients[i] += (adaptiveMu / refPower) * error * refVector[i];
        }
      }
    }
    
    // Update statistics occasionally
    this.frameCount++;
    if (this.frameCount % 50 === 0) { // More frequent stats for debugging
      // Calculate ERLE (Echo Return Loss Enhancement)
      let inputPower = 0;
      let outputPower = 0;
      for (let i = 0; i < inputLength; i++) {
        inputPower += micInput[i] * micInput[i];
        outputPower += output[i] * output[i];
      }
      
      if (inputPower > 1e-10 && outputPower > 1e-10) {
        this.erle = 10 * Math.log10(inputPower / outputPower);
        
        // Send statistics to main thread with more detail
        this.port.postMessage({
          type: 'stats',
          erle: this.erle,
          frameCount: this.frameCount,
          inputPower: inputPower,
          outputPower: outputPower,
          hasReference: this.referenceWriteIndex >= this.minSamplesForEchoCancel
        });
      }
    }
  }
  
  process(inputs, outputs, parameters) {
    const input = inputs[0];
    const output = outputs[0];
    
    // Check if we have valid input data
    if (input && input[0] && output && output[0]) {
      const micInput = input[0];
      const echoCancelled = output[0];
      
      // Apply NLMS echo cancellation
      this.processNLMS(micInput, echoCancelled);
      
      // Send echo-cancelled audio to main thread for VAD
      // Copy to new Float32Array to avoid transfer issues
      const echoCancelledCopy = new Float32Array(echoCancelled);
      this.port.postMessage(echoCancelledCopy);
    }
    
    // Return true to keep the processor alive
    return true;
  }
}

// Register the processor
registerProcessor('echo-cancellation-processor', EchoCancellationProcessor);

