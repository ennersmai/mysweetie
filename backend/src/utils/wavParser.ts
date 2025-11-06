/**
 * WAV Parser Utility
 * 
 * Parses WAV files from Resemble.ai and extracts PCM audio data.
 * Handles Resemble's extended WAV format with cue, list, and ltxt chunks.
 */

import { Readable } from 'stream';
import { logger } from './logger';

export interface WAVHeader {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
  dataOffset: number; // Offset to start of PCM data
}

/**
 * Parse WAV header and find the offset to PCM data
 * Handles standard WAV format and Resemble's extended format with metadata chunks
 */
export function parseWAVHeader(buffer: Buffer): WAVHeader {
  if (buffer.length < 44) {
    throw new Error('WAV file too small to contain header');
  }

  // Check RIFF header
  const riffId = buffer.toString('ascii', 0, 4);
  if (riffId !== 'RIFF') {
    throw new Error(`Invalid WAV file: expected RIFF, got ${riffId}`);
  }

  // Check WAVE format
  const waveId = buffer.toString('ascii', 8, 12);
  if (waveId !== 'WAVE') {
    throw new Error(`Invalid WAV file: expected WAVE, got ${waveId}`);
  }

  // Find fmt chunk
  let offset = 12;
  let fmtFound = false;
  let sampleRate = 0;
  let channels = 0;
  let bitsPerSample = 0;

  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'fmt ') {
      fmtFound = true;
      // Parse fmt chunk
      const audioFormat = buffer.readUInt16LE(offset + 8);
      if (audioFormat !== 1) {
        throw new Error(`Unsupported audio format: ${audioFormat} (expected PCM)`);
      }

      channels = buffer.readUInt16LE(offset + 10);
      sampleRate = buffer.readUInt32LE(offset + 12);
      bitsPerSample = buffer.readUInt16LE(offset + 22);

      offset += 8 + chunkSize;
      // Align to even boundary
      if (chunkSize % 2 === 1) {
        offset += 1;
      }
      break;
    } else {
      offset += 8 + chunkSize;
      // Align to even boundary
      if (chunkSize % 2 === 1) {
        offset += 1;
      }
    }
  }

  if (!fmtFound) {
    throw new Error('WAV file missing fmt chunk');
  }

  // Find data chunk (skip any cue/list/ltxt chunks)
  let dataOffset = -1;
  while (offset < buffer.length - 8) {
    const chunkId = buffer.toString('ascii', offset, offset + 4);
    const chunkSize = buffer.readUInt32LE(offset + 4);

    if (chunkId === 'data') {
      dataOffset = offset + 8; // Start of PCM data
      break;
    } else {
      // Skip this chunk (could be cue, list, ltxt, or other metadata)
      offset += 8 + chunkSize;
      // Align to even boundary
      if (chunkSize % 2 === 1) {
        offset += 1;
      }
    }
  }

  if (dataOffset === -1) {
    throw new Error('WAV file missing data chunk');
  }

  return {
    sampleRate,
    channels,
    bitsPerSample,
    dataOffset
  };
}

/**
 * Extract PCM data from WAV buffer
 * Returns PCM data as Buffer (16-bit samples)
 */
export function extractPCMData(wavBuffer: Buffer): Buffer {
  const header = parseWAVHeader(wavBuffer);
  
  if (header.bitsPerSample !== 16) {
    throw new Error(`Unsupported bits per sample: ${header.bitsPerSample} (expected 16)`);
  }

  if (header.channels !== 1) {
    throw new Error(`Unsupported channel count: ${header.channels} (expected mono)`);
  }

  // Extract PCM data starting from dataOffset
  // The data chunk size is stored 4 bytes before dataOffset
  const dataChunkSize = wavBuffer.readUInt32LE(header.dataOffset - 4);
  const pcmData = wavBuffer.subarray(header.dataOffset, header.dataOffset + dataChunkSize);

  return pcmData;
}

/**
 * Stream WAV data and extract PCM chunks
 * Handles streaming WAV files from Resemble.ai
 * Optimized to start streaming as soon as data chunk is found
 */
export async function streamWAVToPCM(
  wavStream: Readable,
  onPCMChunk: (chunk: Buffer) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let fmtParsed = false;
    let sampleRate = 24000; // Default, will be updated from fmt chunk
    let channels = 1;
    let bitsPerSample = 16;
    let dataOffset = -1;
    let expectedDataSize = 0;
    let dataReceived = 0;
    let searchingForDataChunk = true;

    wavStream.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Parse fmt chunk first (needed for validation, but we can start streaming before finding data chunk)
      if (!fmtParsed && buffer.length >= 44) {
        try {
          // Check RIFF header
          const riffId = buffer.toString('ascii', 0, 4);
          if (riffId !== 'RIFF') {
            reject(new Error(`Invalid WAV file: expected RIFF, got ${riffId}`));
            return;
          }

          // Check WAVE format
          const waveId = buffer.toString('ascii', 8, 12);
          if (waveId !== 'WAVE') {
            reject(new Error(`Invalid WAV file: expected WAVE, got ${waveId}`));
            return;
          }

          // Find and parse fmt chunk
          let offset = 12;
          while (offset < buffer.length - 8 && !fmtParsed) {
            const chunkId = buffer.toString('ascii', offset, offset + 4);
            const chunkSize = buffer.readUInt32LE(offset + 4);

            if (chunkId === 'fmt ') {
              const audioFormat = buffer.readUInt16LE(offset + 8);
              if (audioFormat !== 1) {
                reject(new Error(`Unsupported audio format: ${audioFormat} (expected PCM)`));
                return;
              }

              channels = buffer.readUInt16LE(offset + 10);
              sampleRate = buffer.readUInt32LE(offset + 12);
              bitsPerSample = buffer.readUInt16LE(offset + 22);
              fmtParsed = true;
              break;
            } else {
              offset += 8 + chunkSize;
              if (chunkSize % 2 === 1) {
                offset += 1;
              }
            }
          }
        } catch (error: any) {
          reject(new Error(`Failed to parse WAV fmt chunk: ${error.message}`));
          return;
        }
      }

      // Search for data chunk incrementally (don't wait for full header parse)
      if (fmtParsed && searchingForDataChunk) {
        let offset = 12;
        
        // Find fmt chunk end
        while (offset < buffer.length - 8) {
          const chunkId = buffer.toString('ascii', offset, offset + 4);
          const chunkSize = buffer.readUInt32LE(offset + 4);
          
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
        while (offset <= buffer.length - 8) {
          if (offset + 4 > buffer.length) break;
          
          const chunkId = buffer.toString('ascii', offset, offset + 4);
          
          if (chunkId === 'data') {
            // Found data chunk!
            dataOffset = offset + 8;
            if (offset + 8 <= buffer.length) {
              expectedDataSize = buffer.readUInt32LE(offset + 4);
              searchingForDataChunk = false;
              
              // Immediately start streaming any PCM data we already have
              if (buffer.length > dataOffset) {
                const initialPCM = buffer.subarray(dataOffset);
                const pcmToSend = initialPCM.slice(0, Math.min(initialPCM.length, expectedDataSize));
                if (pcmToSend.length > 0) {
                  onPCMChunk(pcmToSend);
                  dataReceived += pcmToSend.length;
                  buffer = buffer.subarray(dataOffset + pcmToSend.length);
                }
              }
            }
            break;
          } else {
            // Skip this chunk
            if (offset + 8 > buffer.length) break;
            const chunkSize = buffer.readUInt32LE(offset + 4);
            offset += 8 + chunkSize;
            if (chunkSize % 2 === 1) {
              offset += 1;
            }
          }
        }
      }

      // Stream PCM data once data chunk is found
      if (!searchingForDataChunk && dataOffset !== -1) {
        // Stream any available PCM data
        while (buffer.length > 0 && dataReceived < expectedDataSize) {
          const remaining = expectedDataSize - dataReceived;
          const pcmChunk = buffer.slice(0, Math.min(buffer.length, remaining));
          
          if (pcmChunk.length > 0) {
            onPCMChunk(pcmChunk);
            dataReceived += pcmChunk.length;
            buffer = buffer.subarray(pcmChunk.length);
          } else {
            break;
          }
        }
      }
    });

    wavStream.on('end', () => {
      // Send any remaining PCM data
      if (!searchingForDataChunk && buffer.length > 0 && dataReceived < expectedDataSize) {
        const remaining = expectedDataSize - dataReceived;
        const pcmChunk = buffer.slice(0, Math.min(buffer.length, remaining));
        if (pcmChunk.length > 0) {
          onPCMChunk(pcmChunk);
        }
      }
      
      if (!fmtParsed) {
        reject(new Error('WAV stream ended before fmt chunk could be parsed'));
      } else if (searchingForDataChunk) {
        reject(new Error('WAV stream ended before data chunk could be found'));
      } else {
        resolve();
      }
    });

    wavStream.on('error', (error) => {
      reject(error);
    });
  });
}

