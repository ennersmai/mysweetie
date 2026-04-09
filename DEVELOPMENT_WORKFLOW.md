# Development Workflow Guide

## 🎯 Problem Solved

You can now test the **voice call functionality** locally without having Stripe configured, then deploy and configure Stripe later.

## 🚀 Step-by-Step Development Process

### Phase 1: Local Development (Voice Calls Testing) ✅

1. **Create your local `.env` file** (copy from `env.development.example`):
   ```bash
   cd backend
   cp env.development.example .env
   ```

2. **Fill in non-Stripe environment variables**:
   ```bash
   # Required for voice calls
   SUPABASE_URL=your_supabase_url
   SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
   GROQ_API_KEY=your_groq_api_key
   RIME_API_KEY=your_rime_api_key
   OPENROUTER_API_KEY=your_openrouter_api_key
   
   # Leave Stripe variables commented out
   # STRIPE_SECRET_KEY=...
   # STRIPE_WEBHOOK_SECRET=...
   ```

3. **Test voice calls locally**:
   ```bash
   # Backend
   cd backend && npm run dev
   
   # Frontend
   cd web && npm run dev
   ```

4. **What works without Stripe**:
   - ✅ Voice calls (real-time voice conversations)
   - ✅ Text chat with AI
   - ✅ TTS voice messages
   - ✅ All existing functionality
   
5. **What shows friendly errors without Stripe**:
   - ❌ Subscription purchases → "Payment system not available in development mode"
   - ❌ Voice credits top-up → "Payment system not available in development mode"
   - ❌ Manage subscription → "Payment system not available in development mode"

### Phase 2: Deploy Backend to Vercel

1. **Deploy without Stripe first**:
   ```bash
   cd backend
   vercel --prod
   ```

2. **Get your temporary Vercel URL**:
   ```
   https://mysweetie-backend-abc123.vercel.app
   ```

3. **Add environment variables in Vercel Dashboard**:
   - All the non-Stripe variables from your local `.env`
   - Still **skip Stripe variables** for now

### Phase 3: Configure Stripe

1. **Create Stripe products** (as per STRIPE_CONFIGURATION.md)
2. **Create webhook endpoint** in Stripe with your Vercel URL:
   ```
   https://mysweetie-backend-abc123.vercel.app/api/stripe/webhook
   ```
3. **Add Stripe environment variables** to Vercel Dashboard:
   ```bash
   STRIPE_SECRET_KEY=sk_test_...
   STRIPE_WEBHOOK_SECRET=whsec_...
   STRIPE_BASIC_PRICE_ID=price_...
   STRIPE_PREMIUM_PRICE_ID=price_...
   STRIPE_VOICE_CREDITS_PRICE_ID=price_...
   ```

### Phase 4: Custom Domain (Final)

1. **Configure custom domain** in Vercel: `api.mysweetie.ai`
2. **Update Stripe webhook URL**:
   ```
   https://api.mysweetie.ai/api/stripe/webhook
   ```

## 🧪 Testing Strategy

### Local Testing (Phase 1)
- ✅ Test voice calls extensively
- ✅ Test all chat functionality
- ❌ Skip payment testing (shows friendly errors)

### Vercel Testing (Phase 3)
- ✅ Test voice calls on deployed backend
- ✅ Test payment flows with Stripe test cards
- ✅ Test webhook delivery

### Production Testing (Phase 4)
- ✅ Test with custom domain
- ✅ Test live payments (small amounts first)

## 🔍 Development Tips

### Voice Call Testing Checklist
- [ ] Click "Call" button in chat
- [ ] Allow microphone permissions
- [ ] Speak and verify transcription appears
- [ ] Verify AI responds with voice
- [ ] Test interruption (speak while AI is talking)
- [ ] Check browser console for debug messages

### Payment Testing Checklist (After Stripe setup)
- [ ] Subscribe to Basic plan: `4242 4242 4242 4242`
- [ ] Buy voice credits: `4242 4242 4242 4242`
- [ ] Check account page updates
- [ ] Test manage subscription portal

## 🚨 Common Issues & Solutions

**"Missing environment variables"** → Use `env.development.example` as template

**"Voice call button doesn't work"** → Check GROQ_API_KEY and RIME_API_KEY are set

**"Payment system not available"** → Expected in development, deploy first

**"Webhook not working"** → Deploy backend first, then configure webhook URL

## 📞 Next Steps

You can now:
1. **Start developing immediately** with voice calls working
2. **Deploy when ready** without pressure to configure Stripe first
3. **Add Stripe later** when you're ready to test payments

The voice call functionality is completely independent of Stripe and will work perfectly for development and testing!
