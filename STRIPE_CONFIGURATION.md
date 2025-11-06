# Stripe Configuration Guide

## 🎯 Overview

This guide covers setting up Stripe for the MySweetie.AI Node.js backend, including products, webhooks, and API keys.

## 📋 Prerequisites

- Stripe account (test and live modes)
- Backend deployed and accessible
- Admin access to Stripe Dashboard

## 🔧 1. Stripe Products Setup

### A. Subscription Products

#### Basic Plan ($9.99/month)
```
Product Name: MySweetie.AI Basic Plan
Price: $9.99 USD
Billing: Monthly recurring
Features:
- 50 voice credits per month
- Basic AI models
- Standard support
```

#### Premium Plan ($19.99/month)  
```
Product Name: MySweetie.AI Premium Plan
Price: $19.99 USD
Billing: Monthly recurring
Features:
- 500 voice credits per month
- Premium AI models
- Priority support
- NSFW content access
```

### B. One-time Products

#### Voice Credits Top-up
```
Product Name: Voice Credits Top-up
Price: $9.99 USD
Billing: One-time payment
Metadata:
- credits: 200
- type: voice_credits
Description: Add 200 voice message credits to your account
```

## 🔑 2. API Keys Setup

### Development (Test Mode)
```bash
# Get these from Stripe Dashboard → Developers → API Keys (Test Mode)
STRIPE_SECRET_KEY=sk_test_...
STRIPE_PUBLISHABLE_KEY=pk_test_...
```

### Production (Live Mode)
```bash
# Get these from Stripe Dashboard → Developers → API Keys (Live Mode)
STRIPE_SECRET_KEY=sk_live_...
STRIPE_PUBLISHABLE_KEY=pk_live_...
```

### Price IDs
After creating products, get the price IDs:
```bash
# From each product's pricing section
STRIPE_BASIC_PRICE_ID=price_1ABC123...     # Basic monthly plan
STRIPE_PREMIUM_PRICE_ID=price_1DEF456...   # Premium monthly plan
STRIPE_VOICE_CREDITS_PRICE_ID=price_1GHI789... # Voice credits one-time
```

## 🪝 3. Webhook Configuration

### Webhook URL

**Production (Final Setup):**
```
https://mysweetie-backend.fly.dev/api/stripe/webhook
```

**Development/Testing:**
```bash
# For local development
http://localhost:3001/api/stripe/webhook

# For testing with ngrok (if needed)
https://your-ngrok-url.ngrok.io/api/stripe/webhook
```

### Required Webhook Events

Configure these events in Stripe Dashboard → Developers → Webhooks:

```
✅ checkout.session.completed     # For both subscriptions and voice credits
✅ customer.subscription.updated  # For subscription changes
✅ customer.subscription.deleted  # For cancellations
✅ invoice.payment_succeeded      # For successful recurring payments
✅ invoice.payment_failed         # For failed payments
✅ payment_intent.succeeded       # Backup for one-time payments
```

### Webhook Secret

After creating the webhook endpoint, copy the signing secret:
```bash
STRIPE_WEBHOOK_SECRET=whsec_...
```

## 🛠️ 4. Step-by-Step Stripe Setup

### Step 1: Create Products
1. Go to **Stripe Dashboard → Products**
2. Click **"+ Add product"**
3. Create each product as specified above
4. Copy the **Price IDs** for your environment variables

### Step 2: Configure Webhook
1. Go to **Developers → Webhooks**
2. Click **"+ Add endpoint"**
3. Enter your webhook URL: `https://mysweetie-backend.fly.dev/api/stripe/webhook`
4. Select the required events (listed above)
5. Click **"Add endpoint"**
6. Copy the **Signing secret** (starts with `whsec_`)

### Step 3: Test Webhook
1. Use Stripe CLI for local testing:
   ```bash
   stripe listen --forward-to localhost:3001/api/stripe/webhook
   ```
2. Or use webhook testing tools like ngrok for public testing

### Step 4: Environment Variables
Add all keys to your Fly.io backend environment:
```bash
# Set environment variables on Fly.io
fly secrets set STRIPE_SECRET_KEY=sk_test_...
fly secrets set STRIPE_WEBHOOK_SECRET=whsec_...
fly secrets set STRIPE_BASIC_PRICE_ID=price_1ABC123...
fly secrets set STRIPE_PREMIUM_PRICE_ID=price_1DEF456...
fly secrets set STRIPE_VOICE_CREDITS_PRICE_ID=price_1GHI789...
fly secrets set FRONTEND_URL=https://mysweetie.ai
```

**Or via Fly.io Dashboard:**
1. Go to [Fly.io Dashboard](https://fly.io/dashboard)
2. Select your `mysweetie-backend` app
3. Go to **Settings → Secrets**
4. Add each environment variable

## 🧪 5. Testing Configuration

### Test Cards
```bash
# Successful payment
4242 4242 4242 4242

# Declined payment
4000 0000 0000 0002

# Requires authentication
4000 0000 0000 3220
```

### Test Webhook
**Option 1: Test with Production Backend**
1. Install Stripe CLI: `npm install -g stripe`
2. Login: `stripe login`
3. Forward webhooks: `stripe listen --forward-to https://mysweetie-backend.fly.dev/api/stripe/webhook`
4. Test a purchase and check webhook delivery

**Option 2: Test Locally**
1. Install Stripe CLI: `npm install -g stripe`
2. Login: `stripe login`
3. Forward webhooks: `stripe listen --forward-to localhost:3001/api/stripe/webhook`
4. Test a purchase and check webhook delivery

### Verify Webhook Reception
Check your Fly.io backend logs for:
```bash
# View live logs
fly logs -a mysweetie-backend

# Look for these success messages:
✅ Webhook signature verification passed
✅ User [user_id] upgraded to basic plan
✅ User [user_id] purchased 200 voice credits
```

## 🌐 6. Production Setup (Final Configuration)

### Current Production URLs

**Frontend:** https://mysweetie.ai (Vercel)
**Backend:** https://mysweetie-backend.fly.dev (Fly.io)

### Environment Variables Setup

**Fly.io Backend Environment:**
```bash
# Set all required environment variables on Fly.io
fly secrets set OPENROUTER_API_KEY=your_openrouter_key
fly secrets set GROQ_API_KEY=your_groq_key
fly secrets set RIME_API_KEY=your_rime_key
fly secrets set REDIS_URL=your_redis_url
fly secrets set STRIPE_SECRET_KEY=sk_live_...
fly secrets set STRIPE_WEBHOOK_SECRET=whsec_...
fly secrets set STRIPE_BASIC_PRICE_ID=price_1ABC123...
fly secrets set STRIPE_PREMIUM_PRICE_ID=price_1DEF456...
fly secrets set STRIPE_VOICE_CREDITS_PRICE_ID=price_1GHI789...
fly secrets set FRONTEND_URL=https://mysweetie.ai
fly secrets set SUPABASE_URL=your_supabase_url
fly secrets set SUPABASE_ANON_KEY=your_supabase_anon_key
fly secrets set SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key
```

### Webhook Configuration

**Production Webhook URL:**
```
https://mysweetie-backend.fly.dev/api/stripe/webhook
```

**Required Steps:**
1. Go to [Stripe Dashboard → Webhooks](https://dashboard.stripe.com/webhooks)
2. Click **"+ Add endpoint"**
3. Enter URL: `https://mysweetie-backend.fly.dev/api/stripe/webhook`
4. Select events: `checkout.session.completed`, `customer.subscription.updated`, `customer.subscription.deleted`, `invoice.payment_succeeded`, `invoice.payment_failed`
5. Copy the **Signing secret** and add it to Fly.io secrets

## 🚀 7. Production Deployment Checklist

### Pre-Launch Checklist
- [ ] **Stripe Setup:**
  - [ ] Switch to **Live Mode** in Stripe Dashboard
  - [ ] Create products in **Live Mode** (Basic Plan, Premium Plan, Voice Credits)
  - [ ] Copy live API keys and price IDs
  - [ ] Configure webhook: `https://mysweetie-backend.fly.dev/api/stripe/webhook`
  - [ ] Test webhook delivery with Stripe CLI

- [ ] **Backend Setup:**
  - [ ] Set all environment variables on Fly.io using `fly secrets set`
  - [ ] Deploy backend: `fly deploy -a mysweetie-backend`
  - [ ] Verify backend health: https://mysweetie-backend.fly.dev/
  - [ ] Check logs: `fly logs -a mysweetie-backend`

- [ ] **Frontend Setup:**
  - [ ] Verify frontend is live: https://mysweetie.ai
  - [ ] Test user registration and login
  - [ ] Test chat functionality
  - [ ] Test character selection

### Testing Checklist
- [ ] **End-to-End Testing:**
  - [ ] Test subscription purchase flow
  - [ ] Test voice credits purchase
  - [ ] Verify webhook processing in logs
  - [ ] Test user plan updates in database
  - [ ] Test voice call functionality (if available)
  - [ ] Test TTS functionality (if available)

### Security Notes
- ✅ Webhook signature verification is implemented
- ✅ All payments are processed server-side
- ✅ User authentication required for checkout
- ✅ Idempotent webhook handling prevents duplicate processing

## 🔍 7. Troubleshooting

### Common Issues

**Webhook not receiving events:**
- Check the endpoint URL is correct and accessible
- Verify the webhook events are configured
- Check backend logs for signature verification errors

**Payment not updating user status:**
- Check webhook signature verification
- Verify user_id is in session metadata
- Check database update logs

**Test cards not working:**
- Ensure you're in **Test Mode**
- Use exact test card numbers from Stripe docs
- Check for 3DS authentication requirements

### Debug Commands
```bash
# Check webhook deliveries
stripe events list --limit 10

# Test webhook with production backend
stripe listen --forward-to https://mysweetie-backend.fly.dev/api/stripe/webhook

# Test webhook locally
stripe listen --forward-to localhost:3001/api/stripe/webhook

# Trigger test webhook
stripe trigger checkout.session.completed

# Check Fly.io backend logs
fly logs -a mysweetie-backend

# Check backend health
curl https://mysweetie-backend.fly.dev/
```

## 📞 Support

If you encounter issues:
1. Check Stripe Dashboard → Events for webhook delivery status
2. Review Fly.io backend logs: `fly logs -a mysweetie-backend`
3. Test webhook with Stripe CLI: `stripe listen --forward-to https://mysweetie-backend.fly.dev/api/stripe/webhook`
4. Verify backend health: https://mysweetie-backend.fly.dev/
5. Use Stripe test mode for debugging
6. Consult Stripe documentation: https://stripe.com/docs/webhooks

---

## 🎯 Quick Start Guide

### For Production Setup:
1. **Create Stripe Products** in Live Mode
2. **Set Environment Variables** on Fly.io: `fly secrets set KEY=value`
3. **Configure Webhook**: `https://mysweetie-backend.fly.dev/api/stripe/webhook`
4. **Test Purchase Flow** end-to-end
5. **Monitor Logs**: `fly logs -a mysweetie-backend`

**Production URLs:**
- Frontend: https://mysweetie.ai
- Backend: https://mysweetie-backend.fly.dev
- Webhook: https://mysweetie-backend.fly.dev/api/stripe/webhook
