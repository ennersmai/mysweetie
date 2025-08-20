// Supabase Edge Function: Create Stripe Checkout Session
// POST body (optional): { priceId?: string, tier?: 'basic' | 'premium', successUrl?: string, cancelUrl?: string }
// Uses env defaults when omitted.

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@14.24.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_PRICE_ID = Deno.env.get("STRIPE_PRICE_ID");
const STRIPE_PRICE_ID_BASIC = Deno.env.get("STRIPE_PRICE_ID_BASIC");
const STRIPE_PRICE_ID_PREMIUM = Deno.env.get("STRIPE_PRICE_ID_PREMIUM");
const STRIPE_SUCCESS_URL = Deno.env.get("STRIPE_SUCCESS_URL") ?? "https://mysweetie.ai/account";
const STRIPE_CANCEL_URL = Deno.env.get("STRIPE_CANCEL_URL") ?? "https://mysweetie.ai/subscribe";

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
    if (!STRIPE_SECRET_KEY) throw new Error("Missing STRIPE_SECRET_KEY");

    const authHeader = req.headers.get("Authorization");
    const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
      global: { headers: { Authorization: authHeader ?? "" } },
    });

    const { data: userData, error: userErr } = await supabase.auth.getUser();
    if (userErr || !userData.user) {
      return new Response(JSON.stringify({ error: "Unauthenticated" }), { status: 401, headers: { "Content-Type": "application/json", ...corsHeaders(req) } });
    }
    const userId = userData.user.id;

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: "2023-10-16" });
    const body = await req.json().catch(() => ({}));
    const tier = body.tier as ('basic' | 'premium' | undefined);
    let priceId = (body.priceId as string | undefined) ?? STRIPE_PRICE_ID;
    if (!priceId && tier === 'basic') priceId = STRIPE_PRICE_ID_BASIC ?? undefined;
    if (!priceId && tier === 'premium') priceId = STRIPE_PRICE_ID_PREMIUM ?? undefined;
    if (!priceId) throw new Error("Missing priceId");
    const successUrl = (body.successUrl as string | undefined) ?? STRIPE_SUCCESS_URL;
    const cancelUrl = (body.cancelUrl as string | undefined) ?? STRIPE_CANCEL_URL;

    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: priceId, quantity: 1 }],
      success_url: successUrl,
      cancel_url: cancelUrl,
      client_reference_id: userId,
      metadata: { user_id: userId, tier: tier ?? (priceId === STRIPE_PRICE_ID_PREMIUM ? 'premium' : (priceId === STRIPE_PRICE_ID_BASIC ? 'basic' : 'basic')) },
    });

    return new Response(JSON.stringify({ url: session.url }), {
      status: 200,
      headers: { "Content-Type": "application/json", ...corsHeaders(req) },
    });
  } catch (err) {
    console.error(err);
    return new Response(JSON.stringify({ error: String(err) }), {
      status: 500,
      headers: { "Content-Type": "application/json", ...corsHeaders(req) },
    });
  }
});


