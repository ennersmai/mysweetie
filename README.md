# MySweetie.ai

An AI companion chatbot application with premium features, character conversations, and voice interactions.

## Features

- 🤖 **Character Chat**: Chat with AI characters using various models
- 💬 **Conversations**: Create and manage separate conversations with each character
- 🔊 **Voice Synthesis**: Premium voice features with multiple voice options
- 👑 **Premium Tiers**: Free, Basic, and Premium subscription plans
- 🎭 **Fantasy Mode**: Enhanced roleplay capabilities for premium users
- 📱 **Responsive Design**: Works on desktop and mobile devices

## Tech Stack

### Frontend
- **React** with TypeScript
- **Vite** for build tooling
- **Tailwind CSS** for styling
- **React Router** for navigation

### Backend
- **Supabase** for database and authentication
- **Supabase Edge Functions** for serverless API
- **OpenRouter** for AI model access
- **ElevenLabs** for text-to-speech

## Project Structure

```
├── web/                 # Frontend React application
│   ├── src/
│   │   ├── routes/      # Page components
│   │   ├── components/  # Reusable components
│   │   ├── contexts/    # React contexts
│   │   └── lib/         # Utility libraries
├── supabase/           # Backend configuration
│   ├── functions/      # Edge functions
│   ├── migrations/     # Database migrations
│   ├── schema.sql      # Database schema
│   └── rls.sql         # Row Level Security policies
```

## Deployment

### Frontend (Vercel)
1. Connect this repository to Vercel
2. Set build directory to `web`
3. Configure environment variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`

### Backend (Supabase)
1. Create a new Supabase project
2. Run the database migrations
3. Deploy the edge functions
4. Configure environment variables in Supabase

## Environment Variables

### Frontend (.env in web/ directory)
```
VITE_SUPABASE_URL=your_supabase_url
VITE_SUPABASE_ANON_KEY=your_supabase_anon_key
```

### Backend (Supabase Edge Functions)
```
SUPABASE_URL=your_supabase_url
SUPABASE_ANON_KEY=your_supabase_anon_key
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key
OPENROUTER_API_KEY=your_openrouter_api_key
ELEVENLABS_API_KEY=your_elevenlabs_api_key
```

## Recent Updates

- ✅ New conversation management system
- ✅ "New Chat" functionality with sidebar navigation
- ✅ Chat history on account page
- ✅ Updated AI models for better reliability
- ✅ Improved responsive layout and spacing
- ✅ Fixed header visibility issues

## Getting Started

1. Clone the repository
2. Install dependencies: `cd web && npm install`
3. Set up environment variables
4. Run development server: `npm run dev`

## License

Private project for MySweetie.ai
