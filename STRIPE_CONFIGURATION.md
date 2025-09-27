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

**Old (Supabase Edge Function):**
```
https://your-project.supabase.co/functions/v1/stripe-webhook
```

**New (Node.js Backend):**
```
https://api.mysweetie.ai/api/stripe/webhook
```

### Development Webhook URL
```bash
# For local development
http://localhost:3001/api/stripe/webhook

# For Vercel deployment (temporary)
https://your-backend-project.vercel.app/api/stripe/webhook

# For custom domain (production)
https://api.mysweetie.ai/api/stripe/webhook
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
3. Enter your webhook URL: `https://your-backend.com/api/stripe/webhook`
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
Add all keys to your backend `.env` file:
```bash
# Stripe Configuration
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...
STRIPE_BASIC_PRICE_ID=price_1ABC123...
STRIPE_PREMIUM_PRICE_ID=price_1DEF456...
STRIPE_VOICE_CREDITS_PRICE_ID=price_1GHI789...
FRONTEND_URL=https://your-frontend.com
```

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

### Test Webhook Locally
1. Install Stripe CLI: `npm install -g stripe`
2. Login: `stripe login`
3. Forward webhooks: `stripe listen --forward-to localhost:3001/api/stripe/webhook`
4. Test a purchase and check webhook delivery

### Verify Webhook Reception
Check your backend logs for:
```
✅ Webhook signature verification passed
✅ User [user_id] upgraded to basic plan
✅ User [user_id] purchased 200 voice credits
```

## 🌐 6. Vercel Deployment & Custom Domain Setup

### Vercel Deployment Process

1. **Deploy Backend to Vercel**
   ```bash
   cd backend
   vercel --prod
   ```
   
   This will give you a temporary URL like:
   ```
   https://mysweetie-backend-abc123.vercel.app
   ```

2. **Set Up Custom Domain**
   - In Vercel Dashboard → Project Settings → Domains
   - Add custom domain: `api.mysweetie.ai`
   - Configure DNS records as instructed by Vercel
   - Wait for SSL certificate provisioning

3. **Update Environment Variables**
   - In Vercel Dashboard → Project Settings → Environment Variables
   - Add all your Stripe keys and other environment variables
   - Make sure `FRONTEND_URL=https://mysweetie.ai`

### Webhook URL Timeline

**Phase 1: Initial Deployment (Temporary)**
```
https://mysweetie-backend-abc123.vercel.app/api/stripe/webhook
```

**Phase 2: Custom Domain (Production)**
```
https://api.mysweetie.ai/api/stripe/webhook
```

### Important Notes

- ⚠️ **Update webhook URL twice**: First with Vercel URL, then with custom domain
- ⚠️ **Test both phases** to ensure continuity
- ⚠️ **DNS propagation** can take up to 48 hours for custom domain

## 🚀 7. Production Deployment

### Checklist
- [ ] Switch to **Live Mode** in Stripe Dashboard
- [ ] Create products in **Live Mode**
- [ ] Update environment variables with **live** API keys
- [ ] Configure webhook with **production** URL
- [ ] Test end-to-end purchase flow
- [ ] Verify webhook delivery in production

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

# Test webhook locally
stripe listen --forward-to localhost:3001/api/stripe/webhook

# Trigger test webhook
stripe trigger checkout.session.completed
```

## 📞 Support

If you encounter issues:
1. Check Stripe Dashboard → Events for webhook delivery status
2. Review backend logs for webhook processing errors
3. Use Stripe test mode for debugging
4. Consult Stripe documentation: https://stripe.com/docs/webhooks

---

**Important:** Always test in Stripe's test mode before going live. The webhook URL change from Supabase Edge Functions to Node.js backend requires updating the endpoint in your Stripe webhook configuration.
