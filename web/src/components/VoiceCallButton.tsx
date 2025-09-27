/**
 * Voice Call Button Component
 * 
 * An animated voice call button that transforms into a voice activity detector
 * when active. Designed to be placed next to the send button.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioManager } from '../lib/audioUtils';
import { isWebAudioSupported, isMediaStreamSupported } from '../lib/audioUtils';
import { apiClient } from '../lib/apiClient';
import { supabase } from '../lib/supabaseClient';

export interface CallState {
  IDLE: 'IDLE';
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
  };
  conversationId?: string;
  onError?: (error: string) => void;
  onTranscript?: (transcript: string) => void;
  onAIResponse?: (response: string) => void;
  disabled?: boolean;
}

export interface CallMessage {
  type: 'command' | 'transcript_update' | 'state_change' | 'error' | 'ai_response';
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
  onAIResponse,
  disabled = false
}: VoiceCallButtonProps) {
  const [isCallActive, setIsCallActive] = useState(false);
  const [callState, setCallState] = useState<keyof CallState>('IDLE');
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [audioSupported, setAudioSupported] = useState(true);
  const [micPermission, setMicPermission] = useState<'granted' | 'denied' | 'prompt'>('prompt');
  const [voiceLevel, setVoiceLevel] = useState(0); // 0-1 for animation
  const [currentTranscript, setCurrentTranscript] = useState('');

  const audioManagerRef = useRef<AudioManager | null>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const animationFrameRef = useRef<number | null>(null);

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
    try {
      if (event.data instanceof ArrayBuffer) {
        // Binary audio data from AI
        if (audioManagerRef.current) {
          audioManagerRef.current.queueAudioData(event.data);
        }
        return;
      }

      // JSON messages
      const message: CallMessage = JSON.parse(event.data);
      
      switch (message.type) {
        case 'state_change':
          if (message.state) {
            setCallState(message.state);
          }
          break;
          
        case 'transcript_update':
          if (message.text) {
            setCurrentTranscript(message.text);
            // Send transcript to parent to add as chat message
            if (message.is_final && onTranscript) {
              onTranscript(message.text);
            }
          }
          break;
          
        case 'command':
          if (message.command === 'stop_playback' && audioManagerRef.current) {
            audioManagerRef.current.stopPlayback();
          }
          break;
          
        case 'ai_response':
          if (message.text && onAIResponse) {
            onAIResponse(message.text);
          }
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
        const errorText = await response.text();
        console.error('initializeCall: Backend error:', errorText);
        throw new Error(`Failed to initiate call: ${response.statusText}`);
      }

      const responseData = await response.json();
      const { sessionId } = responseData;
      sessionIdRef.current = sessionId;

      // Initialize audio manager
      audioManagerRef.current = new AudioManager();
      
      const captureInitialized = await audioManagerRef.current.initializeCapture();
      const playbackInitialized = await audioManagerRef.current.initializePlayback();
      
      if (!captureInitialized || !playbackInitialized) {
        onError?.('Failed to initialize audio system. Please check your browser settings.');
        setConnectionStatus('disconnected');
        return false;
      }

      // Establish WebSocket connection
      const { data: { session } } = await supabase.auth.getSession();
      const token = session?.access_token;
      if (!token) {
        onError?.('Authentication required. Please log in and try again.');
        setConnectionStatus('disconnected');
        return false;
      }

      const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const wsHost = process.env.NODE_ENV === 'development' ? 'localhost:3001' : window.location.host;
      const wsUrl_full = `${wsProtocol}//${wsHost}/ws/call/${sessionId}?token=${token}`;

      console.log('initializeCall: Connecting to WebSocket:', wsUrl_full);
      websocketRef.current = new WebSocket(wsUrl_full);

      return new Promise((resolve) => {
        const ws = websocketRef.current!;

        ws.onopen = () => {
          console.log('WebSocket connected');
          setConnectionStatus('connected');
          
          // Start audio capture
          if (audioManagerRef.current) {
            audioManagerRef.current.startCapture((audioData) => {
              if (ws.readyState === WebSocket.OPEN) {
                ws.send(audioData);
              }
            });
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
          setIsCallActive(false);
          
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

  const endCall = () => {
    setIsCallActive(false);
    setCallState('IDLE');
    setCurrentTranscript('');
    
    // Close WebSocket
    if (websocketRef.current) {
      websocketRef.current.close();
      websocketRef.current = null;
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

    setConnectionStatus('disconnected');
  };

  const getButtonScale = (): number => {
    if (!isCallActive || callState !== 'USER_SPEAKING') return 1;
    
    // Smooth scaling based on voice level
    return 1 + (voiceLevel * 0.4); // Scale from 1.0 to 1.4
  };

  const getButtonColor = (): string => {
    if (!isCallActive) return 'bg-green-600 hover:bg-green-700';
    
    switch (callState) {
      case 'IDLE': return 'bg-blue-500';
      case 'USER_SPEAKING': return 'bg-green-500 animate-pulse';
      case 'AI_PROCESSING': return 'bg-yellow-500 animate-pulse';
      case 'AI_SPEAKING': return 'bg-purple-500 animate-pulse';
      default: return 'bg-gray-500';
    }
  };

  const getTooltipText = (): string => {
    if (!audioSupported) return 'Audio not supported';
    if (disabled) return 'Voice calls disabled';
    if (!isCallActive) return 'Start voice call';
    
    switch (callState) {
      case 'IDLE': return 'Tap to speak, or just start talking';
      case 'USER_SPEAKING': return 'Speaking... (tap to finish)';
      case 'AI_PROCESSING': return 'AI thinking...';
      case 'AI_SPEAKING': return `${character.name} is speaking`;
      default: return 'Voice call active';
    }
  };

  const handleButtonClick = () => {
    if (!isCallActive) {
      startCall();
    } else if (callState === 'USER_SPEAKING') {
      // Manual trigger to end speech if VAD doesn't detect it
      console.log('Manually ending speech detection');
      // Send a message to backend to force transition to AI_PROCESSING
      if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
        websocketRef.current.send(JSON.stringify({ type: 'force_end_speech' }));
      }
    } else if (callState === 'AI_SPEAKING') {
      // Allow interruption by clicking
      console.log('Manually interrupting AI speech');
      if (websocketRef.current && websocketRef.current.readyState === WebSocket.OPEN) {
        websocketRef.current.send(JSON.stringify({ type: 'interrupt' }));
      }
    } else {
      endCall();
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
        onClick={handleButtonClick}
        disabled={disabled || connectionStatus === 'connecting' || micPermission === 'denied'}
        className={`w-10 h-10 rounded-full ${getButtonColor()} text-white flex items-center justify-center transition-all duration-150 ease-out disabled:opacity-50 disabled:cursor-not-allowed shadow-lg`}
        title={getTooltipText()}
        style={{
          transform: `scale(${getButtonScale()})`,
          transition: 'transform 0.1s ease-out'
        }}
      >
        {connectionStatus === 'connecting' ? (
          <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
        ) : !isCallActive ? (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
          </svg>
        ) : (
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M3 3l18 18m-5.314-5.314L14 14l-2 2 2 2m0 0l-2-2m2 2l2-2m-2 2l-2-2" />
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

      {/* Live transcript tooltip */}
      {currentTranscript && isCallActive && (
        <div className="absolute bottom-full left-1/2 transform -translate-x-1/2 mb-2 px-2 py-1 bg-black/80 text-white text-xs rounded whitespace-nowrap max-w-xs truncate">
          {currentTranscript}
        </div>
      )}
    </div>
  );
}