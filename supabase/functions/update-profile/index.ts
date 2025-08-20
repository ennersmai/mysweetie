import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");

function corsHeaders(req?: Request): HeadersInit {
  const reqHeaders = req?.headers.get('access-control-request-headers');
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "POST, OPTIONS",
    "Access-Control-Allow-Headers": reqHeaders || "authorization, x-client-info, apikey, content-type",
  };
}

serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders(req) });
  if (req.method !== 'POST') return new Response('Method Not Allowed', { status: 405, headers: corsHeaders(req) });
  try {
    if (!SUPABASE_URL || !SUPABASE_ANON_KEY || !SUPABASE_SERVICE_ROLE_KEY) throw new Error('Missing env');
    const anon = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, { global: { headers: { Authorization: req.headers.get('Authorization') ?? '' } } });
    const svc = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

    const { data: userRes, error: userErr } = await anon.auth.getUser();
    if (userErr || !userRes.user) return new Response(JSON.stringify({ error: 'Unauthenticated' }), { status: 401, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } });
    const userId = userRes.user.id;

    const body = await req.json().catch(() => null) as { display_name?: string } | null;
    const displayName = (body?.display_name ?? '').toString().trim();
    if (!displayName || displayName.length > 64) {
      return new Response(JSON.stringify({ error: 'Invalid display name' }), { status: 400, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } });
    }

    const { error: upErr } = await svc.from('profiles').update({ display_name: displayName }).eq('id', userId);
    if (upErr) throw upErr;

    return new Response(JSON.stringify({ ok: true, display_name: displayName }), { status: 200, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), { status: 500, headers: { 'Content-Type': 'application/json', ...corsHeaders(req) } });
  }
});


