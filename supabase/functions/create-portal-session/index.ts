// Supabase Edge Function: Create Stripe Billing Portal Session
// POST body (optional): { returnUrl?: string }

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@14.24.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_ANON_KEY = Deno.env.get("SUPABASE_ANON_KEY");
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_PORTAL_RETURN_URL = Deno.env.get("STRIPE_PORTAL_RETURN_URL") ?? "https://example.com/account";

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

    const { data: profile, error: profErr } = await supabase
      .from('profiles')
      .select('subscription_id')
      .eq('id', userId)
      .maybeSingle();
    if (profErr) throw profErr;
    if (!profile?.subscription_id) {
      return new Response(JSON.stringify({ error: "No active subscription" }), { status: 400, headers: { "Content-Type": "application/json", ...corsHeaders(req) } });
    }

    const stripe = new Stripe(STRIPE_SECRET_KEY, { apiVersion: '2023-10-16' });
    // Retrieve subscription to get customer id
    const sub = await stripe.subscriptions.retrieve(profile.subscription_id);
    const customerId = typeof sub.customer === 'string' ? sub.customer : sub.customer.id;

    const body = await req.json().catch(() => ({}));
    const returnUrl = (body.returnUrl as string | undefined) ?? STRIPE_PORTAL_RETURN_URL;

    const portal = await stripe.billingPortal.sessions.create({
      customer: customerId,
      return_url: returnUrl,
    });

    return new Response(JSON.stringify({ url: portal.url }), {
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


