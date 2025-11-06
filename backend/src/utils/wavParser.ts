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
 */
export async function streamWAVToPCM(
  wavStream: Readable,
  onPCMChunk: (chunk: Buffer) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    let headerParsed = false;
    let header: WAVHeader | null = null;
    let dataOffset = -1;
    let expectedDataSize = 0;
    let dataReceived = 0;

    wavStream.on('data', (chunk: Buffer) => {
      buffer = Buffer.concat([buffer, chunk]);

      // Parse header once we have enough data
      if (!headerParsed && buffer.length >= 44) {
        try {
          header = parseWAVHeader(buffer);
          dataOffset = header.dataOffset;
          
          // Read data chunk size (4 bytes before dataOffset)
          if (buffer.length >= dataOffset) {
            expectedDataSize = buffer.readUInt32LE(dataOffset - 4);
            headerParsed = true;
            
            // If we already have PCM data in the buffer, extract it
            if (buffer.length > dataOffset) {
              const initialPCM = buffer.subarray(dataOffset);
              const pcmToSend = initialPCM.slice(0, Math.min(initialPCM.length, expectedDataSize));
              onPCMChunk(pcmToSend);
              dataReceived += pcmToSend.length;
              
              // Remove processed data from buffer
              buffer = buffer.subarray(dataOffset + pcmToSend.length);
            }
          }
        } catch (error: any) {
          reject(new Error(`Failed to parse WAV header: ${error.message}`));
          return;
        }
      }

      // Stream PCM data once header is parsed
      if (headerParsed && dataOffset !== -1) {
        // Check if we have PCM data to send
        if (buffer.length > 0 && dataReceived < expectedDataSize) {
          const remaining = expectedDataSize - dataReceived;
          const pcmChunk = buffer.slice(0, Math.min(buffer.length, remaining));
          
          if (pcmChunk.length > 0) {
            onPCMChunk(pcmChunk);
            dataReceived += pcmChunk.length;
            buffer = buffer.subarray(pcmChunk.length);
          }
        }
      }
    });

    wavStream.on('end', () => {
      // Send any remaining PCM data
      if (headerParsed && buffer.length > 0 && dataReceived < expectedDataSize) {
        const remaining = expectedDataSize - dataReceived;
        const pcmChunk = buffer.slice(0, Math.min(buffer.length, remaining));
        if (pcmChunk.length > 0) {
          onPCMChunk(pcmChunk);
        }
      }
      
      if (!headerParsed) {
        reject(new Error('WAV stream ended before header could be parsed'));
      } else {
        resolve();
      }
    });

    wavStream.on('error', (error) => {
      reject(error);
    });
  });
}

