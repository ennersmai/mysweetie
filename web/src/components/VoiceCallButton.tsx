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
  type: 'command' | 'transcript_update' | 'state_change' | 'error' | 'ai_response' | 'ai_response_chunk' | 'tts_finished' | 'tts_stream_end' | 'tts_sentence_complete' | 'calibration_start' | 'calibration_complete';
  command?: string;
  text?: string;
  is_final?: boolean;
  state?: keyof CallState;
  error?: string;
  duration?: number;
  threshold?: number;
  sampleCount?: number;
  message?: string;
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
  const [_voiceLevel, setVoiceLevel] = useState(0); // 0-1 reserved for future use
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
  const blobDecodeChainRef = useRef<Promise<void>>(Promise.resolve());
  const isStartingCallRef = useRef<boolean>(false);
  const ttsStreamEndReceivedRef = useRef<boolean>(false); // True once backend signals ALL TTS chunks sent

  const enqueueBlobForPlayback = useCallback((blob: Blob) => {
    blobDecodeChainRef.current = blobDecodeChainRef.current
      .catch(() => {
        // Swallow previous error so the chain keeps running.
      })
      .then(async () => {
        const buffer = await blob.arrayBuffer();
        if (audioManagerRef.current) {
          audioManagerRef.current.playAudio(buffer);
        }
      })
      .catch(error => {
        console.error('[FRONTEND] Failed to decode/play Blob audio chunk:', error);
      });
  }, []);

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

  // Voice level animation (kept for potential future use; animations now handled by CSS)
  useEffect(() => {
    if (!isCallActive || callState !== 'USER_SPEAKING') {
      if (animationFrameRef.current) {
        cancelAnimationFrame(animationFrameRef.current);
        animationFrameRef.current = null;
      }
      setVoiceLevel(0);
    }
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
        // WebSocket should already deliver ArrayBuffers, but keep an ordered fallback.
        enqueueBlobForPlayback(event.data);
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

              if (audioManagerRef.current) {
                // Always force-clear TTS mode when entering LISTENING, regardless of previous state.
                // This is the last safety net: ensures the VAD is at normal sensitivity even if
                // earlier tts_stream_end / completeTTSSession calls were missed or raced on iOS.
                if ('forceClearTTSMode' in audioManagerRef.current) {
                  (audioManagerRef.current as any).forceClearTTSMode();
                }

                // If we're transitioning from AI_SPEAKING to LISTENING, mark TTS session complete
                if (previousState === 'AI_SPEAKING') {
                  console.log('🏁 [FRONTEND STATE] Transition AI_SPEAKING → LISTENING: marking TTS session complete');
                  audioManagerRef.current.completeTTSSession();
                }
              }
            } else if (message.state === 'AI_SPEAKING') {
              console.log(`🔄 [FRONTEND STATE] 🔊 AI is speaking - audio should be muted`);
              // Reset the tts_stream_end flag for this new TTS session
              ttsStreamEndReceivedRef.current = false;
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
          console.log('🔚 TTS sentence complete signal received - IGNORING for complete text processing');
          // Ignore sentence boundaries - we want to process the entire text as one unit
          // Only flush when the entire TTS stream is complete
          break;
          
        case 'tts_stream_end':
          console.log('📡 TTS stream ended - backend finished sending ALL TTS chunks');
          ttsStreamEndReceivedRef.current = true;

          // Immediately lower VAD threshold — no more TTS echo is coming, so we can
          // reduce the 3x boost right now instead of waiting for completeTTSSession().
          // This fixes the STT onset truncation: the VAD will detect speech at normal
          // sensitivity as soon as the user starts talking after TTS finishes.
          if (audioManagerRef.current && 'forceClearTTSMode' in audioManagerRef.current) {
            (audioManagerRef.current as any).forceClearTTSMode();
          }

          // Flush any remaining PCM data now that we know no more is coming
          if (audioManagerRef.current && 'flushRemainingPCM' in audioManagerRef.current) {
            (audioManagerRef.current as any).flushRemainingPCM();
            console.log('Flushed remaining PCM data after tts_stream_end');
          }
          
          // Fallback: generous delay to let all queued audio finish playing
          setTimeout(() => {
            if (ttsStreamEndReceivedRef.current && callStateRef.current === 'AI_SPEAKING' && websocketRef.current?.readyState === WebSocket.OPEN) {
              console.log('[FALLBACK] Sending tts_playback_finished (tts_stream_end received, still in AI_SPEAKING)');
              ttsStreamEndReceivedRef.current = false;
              websocketRef.current.send(JSON.stringify({ type: 'tts_playback_finished' }));
            }
          }, 3000); // 3s fallback — generous to let all audio play
          break;
          
        case 'error':
          onError?.(message.error || 'Voice call error occurred');
          break;
          
        case 'calibration_start':
          console.log('🎯 Calibration start received:', message);
          if (audioManagerRef.current && websocketRef.current) {
            // Start calibration mode
            audioManagerRef.current.startCalibration();
            
            // Set up calibration callback to send audio chunks
            audioManagerRef.current.setCalibrationCallback((chunk: ArrayBuffer) => {
              if (websocketRef.current?.readyState === WebSocket.OPEN) {
                // Send binary audio chunk for calibration
                websocketRef.current.send(chunk);
              }
            });
            
            // After calibration duration, send calibration_complete message
            const calibrationDuration = (message as any).duration || 500;
            setTimeout(() => {
              if (audioManagerRef.current && websocketRef.current?.readyState === WebSocket.OPEN) {
                console.log('✅ Calibration period complete, sending calibration_complete');
                audioManagerRef.current.stopCalibration();
                audioManagerRef.current.setCalibrationCallback(null);
                websocketRef.current.send(JSON.stringify({ type: 'calibration_complete' }));
              }
            }, calibrationDuration);
          }
          break;
          
        case 'calibration_complete':
          console.log('✅ Calibration complete:', message);
          if (audioManagerRef.current) {
            audioManagerRef.current.stopCalibration();
            audioManagerRef.current.setCalibrationCallback(null);
            
            // Apply the calibrated threshold from backend
            if ((message as any).threshold !== undefined) {
              const calibratedThreshold = (message as any).threshold;
              audioManagerRef.current.setVADThreshold(calibratedThreshold);
              console.log(`🎯 Applied calibrated VAD threshold: ${calibratedThreshold}`);
            }
          }
          break;
      }
    } catch (error) {
      console.error('Error handling WebSocket message:', error);
    }
  }, [enqueueBlobForPlayback, onError]);

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
            // Store the error message if provided
            if (parsed?.message) {
              // The message will be displayed in the modal
            }
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
        console.log('Audio manager: All queued audio finished playing');
        
        // Only send tts_playback_finished if backend has confirmed ALL TTS chunks were sent.
        // Without this gate, the callback fires prematurely between multi-chunk TTS requests
        // (there's a 500ms-2s gap while the backend calls Resemble for the next chunk).
        if (!ttsStreamEndReceivedRef.current) {
          console.log('⏳ [FRONTEND] Audio queue empty but tts_stream_end NOT yet received — waiting for more chunks');
          return;
        }
        
        // All audio played AND backend confirmed done — safe to transition
        ttsStreamEndReceivedRef.current = false;
        shouldSendAudioRef.current = true;
        console.log('[FRONTEND] tts_stream_end received + all audio played → sending tts_playback_finished');
        
        if (websocketRef.current?.readyState === WebSocket.OPEN) {
          try {
            websocketRef.current.send(JSON.stringify({ type: 'tts_playback_finished' }));
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
            if (callStateRef.current === 'AI_SPEAKING' || callStateRef.current === 'AI_PROCESSING') {
              console.log('🛑 [FRONTEND] User interrupting AI speech - sending interrupt + user_speech_started');
              // CRITICAL: Manually set state to USER_SPEAKING immediately for responsive UI
              // Backend will also transition, but we do it here to avoid delay
              setCallState('USER_SPEAKING');
              callStateRef.current = 'USER_SPEAKING';
              shouldSendAudioRef.current = true;
              console.log('🔄 [FRONTEND STATE] Manually set state to USER_SPEAKING for immediate barge-in');
              
              // Send interrupt first to stop TTS
              websocketRef.current.send(JSON.stringify({ type: 'interrupt' }));
              // CRITICAL: Also send user_speech_started IMMEDIATELY so backend transitions to USER_SPEAKING
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
      websocketRef.current.binaryType = 'arraybuffer';

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

    if (isStartingCallRef.current) {
      console.log('Call initialization already in progress, ignoring duplicate start');
      return;
    }
    
    if (!audioSupported) {
      onError?.('Audio not supported in this browser');
      return;
    }

    isStartingCallRef.current = true;

    try {
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
    } catch (error) {
      console.error('Unexpected error while starting call:', error);
    } finally {
      isStartingCallRef.current = false;
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

  const getButtonColor = (): string => {
    if (!isCallActive) return 'bg-green-600 hover:bg-green-700';
    switch (callState) {
      case 'IDLE':         return 'bg-gray-500';
      case 'LISTENING':    return 'bg-blue-500';
      case 'USER_SPEAKING':return 'bg-green-500';
      case 'AI_PROCESSING':return 'bg-yellow-500';
      case 'AI_SPEAKING':  return 'bg-purple-600';
      default:             return 'bg-gray-500';
    }
  };

  // Extra CSS classes for the smooth animations (no animate-pulse)
  const getButtonAnimClass = (): string => {
    if (!isCallActive) return '';
    switch (callState) {
      case 'LISTENING':    return 'vcb-listening';
      case 'AI_SPEAKING':  return 'vcb-ai-speaking';
      default:             return '';
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
      : (disabled || connectionStatus === 'connecting' || micPermission === 'denied' || isStartingCallRef.current);
    
    console.log(`🖱️ Button clicked:
      - isCallActive: ${isCallActive}
      - callState: ${callState}
      - disabled prop: ${disabled}
      - connectionStatus: ${connectionStatus}
      - micPermission: ${micPermission}
      - computed disabled: ${buttonDisabled}
      - isEndingCallRef: ${isEndingCallRef.current}
      - isStartingCallRef: ${isStartingCallRef.current}`);
    
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
    <div className="relative flex-shrink-0">
      {/* Ripple rings for USER_SPEAKING — rendered behind button */}
      {isCallActive && callState === 'USER_SPEAKING' && (
        <>
          <div className="vcb-speaking-ring pointer-events-none" />
          <div className="vcb-speaking-ring-2 pointer-events-none" />
        </>
      )}

      {/* Spinning arc for AI_PROCESSING — rendered behind button */}
      {isCallActive && callState === 'AI_PROCESSING' && (
        <div className="vcb-processing-arc pointer-events-none" />
      )}

      <button
        type="button"
        onClick={handleButtonClick}
        onMouseDown={(e) => e.preventDefault()}
        disabled={
          isCallActive
            ? false
            : (disabled || connectionStatus === 'connecting' || micPermission === 'denied')
        }
        className={`relative w-12 h-12 rounded-full ${getButtonColor()} ${getButtonAnimClass()} vcb-base text-white flex items-center justify-center disabled:opacity-50 disabled:cursor-not-allowed shadow-lg`}
        title={getTooltipText()}
        style={{ zIndex: 50, pointerEvents: 'auto' }}
      >
        {connectionStatus === 'connecting' ? (
          <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
        ) : !isCallActive ? (
          // Phone icon
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
          </svg>
        ) : callState === 'LISTENING' ? (
          // Microphone icon
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
          </svg>
        ) : callState === 'USER_SPEAKING' ? (
          // Sound wave bars
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M12 3v18M8 6v12M16 6v12M4 9v6M20 9v6" stroke="currentColor" strokeWidth={2} strokeLinecap="round"/>
          </svg>
        ) : callState === 'AI_PROCESSING' ? (
          // Three dots
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/>
          </svg>
        ) : callState === 'AI_SPEAKING' ? (
          // Speaker wave
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.536 8.464a5 5 0 010 7.072M18.364 5.636a9 9 0 010 12.728M9 9v6l-3-2H4a1 1 0 01-1-1v-2a1 1 0 011-1h2l3-2z" />
          </svg>
        ) : (
          // Hangup
          <svg className="w-5 h-5" fill="currentColor" viewBox="0 0 24 24">
            <path d="M6.62 10.79c1.44 2.83 3.76 5.14 6.59 6.59l2.2-2.2c.27-.27.67-.36 1.02-.24 1.12.37 2.33.57 3.57.57.55 0 1 .45 1 1V20c0 .55-.45 1-1 1-9.39 0-17-7.61-17-17 0-.55.45-1 1-1h3.5c.55 0 1 .45 1 1 0 1.25.2 2.45.57 3.57.11.35.03.74-.25 1.02l-2.2 2.2z"/>
          </svg>
        )}
      </button>

      {/* Live transcript tooltip */}
      {currentTranscript && isCallActive && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 px-3 py-2 bg-black/90 text-white text-xs rounded-lg max-w-[200px] shadow-lg border border-white/20 whitespace-nowrap overflow-hidden text-ellipsis">
          <span className="text-green-300 font-semibold">You: </span>{currentTranscript}
        </div>
      )}

      {/* Insufficient credits modal */}
      <Modal isOpen={creditsModalOpen} onClose={() => setCreditsModalOpen(false)} title="Voice Credits Required" size="lg">
        <p className="text-sm text-white/80 mb-4">
          You're out of voice credits! To continue speaking with your companion, please choose a plan.
        </p>
        <div className="flex justify-end gap-2">
          <button onClick={() => setCreditsModalOpen(false)} className="px-3 py-1 rounded bg-white/10 text-white">Close</button>
          <a href="/subscribe" className="px-3 py-1 rounded bg-indigo-600 text-white">Choose a Plan</a>
        </div>
      </Modal>
    </div>
  );
}
