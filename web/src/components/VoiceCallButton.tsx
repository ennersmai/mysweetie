/**
 * Voice Call Button Component
 * 
 * An animated voice call button that transforms into a voice activity detector
 * when active. Designed to be placed next to the send button.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { ProductionAudioManager } from '../lib/productionAudioManager';
import Modal from './Modal';
import { isWebAudioSupported, isMediaStreamSupported } from '../lib/audioUtils';
import { apiClient } from '../lib/apiClient';
import { supabase } from '../lib/supabaseClient';

export interface CallState {
  IDLE: 'IDLE';
  LISTENING: 'LISTENING';
  USER_SPEAKING: 'USER_SPEAKING'; 
  AI_PROCESSING: 'AI_PROCESSING';
  AI_SPEAKING: 'AI_SPEAKING';
}

export interface VoiceCallButtonProps {
  characterId: string;
  character: {
    id: string;
    name: string;
    avatar_url?: string;
    voice?: string;
    prompt?: string;
  };
  conversationId?: string;
  onError?: (error: string) => void;
  onTranscript?: (transcript: string) => void;
  onTranscriptUpdate?: (partialTranscript: string) => void; // Live STT updates
  onAIResponse?: (response: string) => void;
  onAIResponseChunk?: (chunk: string) => void; // Streaming AI response
  disabled?: boolean;
}

export interface CallMessage {
  type: 'command' | 'transcript_update' | 'state_change' | 'error' | 'ai_response' | 'ai_response_chunk' | 'tts_finished' | 'tts_stream_end' | 'tts_sentence_complete';
  command?: string;
  text?: string;
  is_final?: boolean;
  state?: keyof CallState;
  error?: string;
}

export default function VoiceCallButton({ 
  characterId, 
  character, 
  conversationId, 
  onError,
  onTranscript,
  onTranscriptUpdate,
  onAIResponse,
  onAIResponseChunk,
  disabled = false
}: VoiceCallButtonProps) {
  const [isCallActive, setIsCallActive] = useState(false);
  const [callState, setCallState] = useState<keyof CallState>('IDLE');
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [audioSupported, setAudioSupported] = useState(true);
  const [micPermission, setMicPermission] = useState<'granted' | 'denied' | 'prompt'>('prompt');
  const [voiceLevel, setVoiceLevel] = useState(0); // 0-1 for animation
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [creditsModalOpen, setCreditsModalOpen] = useState(false);

  const audioManagerRef = useRef<ProductionAudioManager | null>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const serverConversationIdRef = useRef<string | null>(null);
  const animationFrameRef = useRef<number | null>(null);
  const shouldSendAudioRef = useRef<boolean>(true);
  const callStateRef = useRef<keyof CallState>('IDLE');
  const isEndingCallRef = useRef<boolean>(false);

  // Check audio support on mount
  useEffect(() => {
    const checkSupport = async () => {
      const webAudioSupported = isWebAudioSupported();
      const mediaStreamSupported = isMediaStreamSupported();
      
      if (!webAudioSupported || !mediaStreamSupported) {
        setAudioSupported(false);
      }
    };

    checkSupport();
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      endCall();
    };
  }, []);

  // Voice level animation
  useEffect(() => {
    if (isCallActive && callState === 'USER_SPEAKING') {
      // Simulate voice level animation - in production this would come from actual audio analysis
      const animate = () => {
        setVoiceLevel(0.3 + Math.random() * 0.7);
        animationFrameRef.current = requestAnimationFrame(animate);
      };
      animate();
    } else {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
      setVoiceLevel(0);
    }

    return () => {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
      }
    };
  }, [isCallActive, callState]);

  const handleWebSocketMessage = useCallback((event: MessageEvent) => {
    // Ignore messages if call is ending or has ended
    if (!websocketRef.current || isEndingCallRef.current) {
      console.log('⚠️ Ignoring WebSocket message (call ended or ending)');
      return;
    }
    
    try {
      if (event.data instanceof ArrayBuffer) {
        // Binary audio data from AI
        if (audioManagerRef.current) {
          audioManagerRef.current.playAudio(event.data);
        }
        return;
      }

      // Handle Blob data (audio from Rime.ai)
      if (event.data instanceof Blob) {
        event.data.arrayBuffer().then(buffer => {
          if (audioManagerRef.current) {
            audioManagerRef.current.playAudio(buffer);
          }
        });
        return;
      }

      // Try to parse as JSON
      let message: CallMessage;
      try {
        message = JSON.parse(event.data);
      } catch (error) {
        console.warn('Received non-JSON WebSocket message:', event.data);
        return;
      }
      
      switch (message.type) {
        case 'state_change':
          if (message.state) {
            console.log(`🔄 [FRONTEND STATE] Received state change: ${message.state}`);
            const previousState = callStateRef.current;
            console.log(`🔄 [FRONTEND STATE] Previous state: ${previousState}`);
            setCallState(message.state);
            callStateRef.current = message.state;
            // Send audio when in LISTENING or USER_SPEAKING
            shouldSendAudioRef.current = message.state === 'LISTENING' || message.state === 'USER_SPEAKING';
            console.log(`🔄 [FRONTEND STATE] State changed to ${message.state}, shouldSendAudio: ${shouldSendAudioRef.current}`);
            
            // Debug state transitions
            if (message.state === 'LISTENING') {
              console.log(`🔄 [FRONTEND STATE] ✅ Now in LISTENING mode - ready to accept user input`);
              
              // If we're transitioning from AI_SPEAKING to LISTENING, the entire TTS session is complete
              if (previousState === 'AI_SPEAKING' && audioManagerRef.current) {
                console.log('🏁 [FRONTEND STATE] Transition AI_SPEAKING → LISTENING: marking TTS session complete');
                audioManagerRef.current.completeTTSSession();
              }
            } else if (message.state === 'AI_SPEAKING') {
              console.log(`🔄 [FRONTEND STATE] 🔊 AI is speaking - audio should be muted`);
            } else if (message.state === 'USER_SPEAKING') {
              console.log(`🔄 [FRONTEND STATE] 🎤 User is speaking - audio should be sent`);
            } else if (message.state === 'AI_PROCESSING') {
              console.log(`🔄 [FRONTEND STATE] 🤔 AI is processing - waiting for response`);
            }
          } else {
            console.warn(`🔄 [FRONTEND STATE] Received state_change message with no state:`, message);
          }
          break;
          
        case 'transcript_update':
          console.log('📝 Transcript update received:', message.text, 'is_final:', message.is_final);
          if (message.text) {
            // Always update the current transcript state
            setCurrentTranscript(message.text);
            
            // Send live updates to parent for input field
            if (onTranscriptUpdate) {
              console.log('📝 Calling onTranscriptUpdate with:', message.text);
              onTranscriptUpdate(message.text);
            }
            
            // Handle final transcript
            if (message.is_final) {
              console.log('📝 Final transcript received:', message.text);
              
              if (onTranscript) {
                console.log('📝 Calling onTranscript with final text:', message.text);
                onTranscript(message.text);
              }
              
              // Clear local state after sending final
              setCurrentTranscript('');
              
              // Clear input field after final transcript
              if (onTranscriptUpdate) {
                console.log('📝 Clearing input field after final transcript');
                onTranscriptUpdate('');
              }
            }
          }
          break;
          
        case 'command':
          if (message.command === 'stop_playback' && audioManagerRef.current) {
            console.log('🛑 Received stop_playback command from backend');
            audioManagerRef.current.stopPlayback();
          }
          break;
          
        // Removed tts_finished case - we rely on tts_stream_end instead
          
        case 'ai_response_chunk':
          // Stream AI response chunks for real-time display in chat
          console.log('Received AI response chunk:', message.text);
          if (message.text && onAIResponseChunk) {
            onAIResponseChunk(message.text);
          }
          break;

        case 'ai_response':
          // Final AI response - send to parent
          console.log('Received final AI response:', message.text);
          if (message.text && onAIResponse) {
            onAIResponse(message.text);
          }
          break;
          
        case 'tts_sentence_complete':
          console.log('🔚 TTS sentence complete signal received (PCM will flush naturally via timer)');
          // NOTE: We do NOT flush here because TTS audio arrives asynchronously
          // Flushing now would create tiny fragmented buffers (e.g., 90ms chunks)
          // The PCM accumulator's timer-based flush handles sentence boundaries properly
          break;
          
        case 'tts_stream_end':
          console.log('TTS stream ended - flushing remaining PCM data');
          // Flush any remaining PCM data when TTS stream ends
          if (audioManagerRef.current && 'flushRemainingPCM' in audioManagerRef.current) {
            (audioManagerRef.current as any).flushRemainingPCM();
            console.log('Flushed remaining PCM data - waiting for audio manager completion callback');
          }
          
          // Fallback: If audio manager doesn't call completion callback within 1 second, send manually
          setTimeout(() => {
            console.log(`[FALLBACK] Checking if fallback needed - callState: ${callStateRef.current}, WebSocket ready: ${websocketRef.current?.readyState === WebSocket.OPEN}`);
            if (callStateRef.current === 'AI_SPEAKING' && websocketRef.current?.readyState === WebSocket.OPEN) {
              console.log('[FALLBACK] Audio manager callback timeout - manually sending tts_playback_finished');
              const message = { type: 'tts_playback_finished' };
              websocketRef.current.send(JSON.stringify(message));
              console.log('[FALLBACK] Manual tts_playback_finished sent');
            } else {
              console.log('[FALLBACK] No fallback needed - either not in AI_SPEAKING state or WebSocket not open');
            }
          }, 1000);
          break;
          
        case 'error':
          onError?.(message.error || 'Voice call error occurred');
          break;
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }, [onError]);

  const initializeCall = async (): Promise<boolean> => {
    try {
      console.log('initializeCall: Setting connection status to connecting');
      setConnectionStatus('connecting');

      // Request microphone permission
      try {
        console.log('initializeCall: Requesting microphone permission');
        await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log('initializeCall: Microphone permission granted');
        setMicPermission('granted');
      } catch (error) {
        console.error('initializeCall: Microphone permission denied:', error);
        setMicPermission('denied');
        onError?.('Microphone access is required for voice calls. Please enable microphone permissions and try again.');
        setConnectionStatus('disconnected');
        return false;
      }

      // Initialize call session with backend
      console.log('initializeCall: Calling backend /call/initiate with:', { characterId, conversationId });
      const response = await apiClient.post('/call/initiate', {
        characterId,
        conversationId
      });
      console.log('initializeCall: Backend response status:', response.status);

        if (!response.ok) {
        let parsed: any = null;
        try {
          const text = await response.text();
          parsed = text ? JSON.parse(text) : null;
        } catch {}
        if (parsed?.error === 'INSUFFICIENT_CREDITS') {
            setCreditsModalOpen(true);
            setConnectionStatus('disconnected');
            return false;
        }
        console.error('initializeCall: Backend error:', parsed || response.statusText);
        throw new Error(`Failed to initiate call: ${response.statusText}`);
      }

      const responseData = await response.json();
      const { sessionId, conversationId: serverConversationId } = responseData;
      sessionIdRef.current = sessionId;
      serverConversationIdRef.current = serverConversationId || null;

      // Initialize audio manager
      audioManagerRef.current = new ProductionAudioManager();
      
      const initialized = await audioManagerRef.current.initialize();
      
      if (!initialized) {
        onError?.('Failed to initialize audio system. Please check your browser settings.');
        setConnectionStatus('disconnected');
        return false;
      }

      // Set up interrupt callback (Task 2A) - send immediate interrupt to backend
      audioManagerRef.current.setInterruptCallback(() => {
        if (websocketRef.current?.readyState === WebSocket.OPEN) {
          const interruptTimestamp = performance.now();
          console.log(`⚡ [FRONTEND] Sending interrupt command at ${interruptTimestamp.toFixed(0)}ms`);
          websocketRef.current.send(JSON.stringify({ type: 'interrupt' }));
        } else {
          console.warn('[FRONTEND] Cannot send interrupt - WebSocket not open');
        }
      });

      // Set up audio manager callback to notify backend when TTS is actually done playing
      audioManagerRef.current.setPlaybackCompleteCallback(() => {
        console.log('Audio manager: All TTS audio finished playing');
        console.log(`[FRONTEND] WebSocket state: ${websocketRef.current?.readyState} (OPEN=${WebSocket.OPEN})`);
        console.log(`[FRONTEND] WebSocket exists: ${!!websocketRef.current}`);
        // Optimistically allow mic to send while we await server LISTENING state
        shouldSendAudioRef.current = true;
        console.log('[FRONTEND] Optimistically enabling audio send after playback complete');
        
        if (websocketRef.current?.readyState === WebSocket.OPEN) {
          const message = { type: 'tts_playback_finished' };
          const messageStr = JSON.stringify(message);
          console.log('[FRONTEND] Sending to backend:', messageStr);
          
          try {
            websocketRef.current.send(messageStr);
            console.log('[FRONTEND] TTS playback finished message sent successfully');
          } catch (error) {
            console.error('[FRONTEND] Error sending WebSocket message:', error);
          }
        } else {
          console.warn(`[FRONTEND] WebSocket not open, cannot send tts_playback_finished. State: ${websocketRef.current?.readyState}`);
        }
      });

      // Set up VAD callbacks for VAD-gated audio streaming
      audioManagerRef.current.setSpeechCallbacks(
        () => {
          // Speech started - CRITICAL: Tell backend user has started speaking
          console.log('[FRONTEND] VAD detected speech start');
          
          if (websocketRef.current?.readyState === WebSocket.OPEN) {
            // If AI is speaking, this is an interruption
            if (callStateRef.current === 'AI_SPEAKING') {
              console.log('🛑 [FRONTEND] User interrupting AI speech - sending interrupt + user_speech_started');
              websocketRef.current.send(JSON.stringify({ type: 'interrupt' }));
              // CRITICAL: Also send user_speech_started so backend transitions to USER_SPEAKING
              // This allows the backend to receive our audio blob when we finish speaking
              websocketRef.current.send(JSON.stringify({ type: 'user_speech_started' }));
            } else {
              // Normal speech start - send user_speech_started message
              console.log('🎤 [FRONTEND] Sending user_speech_started message to backend');
              websocketRef.current.send(JSON.stringify({ type: 'user_speech_started' }));
            }
          }
        },
        () => {
          // Speech ended - Assemble and send complete audio file
          console.log('[FRONTEND] VAD detected speech end');
          
          if (websocketRef.current?.readyState === WebSocket.OPEN && audioManagerRef.current) {
            // CLIENT-SIDE ASSEMBLY: Get the complete audio blob
            const audioBlob = audioManagerRef.current.getAssembledAudio();
            
            if (audioBlob) {
              console.log(`🎵 [FRONTEND] Sending assembled audio blob: ${audioBlob.size} bytes`);
              // Send binary audio data first
              websocketRef.current.send(audioBlob);
              
              // Then immediately send speech_ended message
              console.log('🔇 [FRONTEND] Sending user_speech_ended message to backend');
              websocketRef.current.send(JSON.stringify({ type: 'user_speech_ended' }));
            } else {
              console.warn('[FRONTEND] No audio to send - skipping user_speech_ended');
            }
          }
        }
      );

      // Establish WebSocket connection
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        onError?.('Authentication required. Please log in and try again.');
        setConnectionStatus('disconnected');
        return false;
      }

      // Derive WS origin from VITE_API_BASE_URL to support separate backend domain
      const apiBase = (import.meta as any).env?.VITE_API_BASE_URL as string | undefined;
      let wsProtocol = 'ws:';
      let wsHost = 'localhost:3001';
      if (apiBase && /^https?:\/\//i.test(apiBase)) {
        const apiUrl = new URL(apiBase);
        wsProtocol = apiUrl.protocol === 'https:' ? 'wss:' : 'ws:';
        wsHost = apiUrl.host;
      } else if (typeof window !== 'undefined') {
        wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        wsHost = process.env.NODE_ENV === 'development' ? 'localhost:3001' : window.location.host;
      }
      // Include characterId and conversationId so backend can bind correct session context
      const urlParams = new URLSearchParams({
        token,
        characterId,
        voice: character.voice || 'luna',
        conversationId: (serverConversationIdRef.current || conversationId || '')
      });
      const wsUrl_full = `${wsProtocol}//${wsHost}/ws/call/${sessionId}?${urlParams.toString()}`;

      console.log('initializeCall: Connecting to WebSocket:', wsUrl_full);
      websocketRef.current = new WebSocket(wsUrl_full);

      return new Promise((resolve) => {
        const ws = websocketRef.current!;

        ws.onopen = () => {
          console.log('WebSocket connected');
          setConnectionStatus('connected');
          
          // Initialize in listening mode (backend starts with LISTENING state)
          setCallState('LISTENING');
          callStateRef.current = 'LISTENING';
          shouldSendAudioRef.current = true;
          console.log('[FRONTEND] Starting audio recording, shouldSendAudio:', shouldSendAudioRef.current);
          
          // Start audio recording with AudioWorklet
          // Audio is captured via worklet, buffered in ring buffer, and assembled on speech end
          if (audioManagerRef.current) {
            audioManagerRef.current.startRecording();
          }
          
          resolve(true);
        };

        ws.onmessage = handleWebSocketMessage;

        ws.onerror = (error) => {
          console.error('WebSocket error:', error);
          onError?.('Connection error occurred. Please try again.');
          setConnectionStatus('disconnected');
          resolve(false);
        };

        ws.onclose = (event) => {
          console.log('WebSocket closed:', event.code, event.reason);
          setConnectionStatus('disconnected');
          
          // Only set inactive if we're not in the middle of ending the call
          if (!isEndingCallRef.current) {
            setIsCallActive(false);
            setCallState('IDLE');
          }
          
          if (audioManagerRef.current) {
            audioManagerRef.current.cleanup();
            audioManagerRef.current = null;
          }
        };
      });

    } catch (error) {
      console.error('Error initializing call:', error);
      onError?.('Failed to start voice call. Please try again.');
      setConnectionStatus('disconnected');
      return false;
    }
  };

  const startCall = async () => {
    console.log('startCall called, audioSupported:', audioSupported);
    
    if (isEndingCallRef.current) {
      console.log('Cannot start call - currently ending a call');
      return;
    }
    
    if (isCallActive) {
      console.log('Call already active, skipping start');
      return;
    }
    
    if (!audioSupported) {
      onError?.('Audio not supported in this browser');
      return;
    }

    console.log('Attempting to initialize call...');
    const initialized = await initializeCall();
    console.log('Call initialization result:', initialized);
    
    if (initialized) {
      setIsCallActive(true);
      setCallState('IDLE');
      console.log('Call started successfully');
    } else {
      console.log('Call initialization failed');
    }
  };

  const endCall = (force = false) => {
    console.log(`🔴 endCall() invoked - force: ${force}, isEndingCallRef: ${isEndingCallRef.current}, isCallActive: ${isCallActive}, callState: ${callState}`);
    
    if (isEndingCallRef.current && !force) {
      console.log('⚠️ Already ending call, skipping duplicate endCall');
      return;
    }
    
    isEndingCallRef.current = true;
    console.log('✅ Ending call...' + (force ? ' (FORCED)' : ''));
    
    // CRITICAL: Close WebSocket FIRST to stop incoming messages
    if (websocketRef.current) {
      console.log('🔌 Closing WebSocket to stop incoming messages');
      websocketRef.current.close();
      websocketRef.current = null;
    }
    
    // Stop playback immediately
    if (audioManagerRef.current) {
      audioManagerRef.current.stopPlayback();
    }

    // Cleanup audio
    if (audioManagerRef.current) {
      audioManagerRef.current.cleanup();
      audioManagerRef.current = null;
    }
    
    // End call on backend
    if (sessionIdRef.current) {
      apiClient.post(`/call/${sessionIdRef.current}/end`, {}).catch(console.error);
      sessionIdRef.current = null;
    }
    
    // Notify parent that call ended (reset streaming state in Chat)
    // Send empty AI response to finalize any pending message
    if (onAIResponse) {
      console.log('📞 Notifying parent: call ended, finalizing AI response');
      onAIResponse(''); // This will reset streaming state in Chat
    }
    
    // Now update UI states (after WebSocket is closed)
    setIsCallActive(false);
    setCallState('IDLE');
    setCurrentTranscript('');
    shouldSendAudioRef.current = false;
    setConnectionStatus('disconnected');
    
    // Reset the flag immediately so button becomes clickable again
    isEndingCallRef.current = false;
    console.log('✅ Call ended, button ready for new call');
  };

  const getButtonScale = (): number => {
    if (!isCallActive || callState !== 'USER_SPEAKING') return 1;
    
    // Smooth scaling based on voice level
    return 1 + (voiceLevel * 0.4); // Scale from 1.0 to 1.4
  };

  const getButtonColor = (): string => {
    if (!isCallActive) return 'bg-green-600 hover:bg-green-700';
    
    switch (callState) {
      case 'IDLE': return 'bg-gray-500';
      case 'LISTENING': return 'bg-blue-500 shadow-blue-500/50';
      case 'USER_SPEAKING': return 'bg-green-500 animate-pulse shadow-green-500/50';
      case 'AI_PROCESSING': return 'bg-yellow-500 animate-pulse shadow-yellow-500/50';
      case 'AI_SPEAKING': return 'bg-purple-600 animate-pulse shadow-purple-600/50';
      default: return 'bg-gray-500';
    }
  };

  const getTooltipText = (): string => {
    if (!audioSupported) return 'Audio not supported';
    if (disabled) return 'Voice calls disabled';
    if (!isCallActive) return 'Start voice call';
    
    switch (callState) {
      case 'IDLE': return 'Call ended';
      case 'LISTENING': return 'Listening... Start talking';
      case 'USER_SPEAKING': return 'Speaking... (tap to finish)';
      case 'AI_PROCESSING': return 'AI thinking...';
      case 'AI_SPEAKING': return `${character.name} is speaking`;
      default: return 'Voice call active';
    }
  };

  const handleButtonClick = (e: React.MouseEvent) => {
    e.preventDefault(); // Prevent form submission
    e.stopPropagation(); // Stop event bubbling
    
    const buttonDisabled = isCallActive 
      ? false 
      : (disabled || connectionStatus === 'connecting' || micPermission === 'denied');
    
    console.log(`🖱️ Button clicked:
      - isCallActive: ${isCallActive}
      - callState: ${callState}
      - disabled prop: ${disabled}
      - connectionStatus: ${connectionStatus}
      - micPermission: ${micPermission}
      - computed disabled: ${buttonDisabled}
      - isEndingCallRef: ${isEndingCallRef.current}`);
    
    // If button is disabled, log why
    if (buttonDisabled) {
      console.log('⚠️ Button is disabled, click ignored');
      return;
    }
    
    if (!isCallActive) {
      console.log('📞 Starting new call');
      startCall();
    } else {
      // Always end call when button is clicked during active call, regardless of state
      console.log(`🔴 FORCE ending call - current state: ${callState}`);
      endCall(true); // Force=true to bypass any guards
    }
  };

  if (!audioSupported) {
    return (
      <button
        disabled
        className="w-10 h-10 rounded-full bg-gray-400 text-white flex items-center justify-center opacity-50 cursor-not-allowed"
        title="Audio not supported in this browser"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728L5.636 5.636m12.728 12.728L18.364 5.636" />
        </svg>
      </button>
    );
  }

  return (
    <div className="relative">
      <button
        type="button"
        onClick={handleButtonClick}
        onMouseDown={(e) => e.preventDefault()} // Prevent any default behavior
        disabled={
          // During an active call, NEVER disable the button (user must be able to hang up)
          isCallActive 
            ? false 
            : (disabled || connectionStatus === 'connecting' || micPermission === 'denied')
        }
        className={`w-10 h-10 rounded-full ${getButtonColor()} text-white flex items-center justify-center transition-all duration-150 ease-out disabled:opacity-50 disabled:cursor-not-allowed shadow-lg`}
        title={getTooltipText()}
        style={{
          transform: `scale(${getButtonScale()})`,
          transition: 'transform 0.1s ease-out',
          zIndex: 50, // Ensure button is always on top
          pointerEvents: 'auto' // Ensure button always receives clicks
        }}
      >
        {connectionStatus === 'connecting' ? (
          <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
        ) : !isCallActive ? (
          // Phone icon for starting call
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
          </svg>
        ) : callState === 'LISTENING' ? (
          // Microphone icon for listening
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        ) : callState === 'USER_SPEAKING' ? (
          // Sound wave icon for user speaking
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 3v18M8 6v12M16 6v12M4 9v6M20 9v6" stroke="currentColor" strokeWidth={2} strokeLinecap="round"/>
          </svg>
        ) : callState === 'AI_PROCESSING' ? (
          // Brain/thinking icon for AI processing
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9.663 17h4.673M12 3v1m6.364 1.636l-.707.707M21 12h-1M4 12H3m3.343-5.657l-.707-.707m2.828 9.9a5 5 0 117.072 0l-.548.547A3.374 3.374 0 0014 18.469V19a2 2 0 11-4 0v-.531c0-.895-.356-1.754-.988-2.386l-.548-.547z" />
          </svg>
        ) : callState === 'AI_SPEAKING' ? (
          // Speaker waves icon for AI speaking
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072m2.828-9.9a9 9 0 010 12.728M5.586 15.536a5 5 0 001.414 1.414m0-9.9a5 5 0 011.414-1.414M9 12h.01M12 12h.01M15 12h.01" />
          </svg>
        ) : (
          // Hangup icon for ending call
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>
          </svg>
        )}
      </button>

      {/* Voice level indicator rings */}
      {isCallActive && callState === 'USER_SPEAKING' && (
        <>
          <div 
            className="absolute inset-0 rounded-full border-2 border-green-400 opacity-50 animate-ping"
            style={{
              transform: `scale(${1 + voiceLevel * 0.5})`
            }}
          />
          <div 
            className="absolute inset-0 rounded-full border border-green-300 opacity-30"
            style={{
              transform: `scale(${1.2 + voiceLevel * 0.3})`
            }}
          />
        </>
      )}

      {/* Live transcript tooltip - only shows your speech while talking */}
      {currentTranscript && isCallActive && (
        <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-3 py-2 bg-black/90 text-white text-xs rounded-lg max-w-md shadow-lg border border-white/20">
          <div className="text-green-300">
            <span className="font-semibold">You: </span>{currentTranscript}
          </div>
        </div>
      )}

      {/* Insufficient credits modal */}
      <Modal isOpen={creditsModalOpen} onClose={() => setCreditsModalOpen(false)} title="Not enough voice credits" size="lg">
        <p className="text-sm text-white/80 mb-4">You don't have enough voice credits to start a call.</p>
        <div className="flex justify-end gap-2">
          <button onClick={() => setCreditsModalOpen(false)} className="px-3 py-1 rounded bg-white/10 text-white">Close</button>
          <a href="/account" className="px-3 py-1 rounded bg-indigo-600 text-white">Buy credits</a>
        </div>
      </Modal>
    </div>
  );
}