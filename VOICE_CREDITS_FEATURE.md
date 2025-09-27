# Voice Credits Top-up Feature

## 🎯 Overview

Added a voice credits top-up system that allows users to purchase additional voice message credits for $9.99 to get 200 credits, regardless of their subscription tier.

## ✨ Features

### 🔢 **Unified Credits System**
- All users now use a unified voice credits system
- Free users start with 10 credits
- Basic plan users start with 50 credits  
- Premium users start with 500 credits
- Users can top up with 200 credits for $9.99

### 💳 **One-time Purchase**
- Separate from subscriptions - no recurring billing
- Instant credit addition after payment
- Works for all user tiers (free, basic, premium)

### 🎮 **Account Management**
- Real-time voice credits display in account page
- Clear "Buy 200 Credits for $9.99" button
- Purchase history via Stripe customer portal

## 🏗️ Implementation Details

### Backend Changes

1. **Database Schema** (`supabase/migrations/008_add_voice_credits.sql`)
   - Added `voice_credits` column to profiles table
   - Initialized existing users with credits based on their plan tier

2. **Stripe Integration** (`backend/src/controllers/stripeController.ts`)
   - Added `STRIPE_VOICE_CREDITS_PRICE_ID` environment variable
   - Updated checkout session creation to handle voice credits (one-time payment vs subscription)
   - Enhanced webhook handling for voice credits purchases
   - Automatic credit addition after successful payment

3. **Voice Usage Tracking** (`backend/src/controllers/ttsController.ts`)
   - Replaced old trial/quota system with unified credits system
   - Credit verification before voice generation
   - Automatic credit deduction after successful voice generation
   - Clear error messages when credits are insufficient

### Frontend Changes

1. **Account Page** (`web/src/routes/Account.tsx`)
   - Added voice credits display
   - Purchase button with loading states
   - Error handling for failed purchases

2. **Chat Interface** (`web/src/routes/Chat.tsx`)
   - Updated to use new voice credits system
   - Real-time credits tracking
   - Automatic voice disabling when credits reach zero

## 🔧 Stripe Configuration

### Required Products in Stripe

Create a **one-time payment product** in your Stripe dashboard:

```
Product: Voice Credits Top-up
Price: $9.99 USD
Type: One-time payment
Metadata: 
  - credits: 200
  - type: voice_credits
```

### Environment Variables

Add to your backend `.env` file:
```bash
STRIPE_VOICE_CREDITS_PRICE_ID=price_voice_credits_200
```

## 🎮 User Experience

### Purchase Flow
1. User goes to `/account`
2. Sees current voice credits balance
3. Clicks "Buy 200 Credits for $9.99"
4. Redirected to Stripe checkout
5. Completes payment
6. Redirected back to account with updated credits

### Usage Flow
1. User sends voice message in chat
2. System checks voice credits
3. If sufficient: generates voice, deducts 1 credit
4. If insufficient: shows error message with purchase option

## 📊 Credit Management

### Initial Credits by Plan
- **Free**: 10 credits
- **Basic**: 50 credits  
- **Premium**: 500 credits

### Top-up Package
- **200 credits** for **$9.99**
- Credits stack on top of existing balance
- No expiration date

### Usage Rate
- **1 credit** per voice message generated
- Applies to both TTS and real-time voice calls

## 🔍 Testing

### Test Purchase
```bash
# Use Stripe test card
Card Number: 4242 4242 4242 4242
Expiry: Any future date
CVC: Any 3 digits
ZIP: Any valid ZIP
```

### Test Webhooks
```bash
# Webhook events to handle
- checkout.session.completed (for voice credits)
- payment_intent.succeeded (backup handler)
```

## 🚀 Deployment

### Database Migration
Run the migration in your production Supabase:
```sql
alter table public.profiles
  add column if not exists voice_credits integer not null default 0;

update public.profiles 
set voice_credits = case 
  when plan_tier = 'free' then 10
  when plan_tier = 'basic' then 50
  when plan_tier = 'premium' then 500
  else 10
end
where voice_credits = 0;
```

### Stripe Setup
1. Create voice credits product in Stripe
2. Get the price ID
3. Add to production environment variables
4. Configure webhook endpoint
5. Test with Stripe test mode first

## 💡 Benefits

### For Users
- Flexible voice usage without subscription commitment
- Clear visibility into remaining credits
- Affordable top-up option
- Works with any subscription tier

### For Business
- Additional revenue stream
- Lower friction than full subscription upgrade
- Clear unit economics (200 credits = $9.99)
- Reduces support requests about voice limits

## 🔮 Future Enhancements

- Multiple credit package sizes (100, 500, 1000 credits)
- Credit gifting between users
- Bulk discounts for larger packages
- Credit expiration policies
- Usage analytics and recommendations

The voice credits system provides a flexible, user-friendly way to monetize voice features while giving users control over their usage and spending.
