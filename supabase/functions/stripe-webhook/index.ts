// Supabase Edge Function: Stripe Webhook
// Endpoint: https://<PROJECT-REF>.functions.supabase.co/stripe-webhook

import { serve } from "https://deno.land/std@0.177.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import Stripe from "npm:stripe@14.24.0";

const SUPABASE_URL = Deno.env.get("SUPABASE_URL");
const SUPABASE_SERVICE_ROLE_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
const STRIPE_SECRET_KEY = Deno.env.get("STRIPE_SECRET_KEY");
const STRIPE_WEBHOOK_SECRET = Deno.env.get("STRIPE_WEBHOOK_SECRET");

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Missing Supabase env vars");
}
if (!STRIPE_SECRET_KEY || !STRIPE_WEBHOOK_SECRET) {
  console.error("Missing Stripe env vars");
}

const supabase = createClient(SUPABASE_URL!, SUPABASE_SERVICE_ROLE_KEY!);
const stripe = new Stripe(STRIPE_SECRET_KEY || "", {
  apiVersion: "2023-10-16",
});

serve(async (req) => {
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  const signature = req.headers.get("stripe-signature");
  if (!signature || !STRIPE_WEBHOOK_SECRET) {
    return new Response("Missing signature", { status: 400 });
  }

  // Read raw body (important for signature verification)
  const body = await req.text();

  let event: Stripe.Event;
  try {
    event = await stripe.webhooks.constructEventAsync(body, signature, STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error("Webhook signature verification failed", err);
    return new Response("Bad Request", { status: 400 });
  }

  try {
    switch (event.type) {
      case "checkout.session.completed": {
        const session = event.data.object as Stripe.Checkout.Session;
        // Expect one of these identifiers to link back to Supabase user
        const userId = (session.client_reference_id || session.metadata?.user_id) as string | undefined;
        const subscriptionId = (typeof session.subscription === "string" ? session.subscription : session.subscription?.id) as string | undefined;
        const tier = (session.metadata?.tier as string | undefined) ?? 'basic';

        if (!userId) {
          console.warn("checkout.session.completed without user identifier");
          break;
        }

        if (subscriptionId) {
          const { error } = await supabase
            .from("profiles")
            .update({ is_premium: true, subscription_id: subscriptionId, plan_tier: tier })
            .eq("id", userId);
          if (error) throw error;
        }
        break;
      }
      case "customer.subscription.updated":
      case "customer.subscription.deleted": {
        const subscription = event.data.object as Stripe.Subscription;
        const status = subscription.status;
        const subscriptionId = subscription.id;
        const isActive = status === "active" || status === "trialing";
        const plan = (subscription.items?.data?.[0]?.price?.nickname || subscription.items?.data?.[0]?.price?.metadata?.tier) as string | undefined;
        const tier = plan?.toLowerCase().includes('premium') ? 'premium' : (plan?.toLowerCase().includes('basic') ? 'basic' : undefined);

        const { error } = await supabase
          .from("profiles")
          .update({ is_premium: isActive, plan_tier: tier ?? (isActive ? 'basic' : 'free') })
          .eq("subscription_id", subscriptionId);
        if (error) throw error;
        break;
      }
      default: {
        // Ignore other events for now
        break;
      }
    }
  } catch (err) {
    console.error("Error handling event", event?.type, err);
    // Respond 200 to avoid repeated retries if the failure is non-recoverable,
    // but log for investigation. Adjust to 500 if you want Stripe to retry.
    return new Response("ok", { status: 200 });
  }

  return new Response("ok", { status: 200 });
});


