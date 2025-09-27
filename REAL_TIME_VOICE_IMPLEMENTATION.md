# Real-Time Voice Call Implementation

This document provides an overview of the real-time voice call feature implementation based on the design specification in `real_time.md`.

## 🚀 Features Implemented

✅ **Server-side Voice Activity Detection (VAD)** - Detects when user starts/stops speaking
✅ **Hands-free conversation flow** - No need to click buttons during conversation  
✅ **AI interruption (barge-in)** - Users can interrupt the AI while it's speaking
✅ **WebSocket-based real-time communication** - Low-latency bidirectional audio streaming
✅ **Groq integration** - Streaming speech-to-text via Groq's Whisper API
✅ **Rime.ai integration** - Streaming text-to-speech via Rime.ai Arcana API
✅ **Web Audio API** - PCM audio handling for maximum quality and control
✅ **React frontend component** - Complete voice call interface with state visualization

## 🏗️ Architecture Overview

### Backend Components

1. **`callService.ts`** - Core orchestrator managing conversation state and external API connections
2. **`callController.ts`** - WebSocket connection management and session lifecycle  
3. **`vad.ts`** - Voice Activity Detection utility for hands-free interaction
4. **Routes** - REST API endpoints for call initiation/management (`/api/call/*`)

### Frontend Components

1. **`VoiceCall.tsx`** - Complete voice call interface React component
2. **`audioUtils.ts`** - Web Audio API utilities for PCM audio processing
3. **`pcm-processor.js`** - AudioWorklet for real-time PCM encoding
4. **Integration** - Voice call button added to Chat interface

### State Management

The system uses a clear state machine:
- **IDLE** - Waiting for user to speak
- **USER_SPEAKING** - User is actively speaking (VAD detected voice)
- **AI_PROCESSING** - Converting speech to text and generating AI response
- **AI_SPEAKING** - AI is speaking (interruptible by user)

## 🔧 Setup Instructions

### 1. Environment Variables

Add to your backend `.env` file:
```bash
# Real-Time Voice Features
GROQ_API_KEY=your_groq_api_key
RIME_API_KEY=your_rime_api_key
```

### 2. Install Dependencies

Backend:
```bash
cd backend
npm install ws @types/ws uuid @types/uuid
```

Frontend dependencies are already included.

### 3. Start the Backend

```bash
cd backend
npm run dev
```

The WebSocket server will be available at `ws://localhost:3001/ws/call/{sessionId}`

### 4. Start the Frontend

```bash
cd web  
npm run dev
```

## 🎯 Usage

1. Navigate to any character chat
2. Click the green "Call" button in the chat header
3. Allow microphone permissions when prompted
4. Start speaking naturally - the system will detect when you're talking
5. The AI will respond with voice, and you can interrupt at any time
6. Click "End Call" to finish the conversation

## 🔊 Audio Requirements

- **Format**: PCM s16le at 16kHz (mono)
- **Browser Support**: Chrome, Firefox, Safari (WebAudio + AudioWorklet required)
- **Microphone**: Required for voice input
- **Network**: Stable WebSocket connection required

## 🛠️ Technical Details

### Audio Pipeline

1. **Capture**: Microphone → Web Audio API → AudioWorklet → PCM s16le
2. **Transmission**: PCM binary data via WebSocket
3. **Processing**: Server-side VAD analysis + Groq transcription
4. **Response**: AI text generation + Rime.ai TTS
5. **Playback**: PCM audio streamed back → Web Audio API → Speakers

### VAD Algorithm

- RMS energy calculation with adaptive thresholding
- Consecutive frame counting for speech start/end detection
- Noise floor estimation for robust performance
- Configurable sensitivity and timing parameters

### Error Handling

- Graceful fallback for unsupported browsers
- Microphone permission management
- WebSocket reconnection logic
- Audio buffer overflow protection
- API error recovery

## 🧪 Testing

To test the implementation:

1. Ensure backend is running with proper API keys
2. Open the chat interface in a modern browser
3. Test basic call flow: initiate → speak → receive response → end
4. Test interruption: speak while AI is talking
5. Test error scenarios: deny microphone, network issues

## 📝 API Documentation

### REST Endpoints

- `POST /api/call/initiate` - Start a new voice call session
- `GET /api/call/:sessionId/status` - Get call session status  
- `POST /api/call/:sessionId/end` - End an active call session

### WebSocket Protocol

- **Connection**: `ws://host/ws/call/{sessionId}?token={auth_token}`
- **Input**: Binary PCM audio data
- **Output**: Binary PCM audio + JSON control messages

### Control Messages

```typescript
// Server → Client
{ type: 'state_change', state: 'USER_SPEAKING' | 'AI_PROCESSING' | 'AI_SPEAKING' | 'IDLE' }
{ type: 'transcript_update', text: string, is_final: boolean }
{ type: 'command', command: 'stop_playback' }
{ type: 'error', error: string }

// Client → Server  
{ type: 'ping' } // Optional keepalive
```

## 🔮 Future Enhancements

- Voice activity visualization (waveforms, levels)
- Multiple voice options per character
- Background noise suppression
- Call recording/playback
- Multi-language support
- Mobile app integration
- Voice biometrics/personalization

## 🐛 Troubleshooting

**"Audio not supported"** - Use Chrome, Firefox, or Safari
**"Microphone access denied"** - Check browser permissions
**"Connection failed"** - Verify backend is running and API keys are set
**"No audio output"** - Check speaker/headphone settings
**"Choppy audio"** - Check network connection stability

---

This implementation provides a solid foundation for real-time voice conversations and can be extended with additional features as needed.
