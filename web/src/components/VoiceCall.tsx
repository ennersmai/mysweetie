/**
 * Real-Time Voice Call Component
 * 
 * Provides a complete voice call interface with state management,
 * audio handling, and visual feedback.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { AudioManager, isWebAudioSupported, isMediaStreamSupported } from '../lib/audioUtils';
import { apiClient } from '../lib/apiClient';
import { supabase } from '../lib/supabaseClient';

export interface CallState {
  IDLE: 'IDLE';
  USER_SPEAKING: 'USER_SPEAKING'; 
  AI_PROCESSING: 'AI_PROCESSING';
  AI_SPEAKING: 'AI_SPEAKING';
}

export interface VoiceCallProps {
  characterId: string;
  character: {
    id: string;
    name: string;
    avatar_url?: string;
  };
  conversationId?: string;
  onCallEnd?: () => void;
  onError?: (error: string) => void;
}

export interface CallMessage {
  type: 'command' | 'transcript_update' | 'state_change' | 'error';
  command?: string;
  text?: string;
  is_final?: boolean;
  state?: keyof CallState;
  error?: string;
}

export default function VoiceCall({ 
  characterId, 
  character, 
  conversationId, 
  onCallEnd, 
  onError 
}: VoiceCallProps) {
  const [isCallActive, setIsCallActive] = useState(false);
  const [callState, setCallState] = useState<keyof CallState>('IDLE');
  const [currentTranscript, setCurrentTranscript] = useState('');
  const [connectionStatus, setConnectionStatus] = useState<'disconnected' | 'connecting' | 'connected'>('disconnected');
  const [audioSupported, setAudioSupported] = useState(true);
  const [micPermission, setMicPermission] = useState<'granted' | 'denied' | 'prompt'>('prompt');
  const [callDuration, setCallDuration] = useState(0);

  const audioManagerRef = useRef<AudioManager | null>(null);
  const websocketRef = useRef<WebSocket | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const callStartTimeRef = useRef<number>(0);
  const durationIntervalRef = useRef<NodeJS.Timeout | null>(null);

  // Check audio support on mount
  useEffect(() => {
    const checkSupport = async () => {
      const webAudioSupported = isWebAudioSupported();
      const mediaStreamSupported = isMediaStreamSupported();
      
      if (!webAudioSupported || !mediaStreamSupported) {
        setAudioSupported(false);
        onError?.('Your browser does not support real-time audio features. Please use a modern browser like Chrome, Firefox, or Safari.');
      }
    };

    checkSupport();
  }, [onError]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      endCall();
    };
  }, []);

  // Duration timer
  useEffect(() => {
    if (isCallActive) {
      durationIntervalRef.current = setInterval(() => {
        setCallDuration(Math.floor((Date.now() - callStartTimeRef.current) / 1000));
      }, 1000);
    } else {
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
        durationIntervalRef.current = null;
      }
      setCallDuration(0);
    }

    return () => {
      if (durationIntervalRef.current) {
        clearInterval(durationIntervalRef.current);
      }
    };
  }, [isCallActive]);

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
          }
          break;
          
        case 'command':
          if (message.command === 'stop_playback' && audioManagerRef.current) {
            audioManagerRef.current.stopPlayback();
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
      console.log('initializeCall: Calling backend /api/call/initiate with:', { characterId, conversationId });
      const response = await apiClient.post('/api/call/initiate', {
        characterId,
        conversationId
      });
      console.log('initializeCall: Backend response status:', response.status);

      if (!response.ok) {
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
      callStartTimeRef.current = Date.now();
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
      apiClient.post(`/api/call/${sessionIdRef.current}/end`, {}).catch(console.error);
      sessionIdRef.current = null;
    }

    setConnectionStatus('disconnected');
    onCallEnd?.();
  };

  const formatDuration = (seconds: number): string => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  };

  const getStateDisplay = (): string => {
    switch (callState) {
      case 'IDLE': return 'Listening...';
      case 'USER_SPEAKING': return 'You are speaking';
      case 'AI_PROCESSING': return 'AI thinking...';
      case 'AI_SPEAKING': return `${character.name} is speaking`;
      default: return 'Voice call';
    }
  };

  const getStateColor = (): string => {
    switch (callState) {
      case 'IDLE': return 'text-blue-500';
      case 'USER_SPEAKING': return 'text-green-500';
      case 'AI_PROCESSING': return 'text-yellow-500';
      case 'AI_SPEAKING': return 'text-purple-500';
      default: return 'text-gray-500';
    }
  };

  if (!audioSupported) {
    return (
      <div className="p-6 bg-red-50 border border-red-200 rounded-lg">
        <h3 className="text-lg font-semibold text-red-800 mb-2">Audio Not Supported</h3>
        <p className="text-red-600">
          Your browser doesn't support the required audio features for voice calls. 
          Please use a modern browser like Chrome, Firefox, or Safari.
        </p>
      </div>
    );
  }

  return (
    <div className="p-6 bg-white border border-gray-200 rounded-lg shadow-sm">
      <div className="flex items-center justify-between mb-6">
        <div className="flex items-center space-x-3">
          {character.avatar_url && (
            <img 
              src={character.avatar_url} 
              alt={character.name}
              className="w-12 h-12 rounded-full object-cover"
            />
          )}
          <div>
            <h3 className="text-lg font-semibold text-gray-900">{character.name}</h3>
            <p className="text-sm text-gray-500">Voice Call</p>
          </div>
        </div>
        
        {isCallActive && (
          <div className="text-right">
            <div className="text-sm text-gray-500">Duration</div>
            <div className="text-lg font-mono text-gray-900">
              {formatDuration(callDuration)}
            </div>
          </div>
        )}
      </div>

      <div className="space-y-4">
        {/* Call Status */}
        <div className="text-center">
          <div className={`text-lg font-medium ${getStateColor()}`}>
            {connectionStatus === 'connecting' ? 'Connecting...' : getStateDisplay()}
          </div>
          
          {connectionStatus === 'connected' && (
            <div className="flex justify-center mt-2">
              <div className={`w-3 h-3 rounded-full ${
                callState === 'USER_SPEAKING' ? 'bg-green-500 animate-pulse' :
                callState === 'AI_SPEAKING' ? 'bg-purple-500 animate-pulse' :
                callState === 'AI_PROCESSING' ? 'bg-yellow-500 animate-pulse' :
                'bg-blue-500'
              }`} />
            </div>
          )}
        </div>

        {/* Live Transcript */}
        {currentTranscript && (
          <div className="p-4 bg-gray-50 rounded-lg border">
            <div className="text-sm text-gray-600 mb-1">Live Transcript:</div>
            <div className="text-gray-900">{currentTranscript}</div>
          </div>
        )}

        {/* Call Controls */}
        <div className="flex justify-center space-x-4">
          {!isCallActive ? (
            <button
              onClick={startCall}
              disabled={connectionStatus === 'connecting' || micPermission === 'denied'}
              className="px-6 py-3 bg-green-600 text-white rounded-lg font-medium hover:bg-green-700 disabled:opacity-50 disabled:cursor-not-allowed flex items-center space-x-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 5a2 2 0 012-2h3.28a1 1 0 01.948.684l1.498 4.493a1 1 0 01-.502 1.21l-2.257 1.13a11.042 11.042 0 005.516 5.516l1.13-2.257a1 1 0 011.21-.502l4.493 1.498a1 1 0 01.684.949V19a2 2 0 01-2 2h-1C9.716 21 3 14.284 3 6V5z" />
              </svg>
              <span>Start Call</span>
            </button>
          ) : (
            <button
              onClick={endCall}
              className="px-6 py-3 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 flex items-center space-x-2"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M16 8l2-2m0 0l2-2m-2 2l-2-2m2 2l2 2M3 3l18 18m-5.314-5.314L14 14l-2 2 2 2m0 0l-2-2m2 2l2-2m-2 2l-2-2" />
              </svg>
              <span>End Call</span>
            </button>
          )}
        </div>

        {/* Permission Warning */}
        {micPermission === 'denied' && (
          <div className="p-4 bg-amber-50 border border-amber-200 rounded-lg">
            <p className="text-amber-800 text-sm">
              Microphone access is required for voice calls. Please enable microphone permissions in your browser settings and refresh the page.
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
