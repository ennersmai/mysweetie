import { Request, Response } from 'express';
import { logger } from '../utils/logger';
import { Readable } from 'stream';
import { supabaseAdmin } from '../config/database';
import { redis } from '../config/redis';
import { encode } from 'gpt-tokenizer';
import { synthesizeResembleTTS } from '../services/resembleTtsService';
import { isValidVoice } from '../config/voices';

const FREE_TTS_DAILY_LIMIT = Number(process.env.FREE_TTS_DAILY_LIMIT || 10);
const BASIC_TTS_MONTHLY_LIMIT = Number(process.env.BASIC_TTS_MONTHLY_LIMIT || 50);
const PREMIUM_TTS_MONTHLY_LIMIT = Number(process.env.PREMIUM_TTS_MONTHLY_LIMIT || 500);

function currentMonthUtc(): string {
  return new Date().toISOString().slice(0, 7); // Returns YYYY-MM format
}

export const handleArcanaPcm = async (req: Request, res: Response): Promise<void> => {
  try {
    const { text, speaker } = req.body || {};

    if (!text || !speaker) {
      res.status(400).json({ error: 'Both "text" and "speaker" are required.' });
      return;
    }

    // Validate voice name
    if (!isValidVoice(speaker)) {
      res.status(400).json({ error: `Invalid voice name: ${speaker}` });
      return;
    }

    // Enforce TTS usage limits
    const userId = (req as any)?.user?.id as string | undefined;
    if (!userId) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }

    // Count input text tokens (for future cost tracking; currently we enforce by generations)
    let textTokens = 0;
    try { textTokens = encode(text).length; } catch {}

    // Load profile usage
    const { data: profile, error: profileErr } = await supabaseAdmin
      .from('profiles')
      .select('is_premium, plan_tier, voice_trials_used, voice_quota_used, voice_credits, welcome_credits')
      .eq('id', userId)
      .maybeSingle();

    if (profileErr || !profile) {
      logger.warn({ message: 'Could not load profile for TTS usage check', userId, error: profileErr?.message });
      res.status(403).json({ error: 'Profile not found' });
      return;
    }

    const isPremium = Boolean(profile.is_premium);
    const planTier = (profile.plan_tier as string) || (isPremium ? 'basic' : 'free');

    // Monthly reset for free trials using Redis fallback (no schema change required)
    if (!isPremium && redis.isConnected()) {
      const client = redis.getClient();
      const resetKey = `tts:free_reset:${userId}:${currentMonthUtc()}`;
      try {
        const wasReset = await client?.get(resetKey);
        if (!wasReset) {
          await supabaseAdmin
            .from('profiles')
            .update({ voice_trials_used: 0 })
            .eq('id', userId);
          profile.voice_trials_used = 0;
          // Set key with 31-day TTL (covers all month lengths)
          await client?.setEx(resetKey, 60 * 60 * 24 * 31, '1');
        }
      } catch (e) {
        // Non-fatal; skip reset if Redis/DB issues occur
      }
    }

    // Check welcome credits first, then voice credits
    const welcomeCredits = Number(profile.welcome_credits || 0);
    const voiceCredits = Number(profile.voice_credits || 0);
    
    if (welcomeCredits <= 0 && voiceCredits <= 0) {
      res.status(429).json({ 
        error: 'No voice credits remaining', 
        credits: voiceCredits,
        welcomeCredits: welcomeCredits,
        message: welcomeCredits <= 0 
          ? "You're out of voice credits! To continue speaking with your companion, please choose a plan."
          : 'Purchase more voice credits to continue using voice features'
      });
      return;
    }

    const requestId = Math.floor(Math.random() * 1e9);
    logger.info({ message: 'Resemble TTS request start', requestId, len: text.length, speaker });

    // Create abort controller for request cancellation
    const abortController = new AbortController();

    // Synthesize speech using Resemble.ai
    let pcmStream: Readable;
    try {
      pcmStream = await synthesizeResembleTTS({
        text,
        voiceName: speaker,
        signal: abortController.signal
      });
    } catch (error: any) {
      logger.error({ message: 'Resemble TTS synthesis error', requestId, error: error?.message || String(error) });
      res.status(500).json({ error: error?.message || 'TTS synthesis failed' });
      return;
    }

    // On success: deduct one credit (welcome credits first, then voice credits)
    try {
      if (welcomeCredits > 0) {
        // Deduct from welcome credits
        const { error: rpcError } = await supabaseAdmin.rpc('decrement_welcome_credits', {
          user_id: userId,
          amount: 1
        });
        
        if (rpcError) {
          logger.warn({ message: 'Failed to deduct welcome credit via RPC', userId, error: rpcError });
          // Fallback to manual update
          const newWelcomeCredits = Math.max(0, welcomeCredits - 1);
          await supabaseAdmin
            .from('profiles')
            .update({ 
              welcome_credits: newWelcomeCredits,
              has_used_welcome_credits: newWelcomeCredits <= 0 ? true : undefined
            })
            .eq('id', userId);
        }
        logger.info({ message: 'Welcome credit used', userId, remainingWelcomeCredits: welcomeCredits - 1 });
      } else {
        // Deduct from regular voice credits
        const { error: rpcError } = await supabaseAdmin.rpc('decrement_voice_credits', {
          user_id: userId,
          amount: 1
        });
        
        if (rpcError) {
          logger.warn({ message: 'Failed to deduct voice credit via RPC', userId, error: rpcError });
          // Fallback to manual update
          const newCredits = Math.max(0, voiceCredits - 1);
          await supabaseAdmin
            .from('profiles')
            .update({ voice_credits: newCredits })
            .eq('id', userId);
        }
        logger.info({ message: 'Voice credit used', userId, remainingCredits: voiceCredits - 1 });
      }
    } catch (e) {
      logger.warn({ message: 'Failed to deduct credit', userId, error: (e as any)?.message });
    }

    // Stream PCM back to client with strict headers to avoid transformation
    res.setHeader('Content-Type', 'audio/pcm');
    res.setHeader('Accept-Ranges', 'none');
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('Content-Encoding', 'identity');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    let bytes = 0;
    pcmStream.on('data', (chunk: Buffer) => {
      bytes += chunk.length;
      res.write(chunk);
    });

    pcmStream.on('end', () => {
      logger.info({ message: 'Resemble TTS stream end', requestId, bytes });
      res.end();
    });

    pcmStream.on('error', (e: any) => {
      logger.error({ message: 'Error streaming Resemble PCM', requestId, error: e?.message || String(e) });
      try {
        if (!res.headersSent) {
          res.status(500).end();
        } else {
          res.end();
        }
      } catch {}
    });

    // Handle client disconnect
    req.on('close', () => {
      abortController.abort();
      pcmStream.destroy();
    });
  } catch (error: any) {
    logger.error({ message: 'Resemble PCM handler error', error: error?.message || String(error) });
    if (!res.headersSent) {
      res.status(500).json({ error: 'Internal Server Error' });
    }
  }
};

export {};
