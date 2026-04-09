-- Add stripe_customer_id column to profiles for Stripe integration
alter table public.profiles
  add column if not exists stripe_customer_id text unique;
