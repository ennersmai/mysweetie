/**
 * Type definitions for AudioWorklet API
 * These types are needed for TypeScript to recognize AudioWorkletProcessor and related APIs
 */

interface AudioWorkletProcessor {
  readonly port: MessagePort;
  process(
    inputs: Float32Array[][],
    outputs: Float32Array[][],
    parameters?: Record<string, Float32Array>
  ): boolean;
}

declare var AudioWorkletProcessor: {
  prototype: AudioWorkletProcessor;
  new (options?: AudioWorkletProcessorOptions): AudioWorkletProcessor;
};

interface AudioWorkletProcessorOptions {
  processorOptions?: Record<string, any>;
}

interface AudioWorkletNodeOptions {
  numberOfInputs?: number;
  numberOfOutputs?: number;
  channelCount?: number;
  channelCountMode?: ChannelCountMode;
  channelInterpretation?: ChannelInterpretation;
  processorOptions?: Record<string, any>;
}

declare function registerProcessor(
  name: string,
  processorCtor: new (options?: AudioWorkletProcessorOptions) => AudioWorkletProcessor
): void;

