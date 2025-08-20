## POC Task List: Premium AI Companion Chat Platform

Covers MVP features F-01–F-09 and F-10–F-12 per `PRD final.md`. Sequenced, dependency-aware tasks with acceptance criteria.

### 0) Admin & Accounts (External)
- **Actions**:
  - Create/provide accounts and API keys: Supabase, Vercel, Stripe, OpenRouter, and one voice provider (ElevenLabs or PlayHT).
  - Sign NDA; fund POC escrow.
- **Acceptance**: All credentials available and verified via a trivial API call or dashboard access.

### 1) Project Bootstrap
- **Actions**:
  - Initialize repo with Vite + React + TypeScript + Tailwind structure.
  - Create Supabase project; enable Auth; create Storage buckets: `avatars`, `galleries`.
  - Create Vercel project; link Git repository for CI/CD.
- **Acceptance**: Frontend hello-world deploys on Vercel; Supabase SDK connects (client ping/health check).

### 2) Environment Variables
- **Actions**: Configure in Vercel (Preview/Prod) and local `.env` files.
  - `VITE_SUPABASE_URL`
  - `VITE_SUPABASE_ANON_KEY`
  - `SUPABASE_SERVICE_ROLE_KEY`
  - `OPENROUTER_API_KEY`
  - `STRIPE_SECRET_KEY`
  - `STRIPE_PRICE_ID`
  - `STRIPE_WEBHOOK_SECRET`
  - `VOICE_PROVIDER` ("elevenlabs" | "playht")
  - `ELEVENLABS_API_KEY` or `PLAYHT_API_KEY`
- **Acceptance**: A simple edge endpoint returns 200 and can read these variables.

### 3) Database Schema (Supabase)
- **Tables**:
  - `profiles`: `id (uuid, pk)`, `is_premium (bool)`, `subscription_id (text)`, `display_name (text)`.
  - `characters`: `id (uuid, pk)`, `name (text)`, `description (text)`, `avatar_url (text)`, `system_prompt (text)`, `voice_id (text)`.
  - `chat_history`: `id (uuid, pk)`, `user_id (uuid, fk)`, `character_id (uuid, fk)`, `role (text)`, `content (text)`, `created_at (timestamptz)`.
  - `character_galleries`: `id`, `character_id`, `image_path (text)`, `caption (text)`, `is_preview (bool)`.
  - `trigger_phrases`: `id`, `phrase (text)`, `prompt_delta (text)`, `is_active (bool)`.
- **RLS**:
  - `profiles`: user can read own; service role can update `is_premium`, `subscription_id`.
  - `chat_history`: user can read/write own rows.
  - `characters`, `character_galleries`, `trigger_phrases`: read-all; writes limited to service role.
- **Seed**:
  - At least 3 characters with avatars/prompts; sample galleries (2–3 images each; one marked preview).
- **Acceptance**: Client can read characters; authenticated user can read/write own history; policies verified.

### 4) Supabase Edge Functions
- `chat` (F-04, F-05, F-06, F-10, F-11)
  - Input: `user_id`, `character_id`, `message`, `voice:boolean`.
  - Flow: fetch character + premium status → pull last N messages → apply premium-only triggers → build prompt → call OpenRouter → persist user/assistant turns → optional TTS → return `{ text, audioUrl? }`.
  - Enforce freemium (e.g., fantasy mode, higher-tier LLM, voice limits).
  - Acceptance: Returns assistant text; persists history; premium gates respected; optional audio returned.
- `create-checkout-session` (F-07)
  - Creates Stripe Checkout for recurring `STRIPE_PRICE_ID`; returns redirect URL.
  - Acceptance: Session URL returned; visible in Stripe.
- `stripe-webhook` (F-07)
  - Handle `checkout.session.completed`, `customer.subscription.updated|deleted`; verify signature; update `profiles.is_premium`, `subscription_id` idempotently.
  - Acceptance: Premium status updates within seconds post-checkout/cancel.
- `get-gallery` (F-08)
  - Returns signed URLs: previews for free users, full-res for premium.
  - Acceptance: Correct assets returned based on premium status.

### 5) Frontend: Auth & Layout (F-01, F-09)
- **Actions**:
  - Integrate Supabase Auth (email/password); login, signup, logout.
  - App shell: header with auth state; responsive layout with Tailwind.
- **Acceptance**: Auth flows work across desktop/mobile; session persistence verified.

### 6) Frontend: Character Selection (F-02)
- **Actions**: Grid/list of `characters`; choose to start/continue conversation.
- **Acceptance**: Loads from DB; navigates to chat view.

### 7) Frontend: Chat Interface (F-03, F-04, F-05, F-10, F-11)
- **Actions**:
  - Message list with roles; input composer; optimistic send; loading indicators.
  - Voice toggle (user-initiated); auto-play audio when enabled.
  - If premium, allow fantasy trigger phrases; otherwise show upgrade CTA.
- **Acceptance**: Smooth send/receive; audio plays when enabled; last N messages loaded per character.

### 8) Freemium Paywall UX (F-06)
- **Actions**: Lock premium features (fantasy mode, higher-tier LLM, unlimited TTS) with clear upgrade prompts.
- **Acceptance**: Free users see gates; premium users access features without friction.

### 9) Subscription Flow (F-07)
- **Actions**:
  - Upgrade page with plan details; subscribe → calls `create-checkout-session`.
  - Return URL page reads premium status; shows success; handles pending states.
- **Acceptance**: Completing Stripe Checkout upgrades account; DB reflects status; UI updates accordingly.

### 10) Locked Content Gallery (F-08)
- **Actions**:
  - Character gallery page using `get-gallery` for signed URLs.
  - Previews (blur/watermark) for free; full-res modal for premium.
- **Acceptance**: Correct visibility for free vs premium users.

### 11) Voice Provider Integration (F-05)
- **Actions**:
  - Pick provider (ElevenLabs or PlayHT) based on cost/quality.
  - Implement provider interface in `chat` function; return URL/base64.
- **Acceptance**: TTS latency ~2–4s for ~150–250 tokens; graceful fallback to text-only on errors.

### 12) Admin Ops for Characters (F-12)
- **Actions**: Docs/seed scripts for adding `characters` via Supabase dashboard/SQL; upload avatars to Storage.
- **Acceptance**: Adding a row makes a character live without code changes.

### 13) Quality, Observability, Hardening
- **Actions**: Error handling, structured logs; retry transient errors; minimal analytics (counts for chats/conversions).
- **Acceptance**: No silent failures; basic metrics available; rate-limit protections present.

### 14) Final QA & Deploy
- **Actions**: Cross-device responsive checks; accessibility basics; verify RLS with test users; live webhook tests on staging.
- **Acceptance**: End-to-end paths pass: signup → select character → chat → upgrade → fantasy + voice → gallery full-res.

---

### Minimal Acceptance Demo Script
1) Sign up and log in.
2) Pick a character; send/receive messages.
3) Enable voice; hear playback after user click.
4) Try fantasy trigger as free user → see upgrade CTA.
5) Subscribe via Stripe → redirected back; status becomes premium.
6) Use fantasy trigger again → behavior changes accordingly.
7) Open gallery: previews pre-upgrade; full-res post-upgrade.

### Key Risks/Dependencies
- **Public URL for webhooks**: Use staging/Vercel for Stripe webhook tests.
- **Voice latency/cost**: Decide provider early; consider caching short clips.
- **RLS configuration**: Validate policies thoroughly to avoid blocked reads/writes.

### Immediate Next Steps (Build Plan)
- Scaffold frontend (Vite + React + TS) and Tailwind.
- Prepare Supabase project (Auth, Storage, schema, RLS).
- Implement `chat`, `create-checkout-session`, `stripe-webhook`, `get-gallery` functions.
- Wire auth, character selection, chat UI; add paywall and subscription flow.


