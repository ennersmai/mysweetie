# MySweetie.AI Backend Migration & Premium Memory System

## 🎯 **Overview**
Migrate from Supabase Edge Functions to Node.js backend with **intelligent persistent memory system**, **NSFW mode**, **tiered premium features**, and **non-blocking real-time memory orchestration**.

---

## 📋 **Phase 1: Backend Infrastructure & Database Foundation**

### 1.1 Node.js Server Setup
- [ ] **1.1.1** Initialize Node.js TypeScript project with Express
- [ ] **1.1.2** Setup CORS, body parser, and security middleware
- [ ] **1.1.3** Configure environment variables (.env structure)
- [ ] **1.1.4** Setup Supabase client for database operations
- [ ] **1.1.5** Create JWT authentication middleware for Supabase tokens
- [ ] **1.1.6** Setup Winston logging with different levels (dev/prod)
- [ ] **1.1.7** Create global error handling middleware
- [ ] **1.1.8** Setup rate limiting with redis-store

### 1.2 Database Schema Design
- [ ] **1.2.1** Create `user_memories` table:
  ```sql
  id, user_id, character_id, memory_text, importance_score, 
  memory_type, conversation_context, embedding_vector, 
  created_at, last_accessed, access_count
  ```
- [ ] **1.2.2** Create `memory_orchestrator_decisions` table:
  ```sql
  id, user_id, character_id, conversation_id, selected_memories, 
  reasoning, processing_time, created_at
  ```
- [ ] **1.2.3** Update `profiles` table with memory limits:
  ```sql
  ALTER TABLE profiles ADD COLUMN memory_limit INTEGER DEFAULT 0;
  ALTER TABLE profiles ADD COLUMN nsfw_enabled BOOLEAN DEFAULT FALSE;
  ALTER TABLE profiles ADD COLUMN subscription_tier TEXT DEFAULT 'free';
  ```
- [ ] **1.2.4** Create indexes for efficient memory retrieval
- [ ] **1.2.5** Setup database migrations system

### 1.3 Redis Caching Infrastructure
- [ ] **1.3.1** Setup Redis connection and configuration
- [ ] **1.3.2** Create memory caching layer for frequently accessed memories
- [ ] **1.3.3** Implement session caching for conversation context
- [ ] **1.3.4** Cache user subscription status and limits

---

## 📋 **Phase 2: Memory Orchestrator System (Core Intelligence)**

### 2.1 Memory Extraction Engine
- [ ] **2.1.1** Create conversation analyzer that extracts potential memories
- [ ] **2.1.2** Implement importance scoring algorithm:
  - Personal information (name, age, job, family): 9-10/10
  - Emotional events (happy/sad moments, trauma): 8-9/10
  - Preferences (likes, dislikes, hobbies): 6-7/10
  - Relationship dynamics: 7-8/10
  - Casual facts: 3-5/10
- [ ] **2.1.3** Create memory categorization system (personal, emotional, factual, relational)
- [ ] **2.1.4** Build memory deduplication and merging logic
- [ ] **2.1.5** Implement memory embeddings for semantic similarity

### 2.2 Non-Blocking Memory Orchestrator
- [ ] **2.2.1** Create background job queue system (Bull/Agenda)
- [ ] **2.2.2** Implement async memory extraction from conversations
- [ ] **2.2.3** Build real-time memory injection system that doesn't block chat
- [ ] **2.2.4** Create memory relevance scoring for context injection
- [ ] **2.2.5** Implement memory selection algorithm (top 5-10 most relevant)
- [ ] **2.2.6** Create fallback system when orchestrator is slow/offline

### 2.3 Memory Management & Limits
- [ ] **2.3.1** Implement memory limit enforcement:
  - Free: 0 memories
  - Basic Premium: 50 memories
  - Premium: 100 memories
- [ ] **2.3.2** Create memory eviction strategy (LRU + importance scoring)
- [ ] **2.3.3** Build memory cleanup and optimization routines
- [ ] **2.3.4** Implement memory archival for premium users

---

## 📋 **Phase 3: NSFW Mode & Content Management**

### 3.1 NSFW System Implementation
- [ ] **3.1.1** Create NSFW jailbreak prompt templates
- [ ] **3.1.2** Build dynamic system prompt injection for NSFW mode
- [ ] **3.1.3** Implement NSFW mode toggle API endpoint
- [ ] **3.1.4** Create content filtering bypass for premium users
- [ ] **3.1.5** Add NSFW conversation logging and monitoring

### 3.2 Content Safety & Compliance
- [ ] **3.2.1** Implement age verification checks for NSFW mode
- [ ] **3.2.2** Create content warning systems
- [ ] **3.2.3** Build audit logs for NSFW content generation
- [ ] **3.2.4** Implement emergency content filtering override

---

## 📋 **Phase 4: API Endpoints & Services**

### 4.1 Core Chat System
- [ ] **4.1.1** `POST /api/chat` - Enhanced chat with memory injection
  - Extract conversation context
  - Retrieve relevant memories (non-blocking)
  - Inject memories into system prompt
  - Handle NSFW mode prompt modification
  - Stream response with memory metadata
- [ ] **4.1.2** `GET /api/chat/context/:conversationId` - Get conversation context
- [ ] **4.1.3** `POST /api/chat/feedback` - User feedback on memory relevance

### 4.2 Memory Management APIs
- [ ] **4.2.1** `GET /api/memories` - List user memories with pagination
- [ ] **4.2.2** `POST /api/memories/extract` - Manual memory extraction
- [ ] **4.2.3** `PUT /api/memories/:id/importance` - User-defined importance
- [ ] **4.2.4** `DELETE /api/memories/:id` - Delete specific memory
- [ ] **4.2.5** `GET /api/memories/stats` - Memory usage statistics

### 4.3 Premium Feature APIs
- [ ] **4.3.1** `GET /api/subscription/status` - Real-time subscription check
- [ ] **4.3.2** `POST /api/features/nsfw/toggle` - Enable/disable NSFW mode
- [ ] **4.3.3** `GET /api/features/limits` - Get user feature limits
- [ ] **4.3.4** `POST /api/characters/create` - Premium-only character creation
- [ ] **4.3.5** `GET /api/usage/summary` - Usage summary (voice, memories, etc.)

### 4.4 Voice System (Placeholder for Migration)
- [ ] **4.4.1** `POST /api/voice/synthesize` - Text-to-speech endpoint
- [ ] **4.4.2** `GET /api/voice/usage` - Voice usage tracking
- [ ] **4.4.3** **TODO**: Research ElevenLabs alternatives
- [ ] **4.4.4** **TODO**: Implement new voice provider integration

---

## 📋 **Phase 5: Frontend Integration & Premium Enforcement**

### 5.1 Chat Component Overhaul
- [ ] **5.1.1** Update chat API endpoints from Supabase to Node.js backend
- [ ] **5.1.2** Implement memory injection display in chat UI
- [ ] **5.1.3** Add "memories used" indicator in chat
- [ ] **5.1.4** Create NSFW mode toggle in chat settings
- [ ] **5.1.5** Add loading states for memory processing
- [ ] **5.1.6** Implement memory feedback system (thumbs up/down)

### 5.2 Memory Management UI
- [ ] **5.2.1** Create dedicated memories page/modal
- [ ] **5.2.2** Build memory timeline view
- [ ] **5.2.3** Implement memory search and filtering
- [ ] **5.2.4** Add memory importance editing
- [ ] **5.2.5** Create memory usage progress bar (X/50 or X/100)
- [ ] **5.2.6** Build memory export functionality

### 5.3 Premium Feature Gating
- [ ] **5.3.1** Character creation: Premium-only with upgrade prompts
- [ ] **5.3.2** NSFW mode: Premium-only toggle
- [ ] **5.3.3** Memory system: Show locked state for free users
- [ ] **5.3.4** Advanced AI models: Premium tier restrictions
- [ ] **5.3.5** Voice limits: Display usage (X/10) for free users

### 5.4 Subscription & Upgrade Flow
- [ ] **5.4.1** Enhanced subscription page with memory system features
- [ ] **5.4.2** Add NSFW mode benefits to pricing tiers
- [ ] **5.4.3** Create upgrade prompts throughout the app
- [ ] **5.4.4** Build trial system (7-day premium access)

---

## 📋 **Phase 6: Marketing Copy & Landing Page Updates**

### 6.1 Landing Page Enhancements
- [ ] **6.1.1** Update hero copy to highlight "Intelligent Memory System"
- [ ] **6.1.2** Add "Persistent AI Memories" as key feature
- [ ] **6.1.3** Create memory system demo/visualization
- [ ] **6.1.4** Add NSFW mode messaging (tasteful, premium-focused)
- [ ] **6.1.5** Update feature cards with memory intelligence

### 6.2 Pricing Page Overhaul
- [ ] **6.2.1** Redesign pricing tiers (Free, Basic Premium, Premium)
- [ ] **6.2.2** Highlight memory limits prominently:
  - "50 AI Memories that grow with you" (Basic)
  - "100 AI Memories for deep relationships" (Premium)
- [ ] **6.2.3** Add NSFW mode as premium feature
- [ ] **6.2.4** Create "Memory Intelligence" as key selling point
- [ ] **6.2.5** Add testimonials about memory system

### 6.3 Marketing Copy Writing
- [ ] **6.3.1** "Your AI companion that actually remembers"
- [ ] **6.3.2** "Intelligent memory system that makes every conversation count"
- [ ] **6.3.3** "Advanced AI that learns and grows with you"
- [ ] **6.3.4** "Unrestricted conversations for mature audiences" (NSFW)
- [ ] **6.3.5** Update all feature descriptions across the site

---

## 🔧 **Enhanced Technical Stack**

### Backend Technology
- **Framework**: Express.js with TypeScript
- **Database**: Supabase PostgreSQL with memory tables
- **Authentication**: Supabase Auth JWT verification
- **Memory Orchestrator**: Mistral Small 24B via OpenRouter for fast decision making
- **Caching**: Redis cluster for memory and session data
- **Job Queue**: Bull.js for background memory processing
- **Monitoring**: Winston + DataDog/NewRelic

### Memory System Architecture
```
Chat Request → Memory Retrieval (cached) → Context Injection → LLM Response
     ↓
Background: Memory Extraction → Importance Scoring → Storage/Eviction
```

### Premium Features Matrix
| Feature | Free | Basic Premium ($9.99) | Premium ($19.99) |
|---------|------|----------------------|------------------|
| Voice Messages | 10/day | Unlimited | Unlimited |
| **AI Memory System** | **0 memories** | **50 memories** | **100 memories** |
| Character Creation | ❌ | ✅ | ✅ |
| Advanced AI Models | ❌ | Limited access | Full access |
| Gallery Uploads | ❌ | ✅ | ✅ |
| Fantasy Mode | ❌ | ✅ | ✅ |
| **NSFW Mode** | ❌ | **✅** | **✅** |
| Memory Analytics | ❌ | Basic | Advanced |

---

## 🚀 **Implementation Priority**

1. **Phase 1-2**: Backend + Memory Core (2 weeks)
2. **Phase 3-4**: NSFW + APIs (1 week)  
3. **Phase 5**: Frontend Integration (1 week)
4. **Phase 6**: Marketing Updates (3 days)

**Total Estimated Time**: 4-5 weeks for core system

---

## 📈 **Marketing Highlights for Landing Page**

### Hero Section Updates
- **"The AI companion with a perfect memory"**
- **"Conversations that build real relationships"**
- **"Advanced memory intelligence that grows with you"**

### Key Selling Points
1. **🧠 Intelligent Memory System**: "Your AI remembers what matters most"
2. **💎 Premium Conversations**: "Unrestricted, adult-oriented discussions"
3. **🎯 Personalized Experience**: "Every conversation builds a deeper connection"

### Feature Bragging Rights
- **"Industry-first persistent memory system"**
- **"Up to 100 AI memories that shape your relationship"**
- **"Intelligent conversation orchestration"**
- **"Advanced AI models with memory-enhanced responses"**

---

*This refactor will establish MySweetie.AI as the premier AI companion platform with true memory intelligence and premium adult features! 🚀🧠✨*
