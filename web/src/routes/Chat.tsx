import { useState, useEffect, useRef, useCallback, useLayoutEffect, type FormEvent } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { apiClient } from '../lib/apiClient';
import RefreshIcon from '../assets/refresh.svg?react';
import DeleteIcon from '../assets/delete.svg?react';
import PinIcon from '../assets/pin.svg?react';
import SendIcon from '../assets/send.svg?react';
import { useLocalStorage } from '../hooks/useLocalStorage';
import Modal from '../components/Modal';
import VoiceCallButton from '../components/VoiceCallButton';
import MobileBottomNav from '../components/MobileBottomNav';

type Message = { id?: string; role: 'user' | 'assistant'; content: string };
type Memory = { id: string; memory_text: string };

function parseActions(text: string) {
  // Remove backslashes from rendering and convert *action* to <em>action</em>
  const withoutBackslashes = text.replace(/\\/g, '');
  return withoutBackslashes.replace(/\*(.*?)\*/g, '<em>$1</em>');
}

const BouncingLoader = () => (
  <div className="bouncing-loader">
    <div className="bounce1" />
    <div className="bounce2" />
    <div />
  </div>
);

export default function Chat() {
  useLayoutEffect(() => {
    try {
      if ('scrollRestoration' in window.history) {
        (window.history as any).scrollRestoration = 'manual';
      }
    } catch {}
    window.scrollTo({ top: 0, left: 0, behavior: 'auto' });
  }, []);
  const { characterId, conversationId } = useParams();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const messagesRef = useRef<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
	const [modelKey, setModelKey] = useState(() => {
    return localStorage.getItem('modelKey') || 'Sweet Myth';
  });
  const [voiceKey, setVoiceKey] = useLocalStorage('voiceKey', 'luna');
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [fantasyMode, setFantasyMode] = useState(false);
  const [nsfwMode, setNsfwMode] = useState(false); // Add nsfwMode state
  const messagesListRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLTextAreaElement | null>(null);
  const firstTurnRef = useRef<boolean>(false);
  const stickToBottomRef = useRef(true);
  const [character, setCharacter] = useState<{ id: string; name: string; avatar_url: string | null; description: string | null; system_prompt: string | null; } | null>(null);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(conversationId || null);
  const [isPremium, setIsPremium] = useState(false);
  const [planTier, setPlanTier] = useState<'free' | 'basic' | 'premium'>('free');
  const [voiceRemaining, setVoiceRemaining] = useState<number>(0);
  const [welcomeCredits, setWelcomeCredits] = useState<number>(0);
  const [textMessagesToday, setTextMessagesToday] = useState<number>(0);
  const [cooldownMsg, setCooldownMsg] = useState<string | null>(null);
  const [dailyLimitMsg, setDailyLimitMsg] = useState<string | null>(null);
  const [recentConversations, setRecentConversations] = useState<any[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [confirmMemoryId, setConfirmMemoryId] = useState<string | null>(null);
  const [confirmChatId, setConfirmChatId] = useState<string | null>(null);
  const [pinningMessageIndex, setPinningMessageIndex] = useState<number | null>(null);
  const [isNsfwModalOpen, setIsNsfwModalOpen] = useState(false);
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(false);
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(false);

  // Natural text streaming with slight delay to match TTS pace
  const streamTextWithDelay = useCallback((chunk: string) => {
    // Add a small delay to make text appear more naturally with TTS
    setTimeout(() => {
      assistantMessageRef.current += chunk;
      
      setMessages(prev => {
        const next = [...prev];
        const idx = currentAssistantIndexRef.current;
        if (idx != null && idx >= 0 && idx < next.length && next[idx]?.role === 'assistant') {
          next[idx] = { ...next[idx], content: assistantMessageRef.current };
        }
        return next;
      });
      
      // Auto-scroll during streaming
      setTimeout(() => {
        if (!stickToBottomRef.current) return;
        const el = messagesListRef.current;
        if (el) el.scrollTop = el.scrollHeight;
      }, 10);
    }, 50); // Small delay to create natural pacing
  }, []);

  // Auto-resize textarea function
  const autoResizeTextarea = (textarea: HTMLTextAreaElement) => {
    textarea.style.height = 'auto';
    textarea.style.height = Math.min(textarea.scrollHeight, 120) + 'px'; // Max height of 120px
  };
  const assistantMessageRef = useRef('');
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window !== 'undefined' && 'matchMedia' in window) {
      return window.matchMedia('(min-width: 768px)').matches;
    }
    return false;
  });
  const didLoadHistoryRef = useRef(false);
  const wordBufferRef = useRef('');
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);
  const currentAssistantIndexRef = useRef<number | null>(null);
  const [editTarget, setEditTarget] = useState<{ index: number; id?: string; text: string } | null>(null);
  const [editText, setEditText] = useState('');
  const [longPressMessage, setLongPressMessage] = useState<{ index: number; isUser: boolean } | null>(null);
  const longPressTimerRef = useRef<number | null>(null);

  const MODEL_OPTIONS: { key: string; desc: string; premium?: boolean }[] = [
    { key: 'Sweet Myth', desc: 'Grok-4 Fast — quick, capable general model' },
    { key: 'Swift Muse', desc: 'Dolphin Mistral 24B (Venice) — creative and expressive' },
    { key: 'Crystal Focus', desc: 'ReMM Slerp L2 13B — concise, logical responses.', premium: true },
    { key: 'Midnight Nova', desc: 'Anubis 70B — powerful roleplay and character immersion.', premium: true },
    { key: 'Silver Whisper', desc: 'Euryale 70B — advanced storytelling with rich detail.', premium: true },
  ];
  // Import voices from centralized config
  const ALLOWED_VOICES = [
    // Character voices (Realistic)
    'layla',
    'ava',
    'mia',
    'emma',
    'aria',
    'natalia',
    
    // Character voices (Anime)
    'star',
    'natsuki',
    'mary',
    'lana',
    'clover',
    'chloe',
    
    // General selection voices
    'seraphina',
    'celeste',
    'aurora',
    'luna',
  ];
  // HTTP PCM TTS via Arcana
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ttsPlayheadRef = useRef<number>(0); // seconds scheduled ahead in AudioContext time
  const ttsSampleRateRef = useRef<number>(24000); // Use 24000 Hz to match TTS output
  const ttsSentenceBufRef = useRef<string>('');
  const ttsQueueRef = useRef<{ speaker: string; text: string }[]>([]);
  const ttsProcessingRef = useRef<boolean>(false);
  const ttsStreamingRef = useRef<boolean>(false);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const ttsSourcesRef = useRef<AudioBufferSourceNode[]>([]);
  const uiTextBufferRef = useRef<string>(''); // Accumulator for UI streaming
  // Accumulator to create larger, click-free PCM buffers
  const ttsPcmAccumRef = useRef<number[]>([]);
  const PCM_MIN_SAMPLES = 2400; // ~100ms at 24kHz - balanced for smooth playback without artifacts
  const ttsValidatedBinaryRef = useRef<boolean>(false);
  const ttsFlushTimerRef = useRef<number | null>(null);
  // Promises to resolve when current TTS playback fully ends
  const ttsEndResolversRef = useRef<Array<() => void>>([]);
  // Preserve 1 leftover byte between chunks to maintain 16-bit alignment
  const ttsCarryByteRef = useRef<number | null>(null);
  // Track when the network stream has fully completed for the current sentence
  const ttsNetworkDoneRef = useRef<boolean>(false);
  // Monotonic counter to tag each TTS PCM request for debugging/correlation
  const ttsRequestSeqRef = useRef<number>(0);
  // Whether we've received a final full response for the current turn
  const ttsGotFinalRef = useRef<boolean>(false);
  // Safe max characters per TTS request to avoid provider truncation
  const TTS_MAX_CHARS = 500;

  // Extract complete sentences from accumulated text buffer
  const extractCompleteSentencesFromBuffer = (): string => {
    const boundaryRegex = /((?:\.\.\.|…|[\.\!\?])[\)\]"']?(?:\s+|$))/;
    const buffer = uiTextBufferRef.current;
    let completedText = '';
    let remaining = buffer;
    
    while (true) {
      const match = remaining.match(boundaryRegex);
      if (!match) break;
      const idx = match.index! + match[0].length;
      const sentence = remaining.slice(0, idx);
      
      // CHECK: Sentence contains proper punctuation (allow quotes/parens after)
      if (/[\.\!\?][\)\]"']?$/.test(sentence.trim())) {
        completedText += sentence;
        remaining = remaining.slice(idx);
      } else {
        break;
      }
    }
    
    // Update buffer to only contain incomplete text
    uiTextBufferRef.current = remaining;
    return completedText;
  };

  // Split long sentences into smaller TTS-safe segments preferring punctuation/word boundaries
  const segmentTextForTts = (text: string): string[] => {
    const s = cleanTtsText(text);
    if (s.length <= TTS_MAX_CHARS) return [s];
    const segments: string[] = [];
    let remaining = s;
    while (remaining.length > 0) {
      if (remaining.length <= TTS_MAX_CHARS) {
        segments.push(remaining);
        break;
      }
      // Try to find a natural split point within the window
      const window = remaining.slice(0, TTS_MAX_CHARS);
      // Prefer strong punctuation
      let splitIdx = Math.max(
        window.lastIndexOf('. '),
        window.lastIndexOf('! '),
        window.lastIndexOf('? '),
      );
      // Then commas/semicolons/colons/em-dash
      if (splitIdx < 0) {
        splitIdx = Math.max(
          window.lastIndexOf(', '),
          window.lastIndexOf('; '),
          window.lastIndexOf(': '),
          window.lastIndexOf(' — '),
          window.lastIndexOf(' - '),
        );
      }
      // Then whitespace
      if (splitIdx < 0) {
        splitIdx = window.lastIndexOf(' ');
      }
      // Fallback hard cut if no boundary found
      if (splitIdx < 0) splitIdx = TTS_MAX_CHARS;
      const part = remaining.slice(0, splitIdx + 1).trim();
      if (part.length > 0) segments.push(part);
      remaining = remaining.slice(splitIdx + 1).trimStart();
    }
    return segments;
  };
  // Crossfade handling between scheduled buffers
  const ttsLastGainRef = useRef<GainNode | null>(null);
  const ttsLastEndTimeRef = useRef<number>(0);
  const TTS_CROSSFADE_S = 0.008; // 8ms overlap to hide boundaries

  const cleanTtsText = (s: string) => {
    // Remove asterisk emphasis and any html tags, collapse whitespace
    const noStars = s.replace(/\*/g, '');
    const noTags = noStars.replace(/<[^>]+>/g, '');
    return noTags.replace(/\s+/g, ' ').trim();
  };

  // Removed WS base; using HTTP endpoint

  const ensureAudioContext = async () => {
    if (!audioCtxRef.current) {
      const Ctx = (window as any).AudioContext || (window as any).webkitAudioContext;
      // Create AudioContext at 24000 Hz to match TTS output
      audioCtxRef.current = new Ctx({ sampleRate: 24000 });
      console.log('Created new AudioContext with sample rate:', audioCtxRef.current?.sampleRate);
      // Update TTS sample rate to match AudioContext
      ttsSampleRateRef.current = audioCtxRef.current?.sampleRate || 24000;
    }
    if (audioCtxRef.current?.state === 'suspended') {
      try { 
        await audioCtxRef.current.resume(); 
        console.log('AudioContext resumed');
      } catch (e) {
        console.warn('Failed to resume AudioContext:', e);
      }
    }
    return audioCtxRef.current!;
  };


  // Flush accumulated PCM into a single buffer with small fades at the edges
  const flushAccumulatedPcm = (force: boolean = false) => {
    const audioCtx = audioCtxRef.current;
    if (!audioCtx) return;
    const acc = ttsPcmAccumRef.current;
    if (!acc || acc.length === 0) {
      // Clear flush timer if accumulator is empty
      if (ttsFlushTimerRef.current) {
        clearTimeout(ttsFlushTimerRef.current);
        ttsFlushTimerRef.current = null;
      }
      return;
    }
    if (!force && acc.length < PCM_MIN_SAMPLES) return;
    
    // Clear flush timer since we're flushing now
    if (ttsFlushTimerRef.current) {
      clearTimeout(ttsFlushTimerRef.current);
      ttsFlushTimerRef.current = null;
    }

    // Take at least PCM_MIN_SAMPLES, leave the rest for next flush
    const take = force ? acc.length : Math.max(PCM_MIN_SAMPLES, Math.floor(acc.length / PCM_MIN_SAMPLES) * PCM_MIN_SAMPLES);
    const chunk = acc.splice(0, take);

    if (chunk.length === 0) return;

    // No per-chunk fade to avoid periodic clicks; schedule contiguous buffers instead

    const float = new Float32Array(chunk);
    const audioBuffer = audioCtx.createBuffer(1, float.length, 24000);
    audioBuffer.getChannelData(0).set(float);

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    console.log(`🎵 Created audio source with buffer duration: ${audioBuffer.duration}s`);
    // Create a gain node for per-buffer fade and crossfade
    const gain = audioCtx.createGain();
    source.connect(gain);
    gain.connect(audioCtx.destination);

    // Compute start time with small overlap for crossfade
    let startAt = Math.max(audioCtx.currentTime + 0.01, ttsPlayheadRef.current - TTS_CROSSFADE_S);
    const endAt = startAt + audioBuffer.duration;

    // Apply crossfade ramps
    if (ttsLastGainRef.current && ttsLastEndTimeRef.current > 0) {
      const prevEnd = ttsLastEndTimeRef.current;
      const downStart = Math.max(audioCtx.currentTime, prevEnd - TTS_CROSSFADE_S);
      try {
        ttsLastGainRef.current.gain.setValueAtTime(1, downStart);
        ttsLastGainRef.current.gain.linearRampToValueAtTime(0, prevEnd);
      } catch {}
      try {
        gain.gain.setValueAtTime(0, startAt);
        gain.gain.linearRampToValueAtTime(1, startAt + TTS_CROSSFADE_S);
      } catch {}
    } else {
      try {
        gain.gain.setValueAtTime(1, startAt);
      } catch {}
    }

    source.start(startAt);
    console.log(`🎵 Started audio source at ${startAt}s, will end at ${endAt}s`);
    ttsSourcesRef.current.push(source);
    ttsPlayheadRef.current = endAt;
    ttsLastGainRef.current = gain;
    ttsLastEndTimeRef.current = endAt;

    source.onended = () => {
      // Remove this source first
      ttsSourcesRef.current = ttsSourcesRef.current.filter(s => s !== source);
      const remaining = ttsPlayheadRef.current - audioCtx.currentTime;
      // Only mark streaming false when network is done, accumulator empty, and no more sources remain
      if (remaining <= 0.03 && ttsNetworkDoneRef.current && ttsPcmAccumRef.current.length === 0 && ttsSourcesRef.current.length === 0) {
        setPlayingIndex(null);
        ttsStreamingRef.current = false;
        console.log('🎵 TTS audio finished, streaming set to false');
        // Notify any waiters that playback fully ended
        const resolvers = ttsEndResolversRef.current.splice(0);
        resolvers.forEach((r) => {
          try { r(); } catch {}
        });
      }
    };
  };

  const schedulePcmChunk = (arrayBuffer: ArrayBuffer) => {
    const audioCtx = audioCtxRef.current;
    if (!audioCtx) {
      console.warn('🎵 No AudioContext available for PCM chunk');
      return;
    }
    console.log(`🎵 Processing PCM chunk: ${arrayBuffer.byteLength} bytes`);

    // Build a properly aligned byte view preserving 16-bit boundaries across chunks
    let u8 = new Uint8Array(arrayBuffer);
    if (ttsCarryByteRef.current !== null) {
      const merged = new Uint8Array(u8.length + 1);
      merged[0] = ttsCarryByteRef.current;
      merged.set(u8, 1);
      u8 = merged;
      ttsCarryByteRef.current = null;
    }
    if (u8.length === 0) return;
    if ((u8.length & 1) === 1) {
      // Save the last byte to prepend to the next chunk
      ttsCarryByteRef.current = u8[u8.length - 1] as number;
      u8 = u8.subarray(0, u8.length - 1);
    }
    if (u8.length === 0) return;

    // Validate that this looks like binary (not a JSON/text body) on first chunk
    if (!ttsValidatedBinaryRef.current) {
      const probe = u8.subarray(0, Math.min(64, u8.length));
      let printable = 0;
      for (let i = 0; i < probe.length; i++) {
        const b = probe[i];
        if (b === 9 || b === 10 || b === 13 || (b >= 32 && b <= 126)) printable++;
      }
      // If majority is printable ASCII, likely not PCM; abort playback
      if (printable / probe.length > 0.7) {
        console.error('Received non-PCM (text) data in PCM stream; aborting playback');
        ttsPcmAccumRef.current = [];
        ttsStreamingRef.current = false;
        return;
      }
      ttsValidatedBinaryRef.current = true;
    }

    // Parse as little-endian 16-bit signed PCM using DataView for robustness
    const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
    for (let i = 0; i < u8.byteLength; i += 2) {
      const s = dv.getInt16(i, true); // little-endian
      // Normalize to [-1, 1]
      ttsPcmAccumRef.current.push(Math.max(-1, Math.min(1, s / 32768)));
    }

    // Flush accumulated PCM - try immediate flush first
    flushAccumulatedPcm(false);
    
    // If we have samples but didn't flush (below threshold), set a timeout to flush soon
    // This prevents long pauses when receiving small chunks
    if (ttsPcmAccumRef.current.length > 0 && ttsPcmAccumRef.current.length < PCM_MIN_SAMPLES && !ttsFlushTimerRef.current) {
      // Flush after 50ms if we haven't reached the minimum threshold
      // This ensures smooth playback even with small chunks without causing artifacts
      ttsFlushTimerRef.current = window.setTimeout(() => {
        ttsFlushTimerRef.current = null;
        flushAccumulatedPcm(true); // Force flush even if below threshold
      }, 50);
    }
  };

  const stopTtsNow = useCallback(() => {
    try { ttsAbortRef.current?.abort(); } catch {}
    ttsAbortRef.current = null;
    // Clear flush timer
    if (ttsFlushTimerRef.current) {
      clearTimeout(ttsFlushTimerRef.current);
      ttsFlushTimerRef.current = null;
    }
    // Stop all scheduled sources
    const audioCtx = audioCtxRef.current;
    ttsSourcesRef.current.forEach((s) => {
      try { s.stop(0); } catch {}
      try { s.disconnect(); } catch {}
    });
    ttsSourcesRef.current = [];
    if (audioCtx) {
      try { ttsPlayheadRef.current = Math.max(audioCtx.currentTime, 0); } catch { ttsPlayheadRef.current = 0; }
    } else {
      ttsPlayheadRef.current = 0;
    }
    // Clear any pending sentence buffers and queue
    ttsSentenceBufRef.current = '';
    ttsQueueRef.current = [];
    ttsStreamingRef.current = false;
    ttsProcessingRef.current = false;
    setPlayingIndex(null);
    // Clear any accumulated PCM to avoid tail artifacts
    ttsPcmAccumRef.current = [];
    // Reset validation for next stream
    ttsValidatedBinaryRef.current = false;
    // Reset carry byte between streams
    ttsCarryByteRef.current = null;
    // Reset network-done flag
    ttsNetworkDoneRef.current = false;
    // Notify any waiters that playback ended due to stop
    const resolvers = ttsEndResolversRef.current.splice(0);
    resolvers.forEach((r) => {
      try { r(); } catch {}
    });
  }, []);

  // Speak a single sentence via HTTP PCM endpoint
  const speakPcm = useCallback(async (speaker: string, text: string) => {
    if (!text.trim()) return;
    
    // Prevent concurrent TTS network requests (but allow if network is done, even if audio is playing)
    // We can start fetching next TTS while current audio is still playing
    if (ttsStreamingRef.current && !ttsNetworkDoneRef.current) {
      console.warn('🚫 TTS network stream already active, skipping request');
      return;
    }
    
    const reqId = ++ttsRequestSeqRef.current;
    console.log(`🎤 Starting TTS[#${reqId}] with voice "${speaker}": "${text.substring(0, 50)}..."`);
    
    // Stop any existing audio sources before starting new TTS
    ttsSourcesRef.current.forEach((s) => {
      try { s.stop(0); } catch {}
      try { s.disconnect(); } catch {}
    });
    ttsSourcesRef.current = [];
    
    await ensureAudioContext();
    // Do not reset playhead here to ensure strict sequential playback across sentences
    const controller = new AbortController();
    ttsAbortRef.current = controller;
    ttsStreamingRef.current = true;
    // Reset PCM accumulator for a fresh stream
    ttsPcmAccumRef.current = [];
    // Clear any pending flush timer
    if (ttsFlushTimerRef.current) {
      clearTimeout(ttsFlushTimerRef.current);
      ttsFlushTimerRef.current = null;
    }
    // Re-validate binary for new stream
    ttsValidatedBinaryRef.current = false;
    // Reset carry byte
    ttsCarryByteRef.current = null;
    // Network not done until we finish reading
    ttsNetworkDoneRef.current = false;
    // Clear any pending network end resolvers
    ttsNetworkEndResolversRef.current = [];
    
    try {
      let res: Response;
      try {
        res = await apiClient.streamAudio('/tts/pcm', {
        text,
        speaker,
        modelId: 'arcana',
        samplingRate: 24000, // Use Rime.ai's native sample rate
        lang: 'eng',
        }, controller.signal as any);
      } catch (e) {
        console.warn(`TTS[#${reqId}] request aborted/failed:`, e);
        return;
      }
      if (!res.ok) {
        console.error(`TTS[#${reqId}] request failed with status: ${res.status}`);
        return;
      }
      if (!res.body) {
        console.error(`TTS[#${reqId}] no response body`);
        return;
      }
      console.log(`TTS[#${reqId}] got response, starting to read PCM data`);
      const reader = res.body.getReader();
      // Read streaming PCM chunks directly (backend parses WAV to PCM)
      let chunkCount = 0;
      while (true) {
        let readResult;
        try { readResult = await reader.read(); } catch (e) { 
          console.warn(`TTS[#${reqId}] reader error:`, e);
          break; 
        }
        const { value, done } = readResult;
        if (done) {
          console.log(`TTS[#${reqId}] stream ended, received ${chunkCount} chunks`);
          break;
        }
        if (value) {
          chunkCount++;
          const ab = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
          console.log(`🎵 Received PCM chunk ${chunkCount}: ${ab.byteLength} bytes`);
          schedulePcmChunk(ab);
        }
      }
      // Ensure any remaining accumulated samples are played
      flushAccumulatedPcm(true);
      // Mark network as done so onended can finalize state when buffers drain
      ttsNetworkDoneRef.current = true;
      console.log(`🎤 TTS[#${reqId}] network done`);
      // Notify queue processor that network stream ended (can start next TTS)
      const networkResolvers = ttsNetworkEndResolversRef.current.splice(0);
      networkResolvers.forEach((r) => { try { r(); } catch {} });
    } finally {
      // Don't set ttsStreamingRef.current = false here
      // It will be set to false when audio actually finishes playing
    }
  }, []);

  // Track when network stream ends (not playback) for faster queue processing
  const ttsNetworkEndResolversRef = useRef<Array<() => void>>([]);
  
  const processTtsQueue = useCallback(async () => {
    if (ttsProcessingRef.current) return;
    ttsProcessingRef.current = true;
    try {
      while (ttsQueueRef.current.length > 0) {
        const { speaker, text } = ttsQueueRef.current.shift()!;
        // Ensure previous network stream is done before starting next (not waiting for playback)
        if (ttsStreamingRef.current) {
          await new Promise<void>((resolve) => {
            // If network already done, resolve immediately
            if (!ttsStreamingRef.current || ttsNetworkDoneRef.current) return resolve();
            ttsNetworkEndResolversRef.current.push(resolve);
          });
        }
        // Start TTS - speakPcm will return when network stream ends
        await speakPcm(speaker, text);
        // speakPcm already waits for network stream to end, so we can immediately continue to next
        if (stickToBottomRef.current) {
          const el = messagesListRef.current;
          if (el) el.scrollTop = el.scrollHeight;
        }
      }
    } finally {
      ttsProcessingRef.current = false;
    }
  }, [speakPcm]);

  const enqueueTts = useCallback((speaker: string, text: string) => {
    const trimmed = cleanTtsText(text);
    if (!trimmed) return;
    // Split into safe-sized segments to avoid provider-side truncation
    const parts = segmentTextForTts(trimmed);
    console.log(`🎵 Enqueueing TTS ${parts.length} segment(s) (processing: ${ttsProcessingRef.current}, streaming: ${ttsStreamingRef.current})`);
    parts.forEach((p, idx) => {
      ttsQueueRef.current.push({ speaker, text: p });
      if (idx === 0) console.log(`🎵 TTS segment[1/${parts.length}]: "${p.substring(0, 60)}${p.length > 60 ? '…' : ''}" (${p.length} chars)`);
    });
    
    // If already processing, just return (queue will be processed)
    if (ttsProcessingRef.current) {
      console.log('🎵 TTS already processing, appended segments to queue');
      return;
    }
    
    // Start processing the queue
    console.log('🎵 Starting TTS queue processing');
    processTtsQueue();
  }, [processTtsQueue]);

  // Removed WS ttsSend/ttsEnd

  const ttsAppendSentence = (chunk: string) => {
    if (!chunk) return;
    // Normalize and accumulate
    const incoming = chunk.replace(/\s+/g, ' ');
    ttsSentenceBufRef.current += incoming;

    // Only split on terminal punctuation to avoid speaking text that might get deleted
    // Be conservative - only speak sentences that end with proper punctuation
    const boundaryRegex = /((?:\.\.\.|…|[\.\!\?])[\)\]"']?(?:\s+|$))/;
    let buf = ttsSentenceBufRef.current;
    while (true) {
      const match = buf.match(boundaryRegex);
      if (!match) break;
      const idx = match.index! + match[0].length;
      const full = buf.slice(0, idx);
      const sentence = cleanTtsText(full);
      
      // CHECK: Only stream if sentence has proper punctuation (allow quotes/parens after)
      if (sentence.length >= 2 && /[\.\!\?][\)\]"']?$/.test(sentence.trim())) {
        enqueueTts((voiceKey || 'luna').toLowerCase(), sentence);
      }
      buf = buf.slice(idx);
    }
    ttsSentenceBufRef.current = buf;
  };

  // (removed) sentence-based buffering; we now stream tokens directly to Rime

  // Legacy HTTP audio queue playback removed

  // Removed legacy HTTP TTS chunking path
  // Legacy HTTP processing removed


  useEffect(() => {
    localStorage.setItem('modelKey', modelKey);
  }, [modelKey]);

  // Ensure stored voice matches allowed Arcana voices
  useEffect(() => {
    if (!ALLOWED_VOICES.includes((voiceKey || '').toLowerCase())) {
      setVoiceKey('luna');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const el = messagesListRef.current;
    if (!el) return;
    const onScroll = () => {
      const nearBottom = (el.scrollHeight - el.scrollTop - el.clientHeight) < 80;
      stickToBottomRef.current = nearBottom;
    };
    onScroll();
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (!stickToBottomRef.current) return;
    const el = messagesListRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight;
  }, [messages.length, streaming]);

  useEffect(() => {
    // Track desktop breakpoint for autofocus behavior
    const mq = window.matchMedia('(min-width: 768px)');
    const apply = (e: MediaQueryList | MediaQueryListEvent) => setIsDesktop((e as MediaQueryList).matches ?? (e as MediaQueryListEvent).matches);
    apply(mq);
    mq.addEventListener('change', apply as any);
    return () => mq.removeEventListener('change', apply as any);
  }, []);

  useEffect(() => {
    if (isDesktop) {
      const t = setTimeout(() => inputRef.current?.focus(), 50);
      return () => clearTimeout(t);
    }
  }, [isDesktop]);

  // Ensure input refocuses right after streaming completes (desktop/mobile)
  useEffect(() => {
    if (streaming) return;
    const t = setTimeout(() => {
      try {
        (inputRef.current as any)?.focus?.({ preventScroll: true });
      } catch {
        inputRef.current?.focus?.();
      }
    }, 50);
    return () => clearTimeout(t);
  }, [streaming, isDesktop]);

  useEffect(() => {
    // Initial focus on mount for desktop
    if (isDesktop) {
      const t = setTimeout(() => inputRef.current?.focus(), 100);
      return () => clearTimeout(t);
    }
  }, []);

  useEffect(() => {
    // Keep state in sync with route param so changing URL loads corresponding history
    setCurrentConversationId(conversationId || null);
  }, [conversationId]);

  useEffect(() => {
    const loadCharacter = async () => {
      if (!characterId) return;
      const { data } = await supabase
        .from('characters')
        .select('id, name, avatar_url, description, system_prompt, voice_id')
        .eq('id', characterId)
        .maybeSingle();
      setCharacter((data as any) ?? null);
    };
    loadCharacter();
  }, [characterId]);

  // Set voice based on character when character loads
  useEffect(() => {
    if (!character) return;
    
    // Determine voice: use character's voice_id if valid, otherwise use character name if it matches a voice, otherwise keep current voiceKey
    const characterVoiceId = (character as any).voice_id;
    const characterNameLower = character.name.toLowerCase();
    
    let newVoice: string;
    if (characterVoiceId && ALLOWED_VOICES.includes(characterVoiceId.toLowerCase())) {
      newVoice = characterVoiceId.toLowerCase();
    } else if (ALLOWED_VOICES.includes(characterNameLower)) {
      newVoice = characterNameLower;
    } else {
      // Character name doesn't match a voice, keep current voiceKey (don't change it)
      return;
    }
    
    // Only update if different from current voiceKey
    if (newVoice !== voiceKey) {
      setVoiceKey(newVoice);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [character]);

  // Keep live reference to messages to avoid stale closures
  useEffect(() => {
    messagesRef.current = messages;
  }, [messages]);

  useEffect(() => {
    const loadHistory = async () => {
      if (!currentConversationId) {
        setMessages([]); // Clear messages if there's no conversation
        didLoadHistoryRef.current = true;
        return;
      }
      try {
        const res = await apiClient.get(`/chat/history/${currentConversationId}`);
        if (res.ok) {
          const ct = res.headers.get('content-type') || '';
          if (!ct.includes('application/json')) {
            console.error('Chat history response is not JSON:', { url: res.url, status: res.status, contentType: ct });
            setMessages([]);
            return;
          }
          const data = await res.json();
          // Only replace messages if not currently streaming. Avoid wiping the assistant placeholder mid-stream.
          const mapped = (data || []).map((m: any) => ({ id: m.id as string, role: m.role as 'user' | 'assistant', content: m.content as string }));
          if (!streaming) {
            if (Array.isArray(data) && data.length > 0) {
              setMessages(mapped);
            } else {
              setMessages([]);
            }
          }
          didLoadHistoryRef.current = true;
        } else if (res.status === 404) {
          // New conversation with no history yet; avoid clearing during streaming
          if (!streaming) setMessages([]);
          didLoadHistoryRef.current = true;
        } else {
          // For other errors (like 500), log it but don't redirect
          console.error('Failed to load chat history with status:', res.status);
          setMessages([]);
          didLoadHistoryRef.current = true;
        }
      } catch (e) {
        console.error('Failed to load chat history:', e);
        setMessages([]);
        didLoadHistoryRef.current = true;
      }
    };
    loadHistory();
  }, [currentConversationId, characterId]);

  useEffect(() => {
    const loadPremiumAndNsfw = async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { data } = await supabase
        .from('profiles')
        .select('is_premium, plan_tier, voice_trials_used, voice_quota_used, nsfw_enabled, voice_credits, welcome_credits, text_messages_today, last_text_reset_date')
        .eq('id', u.user.id)
        .maybeSingle();
      const premium = Boolean(data?.is_premium);
      setIsPremium(premium);
      setNsfwMode(data?.nsfw_enabled || false);
      const tier = (data?.plan_tier as 'free' | 'basic' | 'premium' | undefined) ?? (premium ? 'basic' : 'free');
      setPlanTier(tier);
      
      // Use new voice credits system
      const voiceCredits = Number(data?.voice_credits ?? 0);
      const welcomeCreds = Number(data?.welcome_credits ?? 0);
      setVoiceRemaining(voiceCredits);
      setWelcomeCredits(welcomeCreds);
      setTextMessagesToday(Number(data?.text_messages_today ?? 0));
      
      // Check if user has any credits (welcome or voice)
      if (welcomeCreds <= 0 && voiceCredits <= 0) {
        setVoiceEnabled(false);
      }
    };
    loadPremiumAndNsfw();
  }, []);

  useEffect(() => {
    const loadRecentConversations = async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) return;
      setConversationsLoading(true);
      const { data, error } = await supabase
        .from('conversations')
        .select(`id, title, updated_at, character:characters(id, name, avatar_url)`)
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })
        .limit(20);
      if (error) {
        console.error('Error loading recent conversations:', error);
      } else {
        setRecentConversations(data || []);
      }
      setConversationsLoading(false);
    };
    loadRecentConversations();
  }, []);

  const loadMemories = useCallback(async () => {
    if (!characterId) return;
    setMemoriesLoading(true);
    try {
      const q = new URLSearchParams({ characterId, conversationId: currentConversationId || '' });
      const res = await apiClient.get(`/memories?${q.toString()}`);
      if (res.ok) {
        const ct = res.headers.get('content-type') || '';
        if (!ct.includes('application/json')) {
          console.error('Memories response is not JSON:', { url: res.url, status: res.status, contentType: ct });
          setMemories([]);
        } else {
          const text = await res.text();
          // Handle empty body safely
          const data = text ? JSON.parse(text) : [];
          setMemories(Array.isArray(data) ? data : []);
        }
      } else {
        console.error('Failed to fetch memories with status:', res.status);
      }
    } catch (e) {
      console.error('Failed to load memories:', e);
    } finally {
      setMemoriesLoading(false);
    }
  }, [characterId]);

  const pinMessageAsMemory = useCallback(async (messageIndex: number, role: 'user' | 'assistant', content: string) => {
    if (!characterId || !content.trim()) return;
    
    setPinningMessageIndex(messageIndex);
    try {
      const res = await apiClient.post('/memories', {
        characterId,
        memoryText: content,
        role
      });
      
      if (res.ok) {
        // Reload memories to show the new one
        await loadMemories();
        // Show success feedback (optional - could add a toast notification)
        console.log('Message pinned as memory successfully');
      } else {
        const errorData = await res.json();
        console.error('Failed to pin message:', errorData?.error || 'Unknown error');
      }
    } catch (e) {
      console.error('Failed to pin message as memory:', e);
    } finally {
      setPinningMessageIndex(null);
    }
  }, [characterId, loadMemories]);

  useEffect(() => {
    loadMemories();
  }, [loadMemories]);

  // Also refresh memories when switching conversations (even if character stays the same)
  useEffect(() => {
    loadMemories();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentConversationId]);

  // Realtime: auto-refresh memories when new ones are added/updated/deleted
  useEffect(() => {
    let channel: any;
    (async () => {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user || !characterId) return;
      channel = supabase
        .channel(`memories-${characterId}`)
        .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'user_memories', filter: `character_id=eq.${characterId}` }, () => loadMemories())
        .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'user_memories', filter: `character_id=eq.${characterId}` }, () => loadMemories())
        .on('postgres_changes', { event: 'DELETE', schema: 'public', table: 'user_memories', filter: `character_id=eq.${characterId}` }, () => loadMemories())
        .subscribe();
    })();
    return () => {
      if (channel) supabase.removeChannel(channel);
    };
  }, [characterId, loadMemories]);


  const createNewConversation = async () => {
    if (!characterId || !character) return;
    
    const { data: userData } = await supabase.auth.getUser();
    if (!userData.user) return;

    const { data, error } = await supabase
      .from('conversations')
      .insert({
        user_id: userData.user.id,
        character_id: characterId,
        title: `Chat with ${character.name}`,
      })
      .select('id, title, updated_at')
      .single();

    if (!error && data) {
      // Immediately prepend to recent conversations so it shows up without refresh
      setRecentConversations(prev => [
        {
          id: data.id,
          title: data.title,
          updated_at: data.updated_at,
          character: {
            id: character.id,
            name: character.name,
            avatar_url: character.avatar_url,
          },
        },
        ...prev,
      ]);
      setCurrentConversationId(data.id);
      setMessages([]);
      navigate(`/chat/${characterId}/${data.id}`, { replace: true });
    }
  };

  const onSubmit = async (e?: FormEvent, regeneratedInput?: string) => {
    if (e) { e.preventDefault(); e.stopPropagation(); }
    // Snapshot and restore window scroll to avoid footer jumping
    const prevScrollY = window.scrollY;
    // Keep input focused immediately on submit
    setTimeout(() => {
      try {
        (inputRef.current as any)?.focus?.({ preventScroll: true });
      } catch {
        inputRef.current?.focus();
      }
    }, 0);
    setTimeout(() => window.scrollTo({ top: prevScrollY, left: window.scrollX, behavior: 'auto' }), 0);
    const raw = regeneratedInput ?? input;
    const isAutoContinue = !regeneratedInput && (raw?.trim()?.length ?? 0) === 0;
    const messageToSend = isAutoContinue ? 'Continue' : raw;
    if (!characterId || !character) return;
    
    // Create new conversation if none exists
    let conversationToUse = currentConversationId;
    if (!conversationToUse) {
      // Mark first turn for scroll behavior
      firstTurnRef.current = true;
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return;

    const { data, error } = await supabase
        .from('conversations')
        .insert({
          user_id: userData.user.id,
          character_id: characterId,
          title: `Chat with ${character?.name || 'Character'}`,
        })
      .select('id, title, updated_at')
        .single();

      if (error || !data) return;
      conversationToUse = data.id;
      setCurrentConversationId(conversationToUse);
      navigate(`/chat/${characterId}/${conversationToUse}`, { replace: true });
      
      // Immediately prepend to recent conversations so it shows up without refresh
      if (character) {
        setRecentConversations(prev => [
          {
            id: data.id,
            title: data.title,
            updated_at: data.updated_at,
            character: {
              id: character.id,
              name: character.name,
              avatar_url: character.avatar_url,
            },
          },
          ...prev,
        ]);
      }
    }
    
    const userMsg: Message = { role: 'user', content: messageToSend };
    let assistantIndex = -1;
    const addedCountRef = { current: 0 };
    if (isAutoContinue && voiceEnabled) {
      // Cut off any ongoing TTS immediately before continuing
      stopTtsNow();
    }
    setMessages((m) => {
      const additions: Message[] = [];
      // If regenerating, do NOT add the user bubble again; keep the existing one
      if (!isAutoContinue && !regeneratedInput) additions.push(userMsg);
      additions.push({ role: 'assistant', content: '' });
      addedCountRef.current = additions.length;
      assistantIndex = m.length + additions.length - 1;
      return [...m, ...additions];
    });
    assistantMessageRef.current = '';
    wordBufferRef.current = '';
    uiTextBufferRef.current = '';
    // legacy HTTP audio queue cleared (no-op)
    currentAssistantIndexRef.current = assistantIndex;
    if (!regeneratedInput) {
      setInput('');
      if (isDesktop) setTimeout(() => inputRef.current?.focus(), 0);
    }
    setStreaming(true);
    
    // TTS initialization (HTTP)
    if (!voiceEnabled) {
      // Clear audio queue and reset playing state for HTTP fallback
      // legacy HTTP audio queue cleared (no-op)
      setPlayingIndex(null);
      // no audio element used in realtime mode
    } else {
      setPlayingIndex(assistantIndex);
      // Hard reset any previous TTS activity/queue to avoid mixing with new turn
      stopTtsNow();
      ttsQueueRef.current = [];
      ttsSentenceBufRef.current = '';
      ttsGotFinalRef.current = false;
    }
    try {
      // New API call to the Node.js backend
      // Ensure the input stays in view right after we add the placeholder assistant message
      // so the user's first message doesn't jump off-screen on new conversations
      // Do not auto-scroll; avoid bringing footer into view
      const baseHistory = messagesRef.current;
      // If regenerating, drop the last assistant message in the history we send
      const historyForApi = regeneratedInput ? baseHistory.slice(0, Math.max(0, baseHistory.length - 1)) : baseHistory;
      const res = await apiClient.stream('/chat', {
        character: { ...character, model: modelKey },
        messages: isAutoContinue ? [...historyForApi, { role: 'user', content: 'Continue' }] : [...historyForApi, userMsg],
        nsfwMode,
        conversationId: conversationToUse,
        autoContinue: isAutoContinue,
      });

      if (res.status === 429) {
        const data = await res.json().catch(() => ({} as any));
        
        // Check if it's a daily limit error
        if (data?.error === 'DAILY_LIMIT_EXCEEDED') {
          setDailyLimitMsg(data?.message || `You've reached your daily limit of ${data?.limit || 20} messages. Upgrade to continue chatting unlimited!`);
          // Remove the just-added placeholder(s)
          const toRemove = (function() { return (typeof (addedCountRef as any).current === 'number' && (addedCountRef as any).current > 0) ? (addedCountRef as any).current : (isAutoContinue ? 1 : 2); })();
          setMessages((prev) => prev.slice(0, Math.max(0, prev.length - toRemove)));
          // Update text messages count
          if (data?.used !== undefined) {
            setTextMessagesToday(data.used);
          }
          setTimeout(() => setDailyLimitMsg(null), 10000);
          return;
        }
        
        // Regular cooldown message
        setCooldownMsg(data?.message || "You're sending messages a bit too quickly. Please try again in a moment.");
        // Remove the just-added placeholder(s)
        const toRemove = (function() { return (typeof (addedCountRef as any).current === 'number' && (addedCountRef as any).current > 0) ? (addedCountRef as any).current : (isAutoContinue ? 1 : 2); })();
        setMessages((prev) => prev.slice(0, Math.max(0, prev.length - toRemove)));
        setTimeout(() => setCooldownMsg(null), 5000);
        return;
      }
      if (!res.body) throw new Error('No stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          if (voiceEnabled) {
            const remaining = ttsSentenceBufRef.current.trim();
            if (remaining) {
              // Force enqueue to guarantee the last sentence is spoken
              // If very short, append a period to ensure audible end
              const finalText = remaining.length < 10 ? `${remaining}.` : remaining;
              enqueueTts((voiceKey || 'luna').toLowerCase(), finalText);
              ttsSentenceBufRef.current = '';
            }
          }
          break;
        }
        
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (line.startsWith('data: ')) {
            const jsonStr = line.substring(6);
            if (jsonStr === '[DONE]') {
              break;
            }
            try {
              const data = JSON.parse(jsonStr);
              if (data.type === 'chunk' && data.content) {
                const chunk = data.content;
                
                // Accumulate chunk into buffer
                uiTextBufferRef.current += chunk;
                
                // Extract complete sentences from buffer
                const completeText = extractCompleteSentencesFromBuffer();
                
                if (completeText.length > 0) {
                  assistantMessageRef.current += completeText;
                  wordBufferRef.current += completeText;
                  
                  if (voiceEnabled) {
                    // Speak complete sentences as they arrive for faster response
                    ttsAppendSentence(completeText);
                  }
                  
                  // Update UI with only complete sentences
                  setMessages(prev => {
                    const next = [...prev];
                    let idx = (currentAssistantIndexRef.current != null ? currentAssistantIndexRef.current : -1) as number;
                    if (!(idx >= 0 && idx < next.length && (next[idx] as any)?.role === 'assistant')) {
                      if (next.length > 0 && (next[next.length - 1] as any)?.role === 'assistant') {
                        idx = next.length - 1;
                        currentAssistantIndexRef.current = idx;
                      } else {
                        next.push({ role: 'assistant', content: '' } as any);
                        idx = next.length - 1;
                        currentAssistantIndexRef.current = idx;
                      }
                    }
                    const target = next[idx] as any;
                    // Only add complete sentences to the displayed content
                    const newContent = target.content + completeText;
                    next[idx] = { ...target, content: newContent } as any;
                    return next;
                  });
                }

                // Scroll the messages container during streaming if user is near bottom
                setTimeout(() => {
                  if (!stickToBottomRef.current) return;
                  const el = messagesListRef.current;
                  if (!el) return;
                  el.scrollTop = el.scrollHeight;
                }, 0);
              } else if (data.type === 'final' && data.fullResponse) {
                const finalText: string = data.fullResponse;
                ttsGotFinalRef.current = true;
                
                // Update credits after successful message
                if (welcomeCredits > 0) {
                  setWelcomeCredits(prev => Math.max(0, prev - 1));
                } else {
                  setTextMessagesToday(prev => prev + 1);
                }
                
                // Speak any remaining buffer text to ensure we don't miss the end
                if (voiceEnabled) {
                  const remainingInBuffer = uiTextBufferRef.current.trim();
                  if (remainingInBuffer.length > 0) {
                    console.log(`🎵 Final TTS: speaking remaining buffer "${remainingInBuffer.substring(0, 50)}..." (${remainingInBuffer.length} chars)`);
                    ttsAppendSentence(remainingInBuffer);
                  }
                }
                
                // Display final complete text in UI
                if (!assistantMessageRef.current) {
                  assistantMessageRef.current = finalText;
                  setMessages(prev => {
                    const next = [...prev];
                    let idx = (currentAssistantIndexRef.current != null ? currentAssistantIndexRef.current : -1) as number;
                    if (!(idx >= 0 && idx < next.length && (next[idx] as any)?.role === 'assistant')) {
                      if (next.length > 0 && (next[next.length - 1] as any)?.role === 'assistant') {
                        idx = next.length - 1;
                        currentAssistantIndexRef.current = idx;
                      } else {
                        next.push({ role: 'assistant', content: '' } as any);
                        idx = next.length - 1;
                        currentAssistantIndexRef.current = idx;
                      }
                    }
                    const target = next[idx] as any;
                    next[idx] = { ...target, content: finalText } as any;
                    return next;
                  });
                  // Ensure final chunk leaves us scrolled to bottom if appropriate
                  setTimeout(() => {
                    if (!stickToBottomRef.current) return;
                    const el = messagesListRef.current;
                    if (!el) return;
                    el.scrollTop = el.scrollHeight;
                  }, 0);
                }
                
                // Clear buffers after final
                uiTextBufferRef.current = '';
                ttsSentenceBufRef.current = '';
              }
            } catch (e) {
              console.error('Failed to parse stream chunk:', jsonStr);
            }
          }
        }
      }
    } catch (err) {
      // handle error UI as needed
    } finally {
      setStreaming(false);
      loadMemories(); // Refresh memories after conversation turn
      // Always refocus quickly so user can type next message immediately without scrolling the page
      setTimeout(() => {
        try {
          (inputRef.current as any)?.focus?.({ preventScroll: true });
        } catch {
          inputRef.current?.focus();
        }
      }, 0);
    // Refresh history so latest messages receive their persisted IDs
    try {
      if (currentConversationId) {
        const res = await apiClient.get(`/chat/history/${currentConversationId}`);
        if (res.ok) {
          const data = await res.json();
          const mapped = (data || []).map((m: any) => ({ id: m.id as string, role: m.role as 'user' | 'assistant', content: m.content as string }));
          setMessages(mapped);
        }
      }
    } catch {}
      // Restore scroll
      setTimeout(() => window.scrollTo({ top: prevScrollY, left: window.scrollX, behavior: 'auto' }), 0);
      // Reset first-turn flag once streaming completes
      firstTurnRef.current = false;
    }
  };

  return (
    <div className="w-full animated-gradient-subtle text-white">
      <div className="relative grid grid-cols-1 md:grid-cols-[240px_1fr_240px] gap-2 h-[calc(100vh-100px)]">
        {/* Left Sidebar with selectors */}
        <aside className={`fixed md:relative top-0 left-0 h-full w-64 md:w-auto bg-gray-900 md:bg-transparent z-20 transform ${isLeftSidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 transition-transform duration-300 ease-in-out flex flex-col rounded-r-2xl md:rounded-2xl border border-white/10 p-2 backdrop-blur overflow-y-auto md:overflow-hidden`}>
          <button onClick={() => setIsLeftSidebarOpen(false)} className="md:hidden self-start mb-2 p-2 rounded-full bg-red-500/50 text-white">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
          {/* Character card */}
          <div className="mb-4 flex items-start gap-3">
            {character?.avatar_url ? (
              <img src={character.avatar_url} alt={character.name} className="w-16 aspect-[3/4] rounded-lg object-contain ring-2 ring-pink-500/40 bg-white/5" />
            ) : (
              <div className="w-16 aspect-[3/4] rounded-lg bg-gradient-to-br from-pink-400 to-purple-600 ring-2 ring-pink-500/40" />
            )}
            <div className="flex-1">
              <div className="font-medium text-white">{character?.name ?? 'Character'}</div>
              {character?.description && <div className="text-xs text-gray-300 line-clamp-2">{character.description}</div>}
            </div>
          </div>

          {/* New Chat Button */}
          <button
            onClick={createNewConversation}
            className="mb-4 w-full rounded-lg border border-pink-500/30 bg-gradient-to-r from-pink-500/10 to-purple-600/10 px-3 py-2 text-sm text-white hover:from-pink-500/20 hover:to-purple-600/20 transition-all duration-200"
          >
            + New Chat
          </button>

          <div className="mb-2 flex items-center gap-2 text-xs text-white/80">
				{/* Brain icon */}
				<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5 text-pink-400"><path d="M7.5 2.25A3.75 3.75 0 0 0 3.75 6v5.25a3 3 0 0 0 3 3v3a3.75 3.75 0 1 0 7.5 0V6a3.75 3.75 0 0 0-7.5-3.75Zm9 3a3.75 3.75 0 0 1 3.75 3.75v5.25a3 3 0 0 1-3 3v.75a3 3 0 1 1-6 0v-12a3.75 3.75 0 0 1 5.25-3.5Z"/></svg>
				<span>Model</span>
			</div>
          <div className="grid grid-cols-1 gap-1 overflow-visible">
            {MODEL_OPTIONS.map((m) => {
              const locked = !!m.premium && !isPremium;
              return (
                <button
                  key={m.key}
                  title={`${m.desc}${locked ? ' — Premium feature' : ''}`}
                  onClick={() => (locked ? navigate('/subscribe') : setModelKey(m.key))}
                  className={`flex w-full items-center justify-between rounded-lg border px-2.5 py-1.5 text-left text-xs transition ${
                    modelKey === m.key && !locked
                      ? 'border-pink-500/50 bg-pink-500/10 text-white'
                      : locked
                      ? 'border-yellow-500/40 bg-yellow-500/5 text-white/90 hover:bg-yellow-500/10'
                      : 'border-white/20 bg-white/5 text-white/90 hover:bg-white/10'
                  }`}
                >
                  <span>{m.key}</span>
                  {m.premium && (
                    <span className="ml-2 whitespace-nowrap rounded-full bg-gradient-to-r from-pink-500 to-purple-600 px-1 py-0.5 text-[9px] leading-none text-white">
                      Premium +
                    </span>
                  )}
                </button>
              );
            })}
			</div>
          <p className="mb-2 text-[11px] text-white/70">{MODEL_OPTIONS.find((m) => m.key === modelKey)?.desc}</p>
          <div className="mb-1 flex items-center gap-2 text-xs text-white">
            {/* Speaker icon */}
            <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-5 w-5 text-purple-400"><path d="M14.25 3.5a.75.75 0 0 1 .75.75v15.5a.75.75 0 0 1-1.218.586L8.4 16H5.25A2.25 2.25 0 0 1 3 13.75v-3.5A2.25 2.25 0 0 1 5.25 8H8.4l5.382-4.336A.75.75 0 0 1 14.25 3.5Zm4.17 2.33a.75.75 0 1 1 1.06 1.06 7 7 0 0 1 0 9.9.75.75 0 0 1-1.06-1.06 5.5 5.5 0 0 0 0-7.78.75.75 0 0 1 0-1.06Z"/></svg>
				<span>Voice</span>
          </div>
          <div className="relative">
            <select
              className="w-full appearance-none rounded-lg border border-white/20 bg-black/40 px-2.5 py-1.5 pr-8 text-xs text-white focus:border-pink-500"
              value={voiceKey}
              onChange={(e) => setVoiceKey(e.target.value)}
            >
              {/* Character Voices - Realistic */}
              <optgroup label="Character Voices (Realistic)">
                <option className="bg-gray-900 text-white" value="layla">Layla</option>
                <option className="bg-gray-900 text-white" value="ava">Ava</option>
                <option className="bg-gray-900 text-white" value="mia">Mia</option>
                <option className="bg-gray-900 text-white" value="emma">Emma</option>
                <option className="bg-gray-900 text-white" value="aria">Aria</option>
                <option className="bg-gray-900 text-white" value="natalia">Natalia</option>
              </optgroup>
              
              {/* Character Voices - Anime */}
              <optgroup label="Character Voices (Anime)">
                <option className="bg-gray-900 text-white" value="star">Star</option>
                <option className="bg-gray-900 text-white" value="natsuki">Natsuki</option>
                <option className="bg-gray-900 text-white" value="mary">Mary</option>
                <option className="bg-gray-900 text-white" value="lana">Lana</option>
                <option className="bg-gray-900 text-white" value="clover">Clover</option>
                <option className="bg-gray-900 text-white" value="chloe">Chloe</option>
              </optgroup>
              
              {/* General Selection Voices */}
              <optgroup label="General Voices">
                <option className="bg-gray-900 text-white" value="seraphina">Seraphina</option>
                <option className="bg-gray-900 text-white" value="celeste">Celeste</option>
                <option className="bg-gray-900 text-white" value="aurora">Aurora</option>
                <option className="bg-gray-900 text-white" value="luna">Luna</option>
              </optgroup>
            </select>
            <svg
              xmlns="http://www.w3.org/2000/svg"
              viewBox="0 0 24 24"
              fill="currentColor"
              className="pointer-events-none absolute right-2 top-1/2 h-4 w-4 -translate-y-1/2 text-white/80"
            >
              <path d="M7 10l5 5 5-5H7z" />
            </svg>
          </div>
          <div className="mt-2 flex items-center justify-between">
            <span className="text-xs text-white/80">Voice streaming</span>
            <button
              onClick={() => setVoiceEnabled((v) => (voiceRemaining <= 0 ? v : !v))}
              className={`relative h-6 w-11 rounded-full transition ${voiceEnabled && voiceRemaining > 0 ? 'bg-gradient-to-r from-pink-500 to-purple-600' : 'bg-white/15 opacity-60'}`}
              aria-pressed={voiceEnabled}
              disabled={voiceRemaining <= 0}
            >
              <span className={`absolute top-1/2 -translate-y-1/2 transform rounded-full bg-white transition ${voiceEnabled && voiceRemaining > 0 ? 'left-6 h-4 w-4' : 'left-1 h-4 w-4'}`} />
            </button>
          </div>
          <div className="mt-1 text-right text-[11px] text-white/70">
            {voiceRemaining > 0 ? (
              <span>Remaining: {voiceRemaining}</span>
            ) : (
              <span>
                Voice limit reached{!isPremium ? ' — upgrade for more' : planTier === 'basic' ? ' — upgrade to premium for more' : ''}
              </span>
            )}
          </div>
          <div className="mt-4 flex items-center justify-between">
            <span className="text-xs text-white">Fantasy mode</span>
            <button
              onClick={() => setFantasyMode((v) => !v)}
              className={`relative h-6 w-11 rounded-full transition ${fantasyMode && isPremium ? 'bg-gradient-to-r from-pink-500 to-purple-600' : 'bg-white/15'}`}
              aria-pressed={fantasyMode}
              disabled={!isPremium}
              title={isPremium ? 'Extra flirty and seductive responses' : 'Premium feature'}
            >
              <span className={`absolute top-1/2 -translate-y-1/2 transform rounded-full bg-white transition ${fantasyMode && isPremium ? 'left-6 h-4 w-4' : 'left-1 h-4 w-4'}`} />
            </button>
          </div>
        </aside>

        {/* Chat panel */}
        <main className="flex flex-col h-full rounded-2xl border border-white/10 bg-white/5 p-2 shadow-xl backdrop-blur">
          <div className="md:hidden pt-12" /> {/* Spacer for mobile header */}
          <h2 className="mb-1 text-lg font-semibold text-center md:text-left">Chat</h2>
          
          {/* AI Disclaimer */}
          <div className="mb-2 px-2 py-1 rounded bg-white/5 border border-white/10">
            <p className="text-xs text-gray-400 text-center italic">
              Conversations are simulated with AI characters and are for entertainment purposes only.
            </p>
          </div>
          
          <div className="flex h-[700px] md:h-[700px] flex-col overflow-hidden">
            <div ref={messagesListRef} className="flex-1 space-y-2 overflow-y-auto pr-1 pb-36 md:pb-0 will-change-scroll overscroll-contain" style={{ overflowAnchor: 'none' }} onWheel={(e) => e.stopPropagation()} onTouchMove={(e) => e.stopPropagation()}>
            {messages.map((m, i) => (
            <div key={m.id || i} className={`group my-3 ${m.role === 'user' ? 'md:text-right text-left' : 'md:text-left text-left'}`}>
              <div 
                className={`relative inline-block max-w-[80%] md:ml-0 ${m.role === 'user' ? 'ml-auto' : 'ml-0'} rounded-2xl ${m.role === 'user' ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white' : 'bg-white/10 text-white/90'} ${m.role === 'user' ? 'px-3 py-2' : 'px-4 py-3'} text-sm`}
                onTouchStart={() => {
                  if (longPressTimerRef.current) window.clearTimeout(longPressTimerRef.current);
                  longPressTimerRef.current = window.setTimeout(() => {
                    setLongPressMessage({ index: i, isUser: m.role === 'user' });
                  }, 600);
                }}
                onTouchEnd={() => { if (longPressTimerRef.current) { window.clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; } }}
                onTouchMove={() => { if (longPressTimerRef.current) { window.clearTimeout(longPressTimerRef.current); longPressTimerRef.current = null; } }}
              >
                {/* Bouncing loader for assistant's empty message */}
                {m.role === 'assistant' && m.content === '' && streaming && (
                  <div className="p-2">
                    <BouncingLoader />
                  </div>
                )}
                {/* User controls above bubble */}
                {m.role === 'user' && (
                  <div className={`absolute -top-3 right-0 z-10 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-2`}>
                    <button
                      type="button"
                      title="Delete message"
                      className="p-1.5 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-sm"
                      onClick={async () => {
                      const tryDelete = async (id: string | undefined) => {
                        if (!id) return false;
                        try {
                          const res = await apiClient.delete(`/chat/message/${id}`);
                          return res.ok || res.status === 204;
                        } catch (e) {
                          console.error('Failed to delete message', e);
                          return false;
                        }
                      };
                      if (await tryDelete(m.id)) {
                        setMessages(prev => prev.filter((_, idx) => idx !== i));
                        return;
                      }
                      try {
                        if (currentConversationId) {
                          const res = await apiClient.get(`/chat/history/${currentConversationId}`);
                          if (res.ok) {
                            const data = await res.json();
                            const mapped = (data || []).map((mm: any) => ({ id: mm.id as string, role: mm.role as 'user' | 'assistant', content: mm.content as string }));
                            setMessages(mapped);
                            const match = mapped.find((mm: any) => mm.role === m.role && mm.content === m.content);
                            if (match && await tryDelete(match.id)) {
                              setMessages(prev => prev.filter(pm => pm.id !== match.id));
                              return;
                            }
                          }
                        }
                      } catch {}
                      setMessages(prev => prev.filter((_, idx) => idx !== i));
                    }}
                    >
                      <DeleteIcon className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      title="Edit message"
                      className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 backdrop-blur-sm text-xs font-medium"
                      onClick={() => {
                        setEditTarget({ index: i, id: m.id, text: m.content });
                        setEditText(m.content);
                      }}
                    >
                      Edit
                    </button>
                  </div>
                )}

                {/* Assistant controls above bubble */}
                {m.role === 'assistant' && (
                  <div className={`absolute -top-3 right-0 z-10 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-2`}>
                    <button
                      type="button"
                      title="Delete message"
                      className="p-1.5 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-sm"
                      onClick={async () => {
                        const tryDelete = async (id: string | undefined) => {
                          if (!id) return false;
                          try {
                            const res = await apiClient.delete(`/chat/message/${id}`);
                            return res.ok || res.status === 204;
                          } catch (e) {
                            console.error('Failed to delete message', e);
                            return false;
                          }
                        };
                        if (await tryDelete(m.id)) {
                          setMessages(prev => prev.filter((_, idx) => idx !== i));
                          return;
                        }
                        try {
                          if (currentConversationId) {
                            const res = await apiClient.get(`/chat/history/${currentConversationId}`);
                            if (res.ok) {
                              const data = await res.json();
                              const mapped = (data || []).map((mm: any) => ({ id: mm.id as string, role: mm.role as 'user' | 'assistant', content: mm.content as string }));
                              setMessages(mapped);
                              const match = mapped.find((mm: any) => mm.role === m.role && mm.content === m.content);
                              if (match && await tryDelete(match.id)) {
                                setMessages(prev => prev.filter(pm => pm.id !== match.id));
                                return;
                              }
                            }
                          }
                        } catch {}
                        setMessages(prev => prev.filter((_, idx) => idx !== i));
                      }}
                    >
                      <DeleteIcon className="w-4 h-4" />
                    </button>
                    <button
                      type="button"
                      title="Edit message"
                      className="px-3 py-1.5 rounded-lg bg-white/10 hover:bg-white/20 backdrop-blur-sm text-xs font-medium"
                      onClick={() => {
                        setEditTarget({ index: i, id: m.id, text: m.content });
                        setEditText(m.content);
                      }}
                    >
                      Edit
                    </button>
                  </div>
                )}
                
                {/* Top-left controls row (icon + waveform) */}
                {m.role === 'assistant' && m.content !== '' && voiceEnabled && (
                  <div className="pointer-events-auto absolute -top-5 left-2 flex items-center gap-2">
                    {(playingIndex !== i) && (
                      <button
                        type="button"
                        aria-label="Play voice"
                        className="flex h-7 w-7 items-center justify-center rounded-full bg-white/25 text-white hover:bg-white/35 shadow"
                        onClick={() => {
                          const full = (m.content || '').trim();
                          if (full) enqueueTts((voiceKey || 'luna').toLowerCase(), full);
                        }}
                      >
                        <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5"><path d="M8 5v14l11-7z"/></svg>
                      </button>
                    )}
                    {playingIndex === i && (
                      <div className="flex items-end gap-0.5 h-4">
                        <span className="wavebar"/>
                        <span className="wavebar"/>
                        <span className="wavebar"/>
                        <span className="wavebar"/>
                        <span className="wavebar"/>
                      </div>
                    )}
                  </div>
                )}
                
                {/* Regenerate button for the last assistant message */}
                {m.role === 'assistant' && i === messages.length - 1 && !streaming && (
                  <button 
                    onClick={() => {
                      const snap = messagesRef.current;
                      const lastUserMessage = snap[snap.length - 2];
                      if (lastUserMessage && lastUserMessage.role === 'user') {
                        // Remove only the last assistant bubble locally; keep the user message
                        setMessages(prev => prev.slice(0, -1));
                        // Re-submit the last user message; API history will exclude old assistant
                        onSubmit(undefined, lastUserMessage.content);
                      }
                    }}
                    className="absolute -bottom-3 -right-3 p-1.5 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-sm shadow-lg"
                    title="Regenerate response"
                  >
                    <RefreshIcon className="h-4 w-4" />
                  </button>
                )}

                {/* Pin button - right for user, left for AI */}
                {m.content && m.content.trim() && (
                  <button
                    onClick={() => pinMessageAsMemory(i, m.role, m.content)}
                    disabled={pinningMessageIndex === i}
                    className={`absolute -bottom-3 ${m.role === 'user' ? 'right-0' : 'left-0'} p-1.5 rounded-full bg-white/10 hover:bg-white/20 backdrop-blur-sm opacity-0 group-hover:opacity-100 transition-opacity disabled:opacity-50 shadow-md`}
                    title="Pin as memory"
                  >
                    <PinIcon className="h-4 w-4" />
                  </button>
                )}

                <div 
                  className="whitespace-pre-wrap"
                  dangerouslySetInnerHTML={{ __html: parseActions(m.content) }} 
                />
              </div>
            </div>
          ))}
            </div>
            {dailyLimitMsg && (
              <div className="mt-3 rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-xs text-red-200">
                <div className="flex items-center justify-between">
                  <span>{dailyLimitMsg}</span>
                  <a href="/subscribe" className="ml-2 text-red-300 underline hover:text-red-200">Upgrade</a>
                </div>
              </div>
            )}
            {cooldownMsg && (
              <div className="mt-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
                {cooldownMsg}
              </div>
            )}
            {welcomeCredits <= 0 && textMessagesToday > 0 && (
              <div className="mt-2 text-xs text-white/60 px-3">
                {textMessagesToday}/20 messages today (Free tier)
              </div>
            )}
            <div className="hidden md:block">
              <form onSubmit={(e) => { e.preventDefault(); e.stopPropagation(); onSubmit(); }} className="relative mt-1 flex items-center gap-2">
                <textarea
                  className="flex-1 rounded-full border border-white/20 bg-white/5 px-4 py-3 pr-24 text-white outline-none placeholder:text-gray-400 focus:border-pink-500 resize-none overflow-hidden"
                  placeholder="Type a message"
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    autoResizeTextarea(e.target);
                  }}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      onSubmit();
                      // Scroll only the messages list to the last bubble
                      setTimeout(() => {
                        const ml = messagesListRef.current;
                        if (ml) ml.scrollTop = ml.scrollHeight;
                      }, 0);
                    }
                  }}
                  ref={isDesktop ? inputRef : null}
                  autoFocus={isDesktop}
                  disabled={streaming || Boolean(cooldownMsg) || Boolean(dailyLimitMsg)}
                  rows={1}
                />
                {/* Voice Call Button */}
                <div className="absolute right-14 top-1/2 -translate-y-1/2">
                  {character && (
                    <VoiceCallButton
                      characterId={character.id}
                      character={{
                        id: character.id,
                        name: character.name,
                        avatar_url: character.avatar_url || undefined,
                        voice: (character as any).voice_id && ALLOWED_VOICES.includes(((character as any).voice_id || '').toLowerCase()) ? ((character as any).voice_id as string).toLowerCase() : (ALLOWED_VOICES.includes(character.name.toLowerCase()) ? character.name.toLowerCase() : 'luna'),
                        prompt: character.system_prompt || ''
                      }}
                      conversationId={currentConversationId || undefined}
                      onTranscriptUpdate={(partialTranscript) => {
                        // Update input field as user speaks
                        console.log('Updating input field with transcript:', partialTranscript);
                        setInput(partialTranscript);
                      }}
                      onTranscript={(transcript) => {
                        console.log('User spoke (final):', transcript);
                        // Add user message to chat
                        setMessages(prev => [...prev, { role: 'user' as const, content: transcript }]);
                        // Add assistant message with loading indicator (empty triggers BouncingLoader)
                        setMessages(prev => {
                          const newMessages = [...prev, { role: 'assistant' as const, content: '' }];
                          currentAssistantIndexRef.current = newMessages.length - 1;
                          return newMessages;
                        });
                        assistantMessageRef.current = '';
                        setStreaming(true); // Enable streaming state for BouncingLoader
                      }}
                      onAIResponseChunk={(chunk) => {
                        // Stream with natural delay to match TTS pace
                        streamTextWithDelay(chunk);
                      }}
                      onAIResponse={(response) => {
                        console.log('AI responded (final):', response);
                        
                        // If empty response (e.g. call ended before AI replied), just reset streaming state
                        if (!response || response.trim() === '') {
                          console.log('Empty AI response (call ended) - just resetting streaming state');
                          setStreaming(false);
                          return;
                        }
                        
                        // Finalize the assistant message
                        assistantMessageRef.current = response;
                        setMessages(prev => {
                          const next = [...prev];
                          const idx = currentAssistantIndexRef.current;
                          if (idx != null && idx >= 0 && idx < next.length && next[idx]?.role === 'assistant') {
                            next[idx] = { ...next[idx], content: response };
                          }
                          return next;
                        });
                        setStreaming(false); // Disable streaming state
                      }}
                      onError={(error) => {
                        console.error('Voice call error:', error);
                        window.alert(`Voice call error: ${error}`);
                      }}
                      disabled={streaming || Boolean(cooldownMsg) || Boolean(dailyLimitMsg)}
                    />
                  )}
                </div>
                {/* Send Button */}
                <button type="submit" className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-gradient-to-r from-pink-500 to-purple-600 text-white shadow-lg transition hover:brightness-110 disabled:opacity-50 flex items-center justify-center" disabled={streaming || Boolean(cooldownMsg)}>
                  {streaming ? (
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <SendIcon className="h-5 w-5" />
                  )}
                </button>
              </form>
            </div>
          </div>
        </main>

        {/* Right Sidebar for History and Memories */}
        <aside className={`fixed md:relative top-0 right-0 h-full w-64 md:w-auto bg-gray-900 md:bg-transparent z-20 transform ${isRightSidebarOpen ? 'translate-x-0' : 'translate-x-full'} md:translate-x-0 transition-transform duration-300 ease-in-out flex flex-col rounded-l-2xl md:rounded-2xl border border-white/10 p-2 backdrop-blur overflow-y-auto`}>
          <button onClick={() => setIsRightSidebarOpen(false)} className="md:hidden self-end mb-2 p-2 rounded-full bg-red-500/50 text-white">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
          <div className="space-y-2 no-scrollbar">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-md font-semibold text-white">Memories</h3>
              <button onClick={loadMemories} className="p-1 mr-2 rounded-full hover:bg-white/10" title="Refresh memories">
                <RefreshIcon className="h-4 w-4" />
              </button>
            </div>
            {/* Fixed-height, scrollable memories list */}
            <div className="h-64 md:h-72 overflow-y-auto pr-1 no-scrollbar rounded-lg">
              {memoriesLoading ? (
                <p className="text-sm text-white/70 text-center">Loading memories...</p>
              ) : memories.length === 0 ? (
                <p className="text-sm text-white/70 text-center">No memories yet.</p>
              ) : (
                memories.map((mem: any) => (
                  <div key={mem.id} className="group relative p-2 mb-2 rounded-lg bg-white/5">
                    <p className="text-xs text-white/80">{mem.memory_text}</p>
                    <button
                      onClick={() => setConfirmMemoryId(mem.id)}
                      className="absolute top-1 right-1 p-0.5 opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity bg-red-500/50 hover:bg-red-500/80 text-white w-5 h-5 rounded-full flex items-center justify-center text-xs"
                    >
                      <DeleteIcon className="h-3 w-3" />
                    </button>
                  </div>
                ))
              )}
            </div>
          </div>
          <div className="space-y-2 mt-4 border-t border-white/10 pt-2">
            <h3 className="mb-2 text-md font-semibold text-white">Recent Chats</h3>
            {conversationsLoading ? (
              <p className="text-sm text-white/70 text-center">Loading...</p>
            ) : recentConversations.length === 0 ? (
              <p className="text-sm text-white/70 text-center">No recent chats.</p>
            ) : (
              recentConversations.map((conv: any) => (
                <Link
                  key={conv.id}
                  to={`/chat/${conv.character.id}/${conv.id}`}
                  className="block p-2 rounded-lg bg-white/5 hover:bg-white/10 transition-colors group relative"
                >
                  <div className="flex items-center gap-2">
                    <img src={conv.character.avatar_url} alt={conv.character.name} className="w-10 h-10 rounded-full object-cover" />
                    <div className="flex-1">
                      <p className="text-sm font-medium text-white truncate">{conv.title}</p>
                      <p className="text-xs text-white/60">{new Date(conv.updated_at).toLocaleDateString()}</p>
                    </div>
                  </div>
                  <button
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); setConfirmChatId(conv.id); }}
                    className="absolute top-1/2 -translate-y-1/2 right-2 p-1 rounded-full bg-red-500/50 hover:bg-red-500/80 text-white opacity-100 md:opacity-0 md:group-hover:opacity-100 transition-opacity"
                  >
                    <DeleteIcon className="h-4 w-4" />
                  </button>
                </Link>
              ))
            )}
          </div>
          
          {/* NSFW Toggle Section */}
          <div className="mt-auto pt-2 border-t border-white/10">
            <div className="flex items-center justify-between">
              <div className="text-sm">
                <p>NSFW Content</p>
              </div>
              <button
                onClick={async () => {
                  if (!isPremium) {
                    setIsNsfwModalOpen(true);
                    return;
                  }
                  const newValue = !nsfwMode;
                  setNsfwMode(newValue);
                  try {
                    await apiClient.put('/user/profile', { nsfw_enabled: newValue });
                  } catch (e) {
                    // Revert on error
                    setNsfwMode(!newValue);
                  }
                }}
                className={`relative h-6 w-11 rounded-full transition ${nsfwMode && isPremium ? 'bg-gradient-to-r from-pink-500 to-purple-600' : 'bg-white/15'}`}
                aria-pressed={nsfwMode}
                title={!isPremium ? 'Premium feature' : 'Toggle NSFW content'}
              >
                <span className={`absolute top-1/2 -translate-y-1/2 transform rounded-full bg-white transition ${nsfwMode && isPremium ? 'left-6 h-4 w-4' : 'left-1 h-4 w-4'}`} />
              </button>
            </div>
          </div>
        </aside>

        {/* Mobile Bottom Navigation */}
        {!isLeftSidebarOpen && !isRightSidebarOpen && (
          <MobileBottomNav
            onOpenLeftSidebar={() => { setIsLeftSidebarOpen(true); setIsRightSidebarOpen(false); }}
            onOpenRightSidebar={() => { setIsRightSidebarOpen(true); setIsLeftSidebarOpen(false); }}
            showInput={true}
          >
            <div className="relative">
              <form onSubmit={(e) => { e.preventDefault(); onSubmit(); }} className="flex items-center gap-2">
                <textarea
                  className="flex-1 rounded-full border border-white/20 bg-white/5 px-4 py-3 pr-24 text-white outline-none placeholder:text-gray-400 focus:border-pink-500 resize-none overflow-hidden"
                  placeholder="Type a message"
                  value={input}
                  onChange={(e) => {
                    setInput(e.target.value);
                    autoResizeTextarea(e.target);
                  }}
                  ref={!isDesktop ? inputRef : null}
                  autoFocus={!isDesktop}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      e.stopPropagation();
                      onSubmit();
                      setTimeout(() => {
                        const ml = messagesListRef.current;
                        if (ml) ml.scrollTop = ml.scrollHeight;
                      }, 0);
                    }
                  }}
                  disabled={streaming || Boolean(cooldownMsg) || Boolean(dailyLimitMsg)}
                  rows={1}
                />
                {/* Voice Call Button */}
                <div className="absolute right-14 top-1/2 -translate-y-1/2">
                  {character && (
                    <VoiceCallButton
                      characterId={character.id}
                      character={{
                        id: character.id,
                        name: character.name,
                        avatar_url: character.avatar_url || undefined,
                        voice: (character as any).voice_id && ALLOWED_VOICES.includes(((character as any).voice_id || '').toLowerCase()) ? ((character as any).voice_id as string).toLowerCase() : (ALLOWED_VOICES.includes(character.name.toLowerCase()) ? character.name.toLowerCase() : 'luna'),
                        prompt: character.system_prompt || ''
                      }}
                      conversationId={currentConversationId || undefined}
                      onTranscriptUpdate={(partialTranscript) => {
                        // Update input field as user speaks
                        console.log('Updating input field with transcript:', partialTranscript);
                        setInput(partialTranscript);
                      }}
                      onTranscript={(transcript) => {
                        console.log('User spoke (final):', transcript);
                        // Add user message to chat
                        setMessages(prev => [...prev, { role: 'user' as const, content: transcript }]);
                        // Add assistant message with loading indicator (empty triggers BouncingLoader)
                        setMessages(prev => {
                          const newMessages = [...prev, { role: 'assistant' as const, content: '' }];
                          currentAssistantIndexRef.current = newMessages.length - 1;
                          return newMessages;
                        });
                        assistantMessageRef.current = '';
                        setStreaming(true); // Enable streaming state for BouncingLoader
                      }}
                      onAIResponseChunk={(chunk) => {
                        // Stream with natural delay to match TTS pace
                        streamTextWithDelay(chunk);
                      }}
                      onAIResponse={(response) => {
                        console.log('AI responded (final):', response);
                        
                        // If empty response (e.g. call ended before AI replied), just reset streaming state
                        if (!response || response.trim() === '') {
                          console.log('Empty AI response (call ended) - just resetting streaming state');
                          setStreaming(false);
                          return;
                        }
                        
                        // Finalize the assistant message
                        assistantMessageRef.current = response;
                        setMessages(prev => {
                          const next = [...prev];
                          const idx = currentAssistantIndexRef.current;
                          if (idx != null && idx >= 0 && idx < next.length && next[idx]?.role === 'assistant') {
                            next[idx] = { ...next[idx], content: response };
                          }
                          return next;
                        });
                        setStreaming(false); // Disable streaming state
                      }}
                      onError={(error) => {
                        console.error('Voice call error:', error);
                        window.alert(`Voice call error: ${error}`);
                      }}
                      disabled={streaming || Boolean(cooldownMsg) || Boolean(dailyLimitMsg)}
                    />
                  )}
                </div>
                {/* Send Button */}
                <button type="submit" className="absolute right-2 top-1/2 -translate-y-1/2 w-10 h-10 rounded-full bg-gradient-to-r from-pink-500 to-purple-600 text-white shadow-lg transition hover:brightness-110 disabled:opacity-50 flex items-center justify-center" disabled={streaming || Boolean(cooldownMsg)}>
                  {streaming ? (
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <SendIcon className="h-5 w-5" />
                  )}
                </button>
              </form>
            </div>
          </MobileBottomNav>
        )}

        {/* Confirm delete memory modal */}
        <Modal
          isOpen={!!confirmMemoryId}
          onClose={() => setConfirmMemoryId(null)}
          title="Delete memory?"
        >
          <p className="text-sm text-white/80 mb-4">This action cannot be undone.</p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirmMemoryId(null)} className="px-3 py-1 rounded bg-white/10 text-white">Cancel</button>
            <button
              onClick={async () => {
                const id = confirmMemoryId!;
                setConfirmMemoryId(null);
                try {
                  await apiClient.delete(`/memories/${id}`);
                  setMemories(m => m.filter(mem => mem.id !== id));
                } catch (e) {
                  console.error('Failed to delete memory:', e);
                }
              }}
              className="px-3 py-1 rounded bg-red-600 text-white"
            >
              Delete
            </button>
          </div>
        </Modal>

        {/* Confirm delete conversation modal */}
        <Modal
          isOpen={!!confirmChatId}
          onClose={() => setConfirmChatId(null)}
          title="Delete chat history?"
        >
          <p className="text-sm text-white/80 mb-4">This will remove the conversation and its history.</p>
          <div className="flex justify-end gap-2">
            <button onClick={() => setConfirmChatId(null)} className="px-3 py-1 rounded bg-white/10 text-white">Cancel</button>
            <button
              onClick={async () => {
                const id = confirmChatId!;
                setConfirmChatId(null);
                try {
                  await apiClient.delete(`/conversations/${id}`);
                  setRecentConversations(rc => rc.filter(c => c.id !== id));
                  if (currentConversationId === id) navigate('/characters');
                } catch (e) {
                  console.error('Failed to delete conversation:', e);
                }
              }}
              className="px-3 py-1 rounded bg-red-600 text-white"
            >
              Delete
            </button>
          </div>
        </Modal>

        {/* Overlay to close sidebars */}
        {(isLeftSidebarOpen || isRightSidebarOpen) && (
          <div
            className="md:hidden fixed inset-0 bg-black/50 z-10"
            onClick={() => {
              setIsLeftSidebarOpen(false);
              setIsRightSidebarOpen(false);
            }}
          />
        )}
      </div>
      <Modal
        isOpen={isNsfwModalOpen}
        onClose={() => setIsNsfwModalOpen(false)}
        title="Premium Feature"
      >
        <div className="text-white">
          <p>NSFW mode is a premium feature. Please upgrade your account to enable it.</p>
          <div className="mt-4 flex justify-end">
            <Link to="/subscribe" className="bg-pink-500 text-white px-4 py-2 rounded-lg">
              Upgrade
            </Link>
          </div>
        </div>
      </Modal>

      {/* Edit message modal */}
      <Modal
        isOpen={!!editTarget}
        onClose={() => { setEditTarget(null); setEditText(''); }}
        title="Edit your message"
        size="md"
      >
        <div className="text-white">
          <textarea
            className="w-full rounded-lg border border-white/20 bg-black/40 p-2 text-sm"
            rows={4}
            value={editText}
            onChange={(e) => setEditText(e.target.value)}
            autoFocus
          />
          <div className="mt-3 flex justify-end gap-2">
            <button className="px-3 py-1 rounded bg-white/10 text-white" onClick={() => { setEditTarget(null); setEditText(''); }}>Cancel</button>
            <button
              className="px-3 py-1 rounded bg-pink-600 text-white"
              onClick={async () => {
                if (!editTarget) return;
                const trimmed = (editText || '').trim();
                const idx = editTarget.index;
                const prevText = editTarget.text;
                if (!trimmed || trimmed === prevText) { setEditTarget(null); return; }
                setMessages(prev => prev.map((mm, ii) => ii === idx ? { ...mm, content: trimmed } : mm));
                try {
                  if (editTarget.id) {
                    const res = await apiClient.put(`/chat/message/${editTarget.id}`, { content: trimmed });
                    if (!res.ok) throw new Error('Failed to update on server');
                  }
                } catch (e) {
                  console.error('Failed to update message', e);
                  setMessages(prev => prev.map((mm, ii) => ii === idx ? { ...mm, content: prevText } : mm));
                } finally {
                  setEditTarget(null);
                  setEditText('');
                }
              }}
            >
              Save
            </button>
          </div>
        </div>
      </Modal>

      {/* Mobile long-press action sheet */}
      <Modal
        isOpen={!!longPressMessage}
        onClose={() => setLongPressMessage(null)}
        title="Message actions"
        size="sm"
      >
        <div className="flex flex-col gap-2 text-white">
          <button
            className="w-full px-3 py-2 rounded bg-white/10 hover:bg-white/20 text-left"
            onClick={() => {
              if (!longPressMessage) return;
              const idx = longPressMessage.index;
              const msg = messages[idx];
              if (!msg) return;
              setEditTarget({ index: idx, id: msg.id, text: msg.content });
              setEditText(msg.content);
              setLongPressMessage(null);
            }}
          >
            Edit
          </button>
          <button
            className="w-full px-3 py-2 rounded bg-white/10 hover:bg-white/20 text-left"
            onClick={() => {
              if (!longPressMessage) return;
              const idx = longPressMessage.index;
              const msg = messages[idx];
              if (!msg) return;
              pinMessageAsMemory(idx, msg.role, msg.content);
              setLongPressMessage(null);
            }}
          >
            📌 Pin as Memory
          </button>
          <button
            className="w-full px-3 py-2 rounded bg-red-600/80 hover:bg-red-600 text-left"
            onClick={async () => {
              if (!longPressMessage) return;
              const idx = longPressMessage.index;
              const msg = messages[idx];
              const tryDelete = async (id: string | undefined) => {
                if (!id) return false;
                try { const res = await apiClient.delete(`/chat/message/${id}`); return res.ok || res.status === 204; } catch { return false; }
              };
              if (await tryDelete(msg?.id)) {
                setMessages(prev => prev.filter((_, ii) => ii !== idx));
              } else {
                setMessages(prev => prev.filter((_, ii) => ii !== idx));
              }
              setLongPressMessage(null);
            }}
          >
            Delete
          </button>
          <button className="w-full px-3 py-2 rounded bg-white/10 hover:bg-white/20" onClick={() => setLongPressMessage(null)}>Cancel</button>
        </div>
      </Modal>
    </div>
  );
}


