# MySweetie.AI Edge Functions Migration Strategy

## 🎯 **Migration Overview**

We're migrating from Supabase Edge Functions to a Node.js backend to enable the **persistent memory system** and **premium features**. This migration will be **gradual** and **safe**.

---

## 📋 **Current Edge Functions Analysis**

### ✅ **KEEP (No Migration Needed)**
These functions work perfectly and don't need the memory system:

| Function | Status | Reason |
|----------|--------|---------|
| **`create-checkout-session`** | ✅ **KEEP** | Stripe integration works perfectly |
| **`create-portal-session`** | ✅ **KEEP** | Customer portal for subscriptions |
| **`stripe-webhook`** | ✅ **KEEP** | Handles subscription updates |
| **`update-profile`** | ✅ **KEEP** | Simple profile updates |

### 🔄 **MIGRATE TO NODE.JS**
These functions need memory system integration:

| Function | Status | Migration Priority | Memory Integration |
|----------|--------|-------------------|-------------------|
| **`chat`** | 🔄 **MIGRATE** | **HIGH** | ✅ Memory injection, NSFW mode |
| **`tts`** | 🔄 **MIGRATE** | **MEDIUM** | ✅ Usage tracking, premium limits |
| **`get-gallery`** | 🔄 **MIGRATE** | **LOW** | ❌ Premium feature enforcement |
| **`rapid-responder`** | 🔄 **MIGRATE** | **LOW** | ❌ Simple migration |

---

## 🚀 **Migration Plan**

### **Phase 1: Database Setup** ⭐ **(CURRENT)**
- [x] Create Node.js backend infrastructure
- [ ] **Run database migration script**
- [ ] Test database schema
- [ ] Verify premium user detection

### **Phase 2: Core Chat Migration** 
- [ ] Create `/api/chat` endpoint with memory injection
- [ ] Implement NSFW mode with jailbreak prompts
- [ ] Add non-blocking memory extraction
- [ ] Test chat functionality with memories

### **Phase 3: Voice System Migration**
- [ ] Create `/api/voice` endpoint 
- [ ] Implement usage tracking and limits
- [ ] Research ElevenLabs alternatives
- [ ] Test voice generation

### **Phase 4: Gallery & Misc Migration**
- [ ] Migrate gallery endpoints
- [ ] Update rapid responder
- [ ] Test all endpoints

### **Phase 5: Frontend Integration**
- [ ] Update frontend API calls
- [ ] Add memory UI components
- [ ] Test end-to-end functionality

---

## 📊 **Migration Instructions**

### **Step 1: Database Migration**

Run the memory system migration in Supabase:

```sql
-- Copy contents of backend/src/migrations/006_memory_system.sql
-- Run in Supabase SQL Editor
```

### **Step 2: Environment Variables**

Create `.env` file in backend directory:

```bash
# Copy from backend/env.example
# Fill in your actual values:

NODE_ENV=development
PORT=3001
API_PREFIX=/api

# From your existing Supabase project
SUPABASE_URL=your_actual_supabase_url
SUPABASE_ANON_KEY=your_actual_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_actual_service_key

# OpenRouter for both chat and memory orchestrator
OPENROUTER_API_KEY=your_openrouter_key

# Redis (for production - optional for development)
REDIS_URL=redis://localhost:6379

# Development frontend
CORS_ORIGIN=http://localhost:5173
```

### **Step 3: Test Database Connection**

```bash
cd backend
npm run dev
```

Visit: `http://localhost:3001/health` - should show database connected.

### **Step 4: Gradual Endpoint Migration**

**Keep existing Edge Functions running** while building new endpoints:

1. **Chat Function**: 
   - Old: `https://your-project.supabase.co/functions/v1/chat`
   - New: `http://localhost:3001/api/chat` (development)
   - Frontend will use **feature flags** to switch

2. **TTS Function**:
   - Old: `https://your-project.supabase.co/functions/v1/tts`
   - New: `http://localhost:3001/api/voice/synthesize`

3. **Gallery Function**:
   - Old: `https://your-project.supabase.co/functions/v1/get-gallery`
   - New: `http://localhost:3001/api/gallery/list`

---

## 🔧 **Technical Migration Details**

### **Memory System Integration**

The new Node.js backend will add:

1. **Before chat response**:
   ```
   User message → Retrieve relevant memories → Inject into context → LLM response
   ```

2. **After chat response**:
   ```
   LLM response → Extract new memories → Score importance → Store in database
   ```

3. **Non-blocking processing**:
   ```
   Chat response sent immediately → Background job extracts memories
   ```

### **Premium Feature Enforcement**

| Feature | Free | Basic Premium | Premium |
|---------|------|---------------|---------|
| Memories | 0 | 50 | 100 |
| Voice Daily | 10 | Unlimited | Unlimited |
| NSFW Mode | ❌ | ✅ | ✅ |
| Character Creation | ❌ | ✅ | ✅ |

### **NSFW Mode Implementation**

When NSFW mode is enabled, the system prompt gets modified:

```typescript
const basePrompt = character.system_prompt;
const nsfwPrompt = user.nsfw_enabled ? JAILBREAK_PROMPT : '';
const finalPrompt = nsfwPrompt + basePrompt;
```

---

## 🛡️ **Rollback Strategy**

If anything goes wrong:

1. **Keep Edge Functions active** during migration
2. **Frontend feature flags** can instantly switch back
3. **Database changes are additive** - no data loss
4. **Gradual user migration** - test with small groups first

---

## 📈 **Benefits After Migration**

### **For Users**:
- **Persistent memories** that enhance conversations
- **NSFW mode** for unrestricted chats
- **Faster responses** with caching
- **Better voice limits** tracking

### **For Business**:
- **Clear premium value** (50-100 memories vs 0)
- **Scalable architecture** 
- **Advanced analytics** on memory usage
- **Competitive differentiation** with memory intelligence

---

## ⚠️ **Important Notes**

### **DO NOT TOUCH**:
- Stripe functions (checkout, portal, webhook)
- Existing database tables (they get enhanced, not replaced)
- User authentication (still uses Supabase Auth)

### **KEEP MONITORING**:
- Edge Function logs during migration
- Database performance with new tables
- Redis connection stability
- Memory extraction job performance

---

## 🎯 **Next Immediate Steps**

1. **Copy `006_memory_system.sql`** and run in Supabase SQL Editor
2. **Create `.env`** file with your actual credentials
3. **Test backend health check** at `http://localhost:3001/health`
4. **Proceed to Phase 2** - Chat endpoint migration

This strategy ensures **zero downtime** and **safe rollback** while adding the powerful memory system! 🧠✨
