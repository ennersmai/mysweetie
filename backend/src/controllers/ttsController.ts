import { Request, Response } from 'express';
import axios from 'axios';
import { logger } from '../utils/logger';
import { Readable } from 'stream';
import { supabaseAdmin } from '../config/database';
import { redis } from '../config/redis';
import { encode } from 'gpt-tokenizer';

const RIME_API_KEY = process.env.RIME_API_KEY || process.env.ARCANA_API_KEY || '';

const FREE_TTS_DAILY_LIMIT = Number(process.env.FREE_TTS_DAILY_LIMIT || 10);
const BASIC_TTS_MONTHLY_LIMIT = Number(process.env.BASIC_TTS_MONTHLY_LIMIT || 50);
const PREMIUM_TTS_MONTHLY_LIMIT = Number(process.env.PREMIUM_TTS_MONTHLY_LIMIT || 500);

function currentMonthUtc(): string {
  return new Date().toISOString().slice(0, 7); // Returns YYYY-MM format
}

export const handleArcanaPcm = async (req: Request, res: Response): Promise<void> => {
  try {
    const { text, speaker, modelId = 'arcana', samplingRate = 24000, lang = 'eng', repetition_penalty = 1.5, temperature = 0.5, top_p = 1, max_tokens = 1200 } = req.body || {};

    if (!text || !speaker) {
      res.status(400).json({ error: 'Both "text" and "speaker" are required.' });
      return;
    }
    if (!RIME_API_KEY) {
      res.status(500).json({ error: 'Missing RIME_API_KEY/ARCANA_API_KEY on server.' });
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
      .select('is_premium, plan_tier, voice_trials_used, voice_quota_used, voice_credits')
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

    // Check voice credits - all users now use the unified credits system
    const voiceCredits = Number(profile.voice_credits || 0);
    if (voiceCredits <= 0) {
      res.status(429).json({ 
        error: 'No voice credits remaining', 
        credits: voiceCredits,
        message: 'Purchase more voice credits to continue using voice features'
      });
      return;
    }

    const payload = {
      speaker,
      text,
      modelId,
      repetition_penalty,
      temperature,
      top_p,
      samplingRate,
      max_tokens,
      lang,
    };

    const upstream = await axios({
      method: 'POST',
      url: 'https://users.rime.ai/v1/rime-tts',
      headers: {
        Accept: 'audio/pcm',
        Authorization: `Bearer ${RIME_API_KEY}`,
        'Content-Type': 'application/json',
      },
      data: JSON.stringify(payload),
      responseType: 'stream',
      validateStatus: () => true,
      maxBodyLength: Infinity,
    });

    if (upstream.status !== 200) {
      let errText = '';
      const s = upstream.data as Readable | undefined;
      if (s && typeof (s as any).on === 'function') {
        errText = await new Promise<string>((resolve) => {
          let buf = '';
          s.on('data', (c: Buffer) => (buf += c.toString('utf8')));
          s.on('end', () => resolve(buf));
          s.on('error', () => resolve(buf));
        });
      }
      logger.error({ message: 'Arcana TTS non-200', status: upstream.status, body: errText.slice(0, 1000) });
      res.status(upstream.status).send(errText || 'Upstream error');
      return;
    }

    // On success: deduct one voice credit
    try {
      const newCredits = Math.max(0, voiceCredits - 1);
      await supabaseAdmin
        .from('profiles')
        .update({ voice_credits: newCredits })
        .eq('id', userId);
      
      logger.info({ message: 'Voice credit used', userId, remainingCredits: newCredits });
    } catch (e) {
      logger.warn({ message: 'Failed to deduct voice credit', userId, error: (e as any)?.message });
    }

    // Stream PCM back to client
    res.setHeader('Content-Type', 'audio/pcm');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    const stream = upstream.data as Readable;
    stream.on('data', (chunk: Buffer) => res.write(chunk));
    stream.on('end', () => res.end());
    stream.on('error', (e: any) => {
      logger.error({ message: 'Error proxying Arcana PCM', error: e?.message || String(e) });
      try { if (!res.headersSent) res.status(500).end(); else res.end(); } catch {}
    });
  } catch (error: any) {
    logger.error({ message: 'Arcana PCM handler error', error: error?.message || String(error) });
    if (!res.headersSent) res.status(500).json({ error: 'Internal Server Error' });
  }
};

export {};
