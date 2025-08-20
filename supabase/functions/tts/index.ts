// Supabase Edge Function: TTS replay for a single message
// POST body: { text: string, voiceKey?: string, characterId?: string }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
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
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== "POST") return new Response("Method Not Allowed", { status: 405, headers: corsHeaders(req) });

  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error("Missing Supabase env");
    if (VOICE_PROVIDER !== 'elevenlabs' || !ELEVENLABS_API_KEY) throw new Error("TTS not configured");

    const authHeader = req.headers.get("Authorization");
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: authHeader ?? "" } } });
    const serviceClient = SUPABASE_SERVICE_ROLE_KEY ? createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY) : null;

    const { data: u, error: uErr } = await supabase.auth.getUser();
    if (uErr || !u.user) return new Response(JSON.stringify({ error: 'Unauthenticated' }), { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } });
    const userId = u.user.id;

    const body = await req.json().catch(() => null) as { text?: string; voiceKey?: string; characterId?: string } | null;
    if (!body?.text) return new Response(JSON.stringify({ error: 'text required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } });

    // Load profile for quota
    const { data: profile } = await supabase
      .from('profiles')
      .select('is_premium, plan_tier, voice_trials_used, voice_quota_used')
      .eq('id', userId)
      .maybeSingle();

    const premium = Boolean(profile?.is_premium);
    const tier = (profile?.plan_tier as string | undefined) ?? (premium ? 'basic' : 'free');
    const trials = Number((profile as any)?.voice_trials_used ?? 0);
    const quota = Number((profile as any)?.voice_quota_used ?? 0);
    if (!premium && trials >= 3) return new Response(JSON.stringify({ error: 'Voice limit reached' }), { status: 402, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } });
    if (tier === 'basic' && quota >= 50) return new Response(JSON.stringify({ error: 'Voice limit reached' }), { status: 402, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } });
    if (tier === 'premium' && quota >= 500) return new Response(JSON.stringify({ error: 'Voice limit reached' }), { status: 402, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } });

    // Optionally read character-specific default
    let characterVoiceId: string | undefined;
    if (body.characterId) {
      const { data: ch } = await supabase.from('characters').select('voice_id').eq('id', body.characterId).maybeSingle();
      characterVoiceId = (ch as any)?.voice_id as string | undefined;
    }

    const VOICE_MAP: Record<string, string | undefined> = {
      'Aria Velvet': 'wrxvN1LZJIfL3HHvffqe',
      'Nova Azure': 'EXAVITQu4vr4xnSDxMaL',
      'Mira Whisper': '21m00Tcm4TlvDq8ikWAM',
      'Zara Ember': '4tRn1lSkEn13EVTuqb0g',
      'Luna Aurora': 'gE0owC0H9C8SzfDyIUtB',
    };
    const selectedVoiceId = VOICE_MAP[body.voiceKey ?? ''] || characterVoiceId || ELEVENLABS_DEFAULT_VOICE_ID;
    if (!selectedVoiceId) return new Response(JSON.stringify({ error: 'No voice configured' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } });

    const ttsRes = await fetch(`https://api.elevenlabs.io/v1/text-to-speech/${selectedVoiceId}/stream`, {
      method: 'POST',
      headers: { 'xi-api-key': ELEVENLABS_API_KEY, 'Content-Type': 'application/json', 'Accept': 'audio/mpeg' },
      body: JSON.stringify({ text: body.text }),
    });
    if (!ttsRes.ok) return new Response(JSON.stringify({ error: 'TTS failed' }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } });

    const buf = await ttsRes.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = '';
    for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
    const audioBase64 = `data:audio/mpeg;base64,${btoa(binary)}`;

    // Increment counters
    let newTrials = trials;
    let newQuota = quota;
    if (serviceClient) {
      if (!premium) {
        newTrials = trials + 1;
        await serviceClient.from('profiles').update({ voice_trials_used: newTrials }).eq('id', userId);
      } else {
        newQuota = quota + 1;
        await serviceClient.from('profiles').update({ voice_quota_used: newQuota }).eq('id', userId);
      }
    }
    const maxAllowed = !premium ? 3 : (tier === 'basic' ? 50 : 500);
    const used = !premium ? newTrials : newQuota;
    const remaining = Math.max(0, maxAllowed - used);

    return new Response(JSON.stringify({ audioBase64, remaining }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } });
  }
});


