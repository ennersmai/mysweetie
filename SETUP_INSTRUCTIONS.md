# MySweetie.AI Setup Instructions

This guide will help you set up and debug the issues you encountered.

## 🚀 Quick Setup

### 1. Backend Environment Variables

Create a `.env` file in the `backend/` directory with these variables:

```bash
# Server Configuration
PORT=3001
NODE_ENV=development
CORS_ORIGIN=http://localhost:5173
CORS_CREDENTIALS=true

# Database Configuration
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_supabase_service_role_key

# Redis Configuration (optional for development)
REDIS_URL=redis://localhost:6379

# External API Keys
OPENROUTER_API_KEY=your_openrouter_api_key

# Real-Time Voice Features (for voice calls)
GROQ_API_KEY=your_groq_api_key
RIME_API_KEY=your_rime_api_key

# Stripe Configuration (for subscriptions)
STRIPE_SECRET_KEY=your_stripe_secret_key
STRIPE_WEBHOOK_SECRET=your_stripe_webhook_secret
STRIPE_BASIC_PRICE_ID=price_basic_monthly
STRIPE_PREMIUM_PRICE_ID=price_premium_monthly
STRIPE_VOICE_CREDITS_PRICE_ID=price_voice_credits_200
FRONTEND_URL=http://localhost:5173

# Security & Features
NSFW_JAILBREAK_ENABLED=false
ALLOW_DEV_UNVERIFIED_JWT=false
```

### 2. Frontend Environment Variables

Create a `.env` file in the `web/` directory:

```bash
# Backend API URL
VITE_API_BASE_URL=http://localhost:3001/api
```

### 3. Database Setup

Run the Supabase migrations to add the required columns:

```sql
-- Add these to your Supabase SQL editor
alter table public.profiles
  add column if not exists stripe_customer_id text unique;

-- Add voice credits system
alter table public.profiles
  add column if not exists voice_credits integer not null default 0;

-- Initialize voice credits based on current plan
update public.profiles 
set voice_credits = case 
  when plan_tier = 'free' then 10
  when plan_tier = 'basic' then 50
  when plan_tier = 'premium' then 500
  else 10
end
where voice_credits = 0;
```

## 🔧 Issue Fixes

### Issue 1: Voice Call Button Not Working

**Problem**: The call button flashes but doesn't start a call.

**Root Cause**: Backend not running or missing API endpoints.

**Solution**:
1. Start the backend: `cd backend && npm run dev`
2. Check browser console for errors when clicking the call button
3. Verify the `/api/call/initiate` endpoint is accessible at `http://localhost:3001/api/call/initiate`

**Debug Steps Added**:
- Added console logging to trace the call flow
- Check browser DevTools → Console for debug messages when clicking "Call"

### Issue 2: Subscription Management Not Working

**Problem**: "Manage Subscription" button doesn't do anything.

**Root Cause**: Frontend was calling non-existent Supabase Edge Functions.

**Solution**: 
- ✅ Created new Stripe integration in Node.js backend
- ✅ Updated frontend to use `/api/stripe/create-portal-session`
- ✅ Added proper error handling and logging

### Issue 3: Subscription Status Not Updating

**Problem**: After successful payment, user redirected to wrong URL and status doesn't update.

**Root Causes**:
1. Stripe success URL was pointing to `mysweetie.ai/account` (should be `/account`)
2. No webhook handling to update subscription status

**Solutions**:
- ✅ Fixed success URL in Stripe checkout session creation
- ✅ Added comprehensive webhook handling for subscription events
- ✅ Added `stripe_customer_id` column to profiles table

## 🧪 Testing

### Test Voice Calls
1. Start backend: `cd backend && npm run dev`
2. Start frontend: `cd web && npm run dev`
3. Log in and navigate to a character chat
4. Click the green "Call" button
5. Check browser console for debug messages
6. Allow microphone permissions when prompted

### Test Subscription Flow
1. Go to `/subscribe`
2. Click "Upgrade" on Basic or Premium plan
3. Should redirect to Stripe checkout
4. Use Stripe test card: `4242 4242 4242 4242`
5. After payment, should redirect to `/account` with updated status

### Test Subscription Management
1. After subscribing, go to `/account`
2. Click "Manage Subscription"
3. Should redirect to Stripe customer portal

### Test Voice Credits Top-up
1. Go to `/account` 
2. Check your current voice credits balance
3. Click "Buy 200 Credits for $9.99"
4. Complete purchase with test card `4242 4242 4242 4242`
5. After payment, voice credits should increase by 200

## 🛠️ Development

### Start Development Servers

**Backend**:
```bash
cd backend
npm run dev
```

**Frontend**:
```bash
cd web
npm run dev
```

### Build for Production

**Backend**:
```bash
cd backend
npm run build
npm start
```

**Frontend**:
```bash
cd web
npm run build
```

## 🔍 Debugging

### Voice Call Issues
- Check browser console for error messages
- Verify microphone permissions are granted
- Ensure backend is running on port 3001
- Check that GROQ_API_KEY and RIME_API_KEY are set

### Subscription Issues
- Verify Stripe keys are configured in backend `.env`
- Check Stripe webhook endpoint is accessible
- Verify database has `stripe_customer_id` column
- Check browser Network tab for API call failures

### Backend Issues
- Check server logs for errors
- Verify all environment variables are set
- Test database connection with `/health` endpoint
- Ensure Supabase credentials are correct

## 🚀 Deployment

### Vercel Deployment
Both frontend and backend are ready for Vercel deployment:

1. **Frontend**: Deploy `web/` directory
2. **Backend**: Deploy `backend/` directory  
3. Update environment variables in Vercel dashboard
4. Configure Stripe webhook URL to point to your deployed backend

### Environment Variables for Production
- Update `FRONTEND_URL` to your production domain
- Update `CORS_ORIGIN` to your production frontend URL
- Set all API keys and secrets
- Configure Stripe webhook endpoint URL

## 📞 Support

If you continue to have issues:

1. Check the browser console for error messages
2. Check backend server logs
3. Verify all environment variables are set correctly
4. Test each endpoint individually using a tool like Postman

The debug logging added to the voice call component will help identify exactly where the issue occurs.
