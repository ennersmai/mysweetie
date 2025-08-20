// Supabase Edge Function: Chat (LLM + optional Voice)
// POST body: { message: string, characterId: string, voice?: boolean }
// Streams OpenAI-compatible SSE from OpenRouter and persists messages at end.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

type ChatHistoryRow = {
  role: 'system' | 'user' | 'assistant';
  content: string;
  created_at: string;
};

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

const OPENROUTER_API_KEY = Deno.env.get("OPENROUTER_API_KEY");
const OPENROUTER_MODEL_FREE = Deno.env.get("OPENROUTER_MODEL_FREE") ?? "openai/gpt-3.5-turbo";
const OPENROUTER_MODEL_PREMIUM = Deno.env.get("OPENROUTER_MODEL_PREMIUM") ?? "openai/gpt-4o-mini";

const VOICE_PROVIDER = (Deno.env.get("VOICE_PROVIDER") ?? "").toLowerCase();
const ELEVENLABS_API_KEY = Deno.env.get("ELEVENLABS_API_KEY");
const ELEVENLABS_DEFAULT_VOICE_ID = Deno.env.get("ELEVENLABS_VOICE_ID");

function corsHeaders(req?: Request): HeadersInit {
  const reqHeaders = req?.headers.get('access-control-request-headers');
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": reqHeaders || "authorization, x-client-info, apikey, content-type",
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders(req) });
  }
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders(req) });
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error("Missing Supabase env");
    if (!OPENROUTER_API_KEY) throw new Error("Missing OPENROUTER_API_KEY");

    const authHeader = req.headers.get("Authorization");
    const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader ?? "" } },
    });
    const serviceClient = SUPABASE_SERVICE_ROLE_KEY
      ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY)
      : null;

    const { data: userData, error: userErr } = await anonClient.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "Unauthenticated" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders(req) } });
    }
    const userId = userData.user.id;

    const body = await req.json().catch(() => null);
    if (!body || typeof body.message !== "string" || typeof body.characterId !== "string") {
      return new Response(JSON.stringify({ error: "Invalid body" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(req) } });
    }
    const wantsVoice: boolean = Boolean(body.voice);
    const characterId: string = body.characterId;
    const conversationId: string | undefined = body.conversationId;
    const userMessage: string = body.message;
    const requestedModelKey: string | undefined = body.modelKey;
    const requestedVoiceKey: string | undefined = body.voiceKey;
    const fantasyMode: boolean = Boolean(body.fantasyMode);

    // Simple per-user rate limit: max 3 user messages per rolling minute
    const oneMinuteAgoIso = new Date(Date.now() - 60_000).toISOString();
    const { count: recentCount } = await anonClient
      .from("chat_history")
      .select("id", { count: 'exact', head: true })
      .eq("user_id", userId)
      .eq("role", "user")
      .gte("created_at", oneMinuteAgoIso);
    if ((recentCount ?? 0) >= 3) {
      return new Response(
        JSON.stringify({ error: "rate_limited", message: "You’re sending messages a bit too quickly. Take a breath, and try again in a moment." }),
        { status: 429, headers: { "Content-Type": "application/json", ...corsHeaders(req) } }
      );
    }

    // Load character
    const { data: character, error: charErr } = await anonClient
      .from("characters")
      .select("id, name, system_prompt, voice_id")
      .eq("id", characterId)
      .maybeSingle();
    if (charErr || !character) throw new Error("Character not found");

    // Load user profile (RLS allows only own)
    const { data: profile, error: profErr } = await anonClient
      .from("profiles")
      .select("is_premium, voice_trials_used, plan_tier, voice_quota_used")
      .eq("id", userId)
      .maybeSingle();
    if (profErr) throw profErr;
    const isPremium = Boolean(profile?.is_premium);
    const voiceTrialsUsed = Number(profile?.voice_trials_used ?? 0);
    const planTier = String(profile?.plan_tier ?? 'free');
    const voiceQuotaUsed = Number(profile?.voice_quota_used ?? 0);

    // Load last N messages
    // Conversation context length based on tier
    const N = planTier === 'premium' ? 40 : planTier === 'basic' ? 20 : 10;
    let historyQuery = anonClient
      .from("chat_history")
      .select("role, content, created_at")
      .eq("user_id", userId)
      .eq("character_id", characterId);
    
    // If conversation_id is provided, filter by it; otherwise get all for this character
    if (conversationId) {
      historyQuery = historyQuery.eq("conversation_id", conversationId);
    }
    
    const { data: history, error: histErr } = await historyQuery
      .order("created_at", { ascending: true })
      .limit(N);
    if (histErr) throw histErr;

    // Fantasy mode: premium users can enable explicit flirty style
    let systemPrompt = String(character.system_prompt ?? "");
    if (isPremium && fantasyMode) {
      const FANTASY_MODE_PROMPT = "When responding, adopt an extra flirty, playful, seductive tone while staying respectful, consensual, and within platform safety. Use evocative, romantic language and be attentive to the user's desires.";
      systemPrompt += `\n\n${FANTASY_MODE_PROMPT}`;
    }
    if (isPremium) {
      const { data: triggers } = await anonClient
        .from("trigger_phrases")
        .select("phrase, prompt_delta, is_active")
        .eq("is_active", true);
      const lower = userMessage.toLowerCase();
      triggers?.forEach((t) => {
        if (t.phrase && lower.includes(t.phrase.toLowerCase())) {
          systemPrompt += `\n\n${t.prompt_delta}`;
        }
      });
    }

    // Build messages for LLM
    const messages = [
      { role: "system", content: systemPrompt },
      ...((history ?? []) as ChatHistoryRow[]).map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: userMessage },
    ];

    const MODEL_MAP: Record<string, string> = {
      'Dolphin Venice': 'openai/gpt-4o-mini',
      'Swift Muse': 'microsoft/wizardlm-2-8x22b',
      'Crystal Focus': 'anthropic/claude-3.5-sonnet',
      'Velvet Intellect': 'gryphe/mythomax-l2-13b',
      'Midnight Nova': 'meta-llama/llama-3.1-8b-instruct',
      'Silver Whisper': 'cohere/command-r-plus',
    };
    const model = MODEL_MAP[requestedModelKey ?? ''] || (isPremium ? OPENROUTER_MODEL_PREMIUM : OPENROUTER_MODEL_FREE);
    // Request streaming completion from OpenRouter
    const orRes = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model, messages, temperature: 0.8, stream: true }),
    });
    if (!orRes.ok || !orRes.body) {
      const txt = await orRes.text().catch(() => '');
      throw new Error(`OpenRouter error: ${txt}`);
    }

    const encoder = new TextEncoder();
    const decoder = new TextDecoder();
    let accumulated = '';
    let buffer = '';
    let sentenceBuffer = '';
    let ttsQueue: string[] = [];

    let voiceCounted = false;
    let streamClosed = false;
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    
    async function processTTSQueue() {
      if (streamClosed || !controller) return; // Don't process if stream is closed
      if (!(wantsVoice && VOICE_PROVIDER === 'elevenlabs' && ELEVENLABS_API_KEY)) return;
      if (!isPremium && voiceTrialsUsed >= 3) return; // free trials
      if (planTier === 'basic' && voiceQuotaUsed >= 50) return; // basic quota limit
      if (planTier === 'premium' && voiceQuotaUsed >= 500) return; // premium quota limit
      
      const VOICE_MAP: Record<string, string | undefined> = {
        'Aria Velvet': 'wrxvN1LZJIfL3HHvffqe',
        'Nova Azure': 'EXAVITQu4vr4xnSDxMaL',
        'Mira Whisper': '21m00Tcm4TlvDq8ikWAM',
        'Zara Ember': '4tRn1lSkEn13EVTuqb0g',
        'Luna Aurora': 'gE0owC0H9C8SzfDyIUtB',
      };
      const selectedVoiceId = VOICE_MAP[requestedVoiceKey ?? ''] || character.voice_id || ELEVENLABS_DEFAULT_VOICE_ID;
      if (!selectedVoiceId) return;
      
      // Process one chunk at a time to allow multiple concurrent requests
      const text = ttsQueue.shift();
      if (!text?.trim() || streamClosed || !controller) return;
      
      console.log(`Processing TTS for: "${text.substring(0, 50)}..." (Remaining in queue: ${ttsQueue.length})`);
      
      try {
        const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${selectedVoiceId}/stream`, {
          method: 'POST',
          headers: {
            'xi-api-key': ELEVENLABS_API_KEY,
            'Content-Type': 'application/json',
            'Accept': 'audio/mpeg',
          },
          body: JSON.stringify({ text }),
        });
        
        if (ttsRes.ok && !streamClosed && controller) {
          const buf = await ttsRes.arrayBuffer();
          if (streamClosed || !controller) return; // Check again after async operation
          
          const bytes = new Uint8Array(buf);
          let binary = '';
          for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
          const audioBase64 = `data:audio/mpeg;base64,${btoa(binary)}`;
          const payload = JSON.stringify({ audioBase64 });
          
          try {
            if (!streamClosed && controller) {
              controller.enqueue(encoder.encode(`event: audio\n` + `data: ${payload}\n\n`));
              console.log(`Sent audio chunk to client. Queue remaining: ${ttsQueue.length}`);
            }
          } catch (e) {
            console.error('Stream enqueue failed (likely closed):', e);
            streamClosed = true;
            return;
          }
          
          if (!voiceCounted && serviceClient) {
            voiceCounted = true;
            if (!isPremium) {
              await serviceClient.from('profiles').update({ voice_trials_used: voiceTrialsUsed + 1 }).eq('id', userId);
            } else if (planTier === 'basic') {
              await serviceClient.from('profiles').update({ voice_quota_used: voiceQuotaUsed + 1 }).eq('id', userId);
            } else if (planTier === 'premium') {
              await serviceClient.from('profiles').update({ voice_quota_used: voiceQuotaUsed + 1 }).eq('id', userId);
            }
          }
        }
      } catch (e) {
        console.error('TTS chunk error', e);
      }
      
      // Continue processing remaining chunks
      if (ttsQueue.length > 0 && !streamClosed && controller) {
        // Use setTimeout to avoid blocking and allow other async operations
        setTimeout(() => processTTSQueue(), 10);
      }
    }

    function maybeEnqueueSentenceTTS() {
      // More aggressive chunking: send TTS requests faster for better responsiveness
      const boundary = /[\.!?…]+["')\]]?\s$/;
      const hasWords = /\s+/.test(sentenceBuffer); // Has at least one space (word boundary)
      
      // Send TTS if: sentence boundary, chunk is getting long, or we have a few words
      if (boundary.test(sentenceBuffer) || sentenceBuffer.length > 120 || (hasWords && sentenceBuffer.length > 40)) {
        ttsQueue.push(sentenceBuffer);
        console.log(`Added TTS chunk to queue: "${sentenceBuffer.substring(0, 50)}..." (Queue size: ${ttsQueue.length})`);
        sentenceBuffer = '';
        
        // Start processing immediately without blocking
        if (!streamClosed && controller) {
          processTTSQueue().catch(e => console.error('TTS processing error:', e));
        }
      }
    }

    const stream = new ReadableStream<Uint8Array>({
      async start(ctrl) {
        controller = ctrl; // Store controller reference for TTS
        const enqueue = (chunk: Uint8Array) => controller.enqueue(chunk);
        // Emit an initial event to signal start
        enqueue(encoder.encode('event: start\n' + 'data: {}\n\n'));
        const reader = orRes.body!.getReader();
        try {
          while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            if (value) {
              const chunkText = decoder.decode(value, { stream: true });
              buffer += chunkText;
              const parts = buffer.split('\n\n');
              buffer = parts.pop() ?? '';
              for (const part of parts) {
                const lines = part.split('\n');
                const dataLine = lines.find((l) => l.startsWith('data:'));
                if (!dataLine) continue;
                const data = dataLine.slice(5).trim();
                if (data === '[DONE]') continue;
                try {
                  const json = JSON.parse(data);
                  const delta = json.choices?.[0]?.delta?.content ?? '';
                  if (delta) {
                    accumulated += delta;
                    sentenceBuffer += delta;
                    // Emit token event to client
                    enqueue(encoder.encode(`event: token\n` + `data: ${JSON.stringify({ delta })}\n\n`));
                    // Try to enqueue a sentence for TTS
                    maybeEnqueueSentenceTTS();
                  }
                } catch (_) {
                  // ignore parse errors
                }
              }
            }
          }
        } finally {
          // Flush leftover sentence to TTS before closing
          if (sentenceBuffer.trim() && !streamClosed && controller) {
            ttsQueue.push(sentenceBuffer);
            console.log(`Added final TTS chunk: "${sentenceBuffer.substring(0, 50)}..." (Final queue size: ${ttsQueue.length})`);
            sentenceBuffer = '';
            // Process final chunks
            try {
              await processTTSQueue();
            } catch (e) {
              console.error('Final TTS processing error:', e);
            }
          }
          
          console.log(`Stream ending. TTS queue size: ${ttsQueue.length}`);
          
          // Allow some time for final TTS processing before closing
          if (ttsQueue.length > 0 && !streamClosed && controller) {
            let attempts = 0;
            while (ttsQueue.length > 0 && attempts < 10 && !streamClosed && controller) {
              console.log(`Waiting for TTS queue to finish. Remaining: ${ttsQueue.length}, attempt: ${attempts + 1}`);
              await new Promise(resolve => setTimeout(resolve, 500));
              attempts++;
            }
          }
          
          // Mark stream as closed to prevent further TTS processing
          streamClosed = true;
          
          // Persist user + assistant messages once stream ends
          if (accumulated) {
            const insertData = [
              { user_id: userId, character_id: characterId, conversation_id: conversationId, role: 'user', content: userMessage },
              { user_id: userId, character_id: characterId, conversation_id: conversationId, role: 'assistant', content: accumulated },
            ];
            const { error: insErr } = await anonClient.from('chat_history').insert(insertData);
            if (insErr) console.error('Persist error', insErr);
            
            // Update conversation timestamp if conversationId exists
            if (conversationId && serviceClient) {
              await serviceClient.from('conversations').update({ updated_at: new Date().toISOString() }).eq('id', conversationId);
            }
          }
          
          // Emit end event and close controller
          try {
            if (controller) {
              enqueue(encoder.encode('event: end\n' + 'data: {}\n\n'));
              controller.close();
              controller = null; // Clear reference
            }
          } catch (e) {
            console.error('Error closing stream:', e);
          }
        }
      },
    });

    return new Response(stream, {
      status: 200,
      headers: {
        ...corsHeaders(req),
        'Content-Type': 'text/event-stream; charset=utf-8',
        'Cache-Control': 'no-cache, no-transform',
        'Connection': 'keep-alive',
      },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders(req) },
    });
  }
});


