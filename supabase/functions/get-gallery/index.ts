// Supabase Edge Function: Get Gallery (signed URLs, gated by premium)
// GET params: characterId=<uuid>

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");

function corsHeaders(): HeadersInit {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  };
}

serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }
  if (req.method !== "GET") {
    return new Response("Method Not Allowed", { status: 405, headers: corsHeaders() });
  }

  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY) throw new Error("Missing Supabase env");
    const url = new URL(req.url);
    const characterId = url.searchParams.get('characterId');
    if (!characterId) return new Response(JSON.stringify({ error: 'characterId required' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders() } });

    const authHeader = req.headers.get("Authorization");
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader ?? "" } },
    });

    const { data: userData } = await supabase.auth.getUser();
    const userId = userData.user?.id;

    let isPremium = false;
    if (userId) {
      const { data: prof } = await supabase.from('profiles').select('is_premium').eq('id', userId).maybeSingle();
      isPremium = Boolean(prof?.is_premium);
    }

    const { data: items, error } = await supabase
      .from('character_galleries')
      .select('image_path, caption, is_preview')
      .eq('character_id', characterId)
      .order('created_at', { ascending: true });
    if (error) throw error;

    // Build signed URLs
    const signed = await Promise.all((items ?? []).map(async (it) => {
      // If not premium and not preview, skip or return placeholder
      if (!isPremium && !it.is_preview) {
        return { url: null, caption: it.caption, is_preview: it.is_preview };
      }
      const { data: s } = await supabase.storage.from('galleries').createSignedUrl(it.image_path, 60 * 5);
      return { url: s?.signedUrl ?? null, caption: it.caption, is_preview: it.is_preview };
    }));

    return new Response(JSON.stringify({ items: signed, isPremium }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders() },
    });
  }
});


