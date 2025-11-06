/**
 * Resemble.ai TTS Service
 * 
 * Handles HTTP streaming TTS requests to Resemble.ai API.
 * Converts WAV responses to PCM streams for client consumption.
 */

import axios, { AxiosResponse } from 'axios';
import { Readable } from 'stream';
import { logger } from '../utils/logger';
import { resembleProjectService } from './resembleProjectService';
import { getVoiceUuid } from '../config/voices';
import { streamWAVToPCM } from '../utils/wavParser';

const RESEMBLE_API_KEY = process.env.RESEMBLE_API_KEY;
const RESEMBLE_STREAMING_ENDPOINT = process.env.RESEMBLE_STREAMING_ENDPOINT || 'https://f.cluster.resemble.ai/stream';
const MAX_TEXT_LENGTH = 3000; // Resemble.ai limit

export interface ResembleTTSOptions {
  text: string;
  voiceName: string;
  onPCMChunk?: (chunk: Buffer) => void;
  signal?: AbortSignal;
}

/**
 * Split text into chunks that respect Resemble's 3000 character limit
 */
function splitTextForResemble(text: string): string[] {
  if (text.length <= MAX_TEXT_LENGTH) {
    return [text];
  }

  const chunks: string[] = [];
  let currentChunk = '';

  // Try to split at sentence boundaries first
  const sentences = text.split(/(?<=[.!?])\s+/);
  
  for (const sentence of sentences) {
    const trimmed = sentence.trim();
    if (!trimmed) continue;

    // If adding this sentence would exceed limit, start a new chunk
    if (currentChunk.length + trimmed.length + 1 > MAX_TEXT_LENGTH && currentChunk.length > 0) {
      chunks.push(currentChunk.trim());
      currentChunk = trimmed;
    } else {
      currentChunk += (currentChunk ? ' ' : '') + trimmed;
    }
  }

  // Add the last chunk
  if (currentChunk.trim()) {
    chunks.push(currentChunk.trim());
  }

  // If still too long, split by words
  const finalChunks: string[] = [];
  for (const chunk of chunks) {
    if (chunk.length <= MAX_TEXT_LENGTH) {
      finalChunks.push(chunk);
    } else {
      // Split by words
      const words = chunk.split(' ');
      let wordChunk = '';
      for (const word of words) {
        if (wordChunk.length + word.length + 1 > MAX_TEXT_LENGTH && wordChunk.length > 0) {
          finalChunks.push(wordChunk.trim());
          wordChunk = word;
        } else {
          wordChunk += (wordChunk ? ' ' : '') + word;
        }
      }
      if (wordChunk.trim()) {
        finalChunks.push(wordChunk.trim());
      }
    }
  }

  return finalChunks.filter(chunk => chunk.trim().length > 0);
}

/**
 * Synthesize speech using Resemble.ai streaming API
 * Returns a stream of PCM audio data
 */
export async function synthesizeResembleTTS(
  options: ResembleTTSOptions
): Promise<Readable> {
  if (!RESEMBLE_API_KEY) {
    throw new Error('RESEMBLE_API_KEY environment variable is not set');
  }

  const { text, voiceName, onPCMChunk, signal } = options;

  // Get voice UUID
  const voiceUuid = getVoiceUuid(voiceName);
  if (!voiceUuid) {
    throw new Error(`Invalid voice name: ${voiceName}`);
  }

  // Get project UUID from database
  const projectUuid = await resembleProjectService.getProjectUuid();

  // Split text if needed
  const textChunks = splitTextForResemble(text);

  logger.info(`Resemble TTS request: voice=${voiceName}, chunks=${textChunks.length}, totalLength=${text.length}`);

  // Create a readable stream that will output PCM data
  const pcmStream = new Readable({
    read() {
      // Data will be pushed asynchronously
    }
  });

  // Process each text chunk sequentially
  (async () => {
    try {
      for (let i = 0; i < textChunks.length; i++) {
        // Check if aborted
        if (signal?.aborted) {
          logger.info('Resemble TTS request aborted');
          pcmStream.destroy(new Error('Request aborted'));
          return;
        }

        const chunk = textChunks[i];
        logger.debug(`Processing Resemble TTS chunk ${i + 1}/${textChunks.length}: "${chunk.substring(0, 50)}..."`);

        // Make request to Resemble.ai
        const response: AxiosResponse<Readable> = await axios({
          method: 'POST',
          url: RESEMBLE_STREAMING_ENDPOINT,
          headers: {
            'Authorization': `Bearer ${RESEMBLE_API_KEY}`,
            'Content-Type': 'application/json'
          },
          data: JSON.stringify({
            project_uuid: projectUuid,
            voice_uuid: voiceUuid,
            data: chunk,
            precision: 'PCM_16',
            sample_rate: 24000,
            use_hd: true
          }),
          responseType: 'stream',
          validateStatus: () => true,
          signal
        });

        if (response.status !== 200) {
          let errorText = '';
          try {
            const chunks: Buffer[] = [];
            response.data.on('data', (chunk: Buffer) => chunks.push(chunk));
            await new Promise(resolve => response.data.on('end', resolve));
            errorText = Buffer.concat(chunks).toString('utf8');
          } catch (e) {
            errorText = 'Failed to read error response';
          }

          throw new Error(`Resemble TTS API error (${response.status}): ${errorText}`);
        }

        // Stream WAV to PCM conversion
        await streamWAVToPCM(response.data, (pcmChunk: Buffer) => {
          // Push PCM chunk to output stream
          pcmStream.push(pcmChunk);
          
          // Also call optional callback
          if (onPCMChunk) {
            onPCMChunk(pcmChunk);
          }
        });

        logger.debug(`Completed Resemble TTS chunk ${i + 1}/${textChunks.length}`);
      }

      // End the stream
      pcmStream.push(null);
      logger.info('Resemble TTS synthesis complete');
    } catch (error: any) {
      logger.error('Error in Resemble TTS synthesis:', error);
      pcmStream.destroy(error);
    }
  })();

  return pcmStream;
}

/**
 * Synthesize speech and return as a single buffer
 * Useful for non-streaming use cases
 */
export async function synthesizeResembleTTSBuffer(
  text: string,
  voiceName: string,
  signal?: AbortSignal
): Promise<Buffer> {
  const chunks: Buffer[] = [];

  await synthesizeResembleTTS({
    text,
    voiceName,
    onPCMChunk: (chunk) => {
      chunks.push(chunk);
    },
    signal
  });

  return Buffer.concat(chunks);
}

