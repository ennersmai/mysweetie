/**
 * Resemble.ai TTS Service
 * 
 * Handles HTTP streaming TTS requests to Resemble.ai API.
 * Parses WAV to PCM on backend and streams PCM directly for low latency.
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
 * Returns a stream of PCM audio data (parsed from WAV on backend for low latency)
 */
export async function synthesizeResembleTTS(
  options: ResembleTTSOptions
): Promise<Readable> {
  if (!RESEMBLE_API_KEY) {
    throw new Error('RESEMBLE_API_KEY environment variable is not set');
  }

  const { text, voiceName, signal } = options;

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
        if (!chunk) {
          continue;
        }
        logger.debug(`Processing Resemble TTS chunk ${i + 1}/${textChunks.length}: "${chunk.substring(0, 50)}..."`);
        const requestStartTime = Date.now();

        // Make request to Resemble.ai with retry logic for transient errors
        const maxRetries = 3;
        const retryableStatuses = [502, 503, 504, 429]; // Bad Gateway, Service Unavailable, Gateway Timeout, Too Many Requests
        let response: AxiosResponse<Readable> | null = null;
        let lastError: Error | null = null;

        for (let attempt = 0; attempt < maxRetries; attempt++) {
          try {
            // Check if aborted before retry
            if (signal?.aborted) {
              logger.info('Resemble TTS request aborted during retry');
              pcmStream.destroy(new Error('Request aborted'));
              return;
            }

            const axiosConfig: any = {
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
                sample_rate: 16000,
                use_hd: false
              }),
              responseType: 'stream',
              validateStatus: () => true
            };

            // Only add signal if it's provided
            if (signal) {
              axiosConfig.signal = signal;
            }

            response = await axios(axiosConfig);
            const responseReceivedTime = Date.now();
            logger.debug(`Resemble TTS chunk ${i + 1} HTTP response received (${responseReceivedTime - requestStartTime}ms after request, attempt ${attempt + 1})`);

            // If successful, break out of retry loop
            if (response.status === 200) {
              break;
            }

            // If error status, check if retryable
            if (retryableStatuses.includes(response.status)) {
              let errorText = '';
              try {
                const chunks: Buffer[] = [];
                response.data.on('data', (chunk: Buffer) => chunks.push(chunk));
                await new Promise(resolve => response.data.on('end', resolve));
                errorText = Buffer.concat(chunks).toString('utf8');
              } catch (e) {
                errorText = 'Failed to read error response';
              }

              // If not last attempt, retry with exponential backoff
              if (attempt < maxRetries - 1) {
                const delay = Math.min(1000 * Math.pow(2, attempt), 5000); // Exponential backoff, max 5s
                logger.warn(`Resemble TTS chunk ${i + 1} failed with ${response.status}, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}): ${errorText.substring(0, 100)}`);
                await new Promise(resolve => setTimeout(resolve, delay));
                continue;
              }

              // Last attempt failed, throw error
              if (!response) {
                throw new Error(`Resemble TTS API error: No response received after retries`);
              }
              throw new Error(`Resemble TTS API error (${response.status}): ${errorText}`);
            } else {
              // Non-retryable error, throw immediately
              if (!response) {
                throw new Error('Resemble TTS API error: No response received');
              }
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
          } catch (error: any) {
            lastError = error;
            
            // Check if it's a network error or retryable status
            const status = error?.response?.status;
            if (attempt < maxRetries - 1 && (!status || retryableStatuses.includes(status))) {
              const delay = Math.min(1000 * Math.pow(2, attempt), 5000);
              logger.warn(`Resemble TTS chunk ${i + 1} request failed, retrying in ${delay}ms (attempt ${attempt + 1}/${maxRetries}): ${error?.message || String(error)}`);
              await new Promise(resolve => setTimeout(resolve, delay));
              continue;
            }
            
            // Not retryable or out of retries, throw
            throw error;
          }
        }

        if (!response || response.status !== 200) {
          throw lastError || new Error('Failed to get successful response from Resemble.ai after retries');
        }

        // Track when first PCM chunk arrives
        let firstChunkTime: number | null = null;
        const finalResponseReceivedTime = Date.now();
        
        // Parse WAV to PCM and stream directly for low latency
        await streamWAVToPCM(response.data, (pcmChunk: Buffer) => {
          if (firstChunkTime === null) {
            firstChunkTime = Date.now();
            logger.debug(`Resemble TTS chunk ${i + 1} first PCM data received (${firstChunkTime - requestStartTime}ms after request, ${firstChunkTime - finalResponseReceivedTime}ms after HTTP response)`);
          }
          pcmStream.push(pcmChunk);
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
 * Synthesize speech and return as a single PCM buffer
 * Useful for non-streaming use cases
 */
export async function synthesizeResembleTTSBuffer(
  text: string,
  voiceName: string,
  signal?: AbortSignal
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  const options: ResembleTTSOptions = { text, voiceName };
  if (signal) {
    options.signal = signal;
  }
  const pcmStream = await synthesizeResembleTTS(options);

  return new Promise((resolve, reject) => {
    pcmStream.on('data', (chunk: Buffer) => {
      chunks.push(chunk);
    });
    pcmStream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
    pcmStream.on('error', reject);
  });
}

