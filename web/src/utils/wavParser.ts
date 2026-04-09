/**
 * Client-side WAV Parser
 * 
 * Parses streaming WAV files from Resemble.ai and extracts PCM audio data.
 * Handles Resemble's extended WAV format with cue, list, and ltxt chunks.
 */

export interface WAVParserState {
  buffer: Uint8Array;
  fmtParsed: boolean;
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number;
  expectedDataSize: number;
  dataReceived: number;
  searchingForDataChunk: boolean;
}

/**
 * Create a new WAV parser state
 */
export function createWAVParser(): WAVParserState {
  return {
    buffer: new Uint8Array(0),
    fmtParsed: false,
    sampleRate: 24000, // Default, will be updated from fmt chunk
    channels: 1,
    bitsPerSample: 16,
    dataOffset: -1,
    expectedDataSize: 0,
    dataReceived: 0,
    searchingForDataChunk: true
  };
}

/**
 * Process a chunk of WAV data and extract any available PCM samples
 * Returns an array of PCM chunks (Int16Array) extracted from the WAV data
 */
export function processWAVChunk(
  state: WAVParserState,
  chunk: Uint8Array
): Int16Array[] {
  const pcmChunks: Int16Array[] = [];

  // Append new chunk to buffer
  const newBuffer = new Uint8Array(state.buffer.length + chunk.length);
  newBuffer.set(state.buffer);
  newBuffer.set(chunk, state.buffer.length);
  state.buffer = newBuffer;

  // Parse fmt chunk first (needed for validation)
  if (!state.fmtParsed && state.buffer.length >= 44) {
    try {
      // Check RIFF header
      const riffId = String.fromCharCode(...state.buffer.slice(0, 4));
      if (riffId !== 'RIFF') {
        throw new Error(`Invalid WAV file: expected RIFF, got ${riffId}`);
      }

      // Check WAVE format
      const waveId = String.fromCharCode(...state.buffer.slice(8, 12));
      if (waveId !== 'WAVE') {
        throw new Error(`Invalid WAV file: expected WAVE, got ${waveId}`);
      }

      // Find and parse fmt chunk
      let offset = 12;
      while (offset < state.buffer.length - 8 && !state.fmtParsed) {
        const chunkId = String.fromCharCode(...state.buffer.slice(offset, offset + 4));
        const chunkSize = new DataView(state.buffer.buffer, state.buffer.byteOffset + offset + 4, 4).getUint32(0, true);

        if (chunkId === 'fmt ') {
          const audioFormat = new DataView(state.buffer.buffer, state.buffer.byteOffset + offset + 8, 2).getUint16(0, true);
          if (audioFormat !== 1) {
            throw new Error(`Unsupported audio format: ${audioFormat} (expected PCM)`);
          }

          state.channels = new DataView(state.buffer.buffer, state.buffer.byteOffset + offset + 10, 2).getUint16(0, true);
          state.sampleRate = new DataView(state.buffer.buffer, state.buffer.byteOffset + offset + 12, 4).getUint32(0, true);
          state.bitsPerSample = new DataView(state.buffer.buffer, state.buffer.byteOffset + offset + 22, 2).getUint16(0, true);
          state.fmtParsed = true;
          break;
        } else {
          offset += 8 + chunkSize;
          if (chunkSize % 2 === 1) {
            offset += 1;
          }
        }
      }
    } catch (error: any) {
      throw new Error(`Failed to parse WAV fmt chunk: ${error.message}`);
    }
  }

  // Search for data chunk incrementally (don't wait for full header parse)
  if (state.fmtParsed && state.searchingForDataChunk) {
    let offset = 12;

    // Find fmt chunk end
    while (offset < state.buffer.length - 8) {
      const chunkId = String.fromCharCode(...state.buffer.slice(offset, offset + 4));
      const chunkSize = new DataView(state.buffer.buffer, state.buffer.byteOffset + offset + 4, 4).getUint32(0, true);

      if (chunkId === 'fmt ') {
        offset += 8 + chunkSize;
        if (chunkSize % 2 === 1) {
          offset += 1;
        }
        break;
      } else {
        offset += 8 + chunkSize;
        if (chunkSize % 2 === 1) {
          offset += 1;
        }
      }
    }

    // Now search for data chunk starting after fmt
    while (offset <= state.buffer.length - 8) {
      if (offset + 4 > state.buffer.length) break;

      const chunkId = String.fromCharCode(...state.buffer.slice(offset, offset + 4));

      if (chunkId === 'data') {
        // Found data chunk!
        state.dataOffset = offset + 8;
        if (offset + 8 <= state.buffer.length) {
          state.expectedDataSize = new DataView(state.buffer.buffer, state.buffer.byteOffset + offset + 4, 4).getUint32(0, true);
          state.searchingForDataChunk = false;

          // Immediately extract any PCM data we already have
          if (state.buffer.length > state.dataOffset) {
            const initialPCM = state.buffer.subarray(state.dataOffset);
            const pcmToExtract = initialPCM.slice(0, Math.min(initialPCM.length, state.expectedDataSize));
            if (pcmToExtract.length > 0) {
              // Convert to Int16Array (little-endian)
              const pcmData = new Int16Array(pcmToExtract.length / 2);
              const dv = new DataView(pcmToExtract.buffer, pcmToExtract.byteOffset, pcmToExtract.length);
              for (let i = 0; i < pcmData.length; i++) {
                pcmData[i] = dv.getInt16(i * 2, true);
              }
              pcmChunks.push(pcmData);
              state.dataReceived += pcmToExtract.length;
              state.buffer = state.buffer.subarray(state.dataOffset + pcmToExtract.length);
            }
          }
        }
        break;
      } else {
        // Skip this chunk
        if (offset + 8 > state.buffer.length) break;
        const chunkSize = new DataView(state.buffer.buffer, state.buffer.byteOffset + offset + 4, 4).getUint32(0, true);
        offset += 8 + chunkSize;
        if (chunkSize % 2 === 1) {
          offset += 1;
        }
      }
    }
  }

  // Extract PCM data once data chunk is found
  if (!state.searchingForDataChunk && state.dataOffset !== -1) {
    // Extract any available PCM data
    while (state.buffer.length > 0 && state.dataReceived < state.expectedDataSize) {
      const remaining = state.expectedDataSize - state.dataReceived;
      const pcmChunk = state.buffer.slice(0, Math.min(state.buffer.length, remaining));

      if (pcmChunk.length > 0) {
        // Convert to Int16Array (little-endian)
        const pcmData = new Int16Array(pcmChunk.length / 2);
        const dv = new DataView(pcmChunk.buffer, pcmChunk.byteOffset, pcmChunk.length);
        for (let i = 0; i < pcmData.length; i++) {
          pcmData[i] = dv.getInt16(i * 2, true);
        }
        pcmChunks.push(pcmData);
        state.dataReceived += pcmChunk.length;
        state.buffer = state.buffer.subarray(pcmChunk.length);
      } else {
        break;
      }
    }
  }

  return pcmChunks;
}

/**
 * Check if the parser has finished processing all data
 */
export function isWAVParserComplete(state: WAVParserState): boolean {
  return state.fmtParsed && !state.searchingForDataChunk && state.dataReceived >= state.expectedDataSize;
}

