import { useState, useEffect, useRef, useCallback, type FormEvent } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { apiClient } from '../lib/apiClient';
import RefreshIcon from '../assets/refresh.svg?react';
import DeleteIcon from '../assets/delete.svg?react';
import { useLocalStorage } from '../hooks/useLocalStorage';
import Modal from '../components/Modal';
import VoiceCallButton from '../components/VoiceCallButton';

type Message = { role: 'user' | 'assistant'; content: string };
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

export default function Chat({ menuOpen }: { menuOpen: boolean }) {
  const { characterId, conversationId } = useParams();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
	const [modelKey, setModelKey] = useState(() => {
    return localStorage.getItem('modelKey') || 'Sweet Myth';
  });
  const [voiceKey, setVoiceKey] = useLocalStorage('voiceKey', 'luna');
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [fantasyMode, setFantasyMode] = useState(false);
  const [nsfwMode, setNsfwMode] = useState(false); // Add nsfwMode state
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const isInitialMount = useRef(true);
  const [character, setCharacter] = useState<{ id: string; name: string; avatar_url: string | null; description: string | null; system_prompt: string | null; } | null>(null);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(conversationId || null);
  const [isPremium, setIsPremium] = useState(false);
  const [planTier, setPlanTier] = useState<'free' | 'basic' | 'premium'>('free');
  const [voiceRemaining, setVoiceRemaining] = useState<number>(0);
  const [cooldownMsg, setCooldownMsg] = useState<string | null>(null);
  const [recentConversations, setRecentConversations] = useState<any[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);
  const [memories, setMemories] = useState<Memory[]>([]);
  const [memoriesLoading, setMemoriesLoading] = useState(false);
  const [isNsfwModalOpen, setIsNsfwModalOpen] = useState(false);
  const [isLeftSidebarOpen, setIsLeftSidebarOpen] = useState(false);
  const [isRightSidebarOpen, setIsRightSidebarOpen] = useState(false);
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

  const MODEL_OPTIONS: { key: string; desc: string; premium?: boolean }[] = [
    { key: 'Sweet Myth', desc: 'Grok-4 Fast — quick, capable general model (free).' },
    { key: 'Swift Muse', desc: 'Dolphin Mistral 24B (Venice) — creative and expressive (free).' },
    { key: 'Crystal Focus', desc: 'ReMM Slerp L2 13B — concise, logical responses.', premium: true },
    { key: 'Midnight Nova', desc: 'Anubis 70B — powerful roleplay and character immersion.', premium: true },
    { key: 'Silver Whisper', desc: 'Euryale 70B — advanced storytelling with rich detail.', premium: true },
  ];
  const ALLOWED_VOICES = [
    'luna',
    'celeste',
    'ursa',
    'astra',
    'esther',
    'estelle',
    'andromeda',
  ];
  // HTTP PCM TTS via Arcana
  const audioCtxRef = useRef<AudioContext | null>(null);
  const ttsPlayheadRef = useRef<number>(0); // seconds scheduled ahead in AudioContext time
  const ttsSampleRateRef = useRef<number>(24000);
  const ttsSentenceBufRef = useRef<string>('');
  const ttsDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const ttsQueueRef = useRef<{ speaker: string; text: string }[]>([]);
  const ttsProcessingRef = useRef<boolean>(false);
  const ttsStreamingRef = useRef<boolean>(false);
  const ttsAbortRef = useRef<AbortController | null>(null);
  const ttsSourcesRef = useRef<AudioBufferSourceNode[]>([]);

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
      audioCtxRef.current = new Ctx();
    }
    if (audioCtxRef.current?.state === 'suspended') {
      try { await audioCtxRef.current.resume(); } catch {}
    }
    return audioCtxRef.current!;
  };

  const schedulePcmChunk = (arrayBuffer: ArrayBuffer) => {
    const audioCtx = audioCtxRef.current;
    if (!audioCtx) return;
    const samples = new Int16Array(arrayBuffer);
    const float = new Float32Array(samples.length);
    for (let i = 0; i < samples.length; i++) float[i] = samples[i] / 32768;
    const sr = ttsSampleRateRef.current || 22050;
    const audioBuffer = audioCtx.createBuffer(1, float.length, sr);
    audioBuffer.getChannelData(0).set(float);

    const source = audioCtx.createBufferSource();
    source.buffer = audioBuffer;
    source.connect(audioCtx.destination);

    const startAt = Math.max(audioCtx.currentTime + 0.15, ttsPlayheadRef.current);
    source.start(startAt);
    ttsSourcesRef.current.push(source);
    ttsPlayheadRef.current = startAt + audioBuffer.duration;

    source.onended = () => {
      // When we reach the end of the last scheduled chunk, clear playing UI
      const remaining = ttsPlayheadRef.current - audioCtx.currentTime;
      if (remaining <= 0.05) {
        setPlayingIndex(null);
      }
      // Remove from active sources list
      ttsSourcesRef.current = ttsSourcesRef.current.filter(s => s !== source);
    };
  };

  const stopTtsNow = useCallback(() => {
    try { ttsAbortRef.current?.abort(); } catch {}
    ttsAbortRef.current = null;
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
  }, []);

  // Speak a single sentence via HTTP PCM endpoint
  const speakPcm = useCallback(async (speaker: string, text: string) => {
    if (!text.trim()) return;
    await ensureAudioContext();
    // Do not reset playhead here to ensure strict sequential playback across sentences
    const controller = new AbortController();
    ttsAbortRef.current = controller;
    let res: Response;
    try {
      res = await apiClient.streamAudio('/tts/pcm', {
      text,
      speaker,
      modelId: 'arcana',
      samplingRate: ttsSampleRateRef.current || 24000,
      lang: 'eng',
      }, controller.signal as any);
    } catch (e) {
      // aborted or failed
      return;
    }
    if (!res.ok || !res.body) return;
    const reader = res.body.getReader();
    // Read streaming PCM chunks
    while (true) {
      let readResult;
      try { readResult = await reader.read(); } catch { break; }
      const { value, done } = readResult;
      if (done) break;
      if (value) {
        const ab = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
        schedulePcmChunk(ab);
      }
    }
  }, []);

  const processTtsQueue = useCallback(async () => {
    if (ttsProcessingRef.current) return;
    ttsProcessingRef.current = true;
    try {
      while (ttsQueueRef.current.length > 0) {
        const { speaker, text } = ttsQueueRef.current.shift()!;
        ttsStreamingRef.current = true;
        await speakPcm(speaker, text);
        ttsStreamingRef.current = false;
        // Add small gap to avoid clicks between sentences
        await new Promise(r => setTimeout(r, 80));
      }
    } finally {
      ttsProcessingRef.current = false;
    }
  }, [speakPcm]);

  // Ensure input refocuses when streaming ends (after any send)
  useEffect(() => {
    if (!streaming) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
  }, [streaming]);

  const enqueueTts = useCallback((speaker: string, text: string, force: boolean = false) => {
    const trimmed = cleanTtsText(text);
    if (!trimmed) return;
    // Prevent flooding the queue with tiny fragments during active streaming
    if (!force && ttsStreamingRef.current && trimmed.length < 40) return;
    ttsQueueRef.current.push({ speaker, text: trimmed });
    processTtsQueue();
  }, [processTtsQueue]);

  // Removed WS ttsSend/ttsEnd

  const ttsAppendSentence = (chunk: string) => {
    if (!chunk) return;
    // Normalize and accumulate
    const incoming = chunk.replace(/\s+/g, ' ');
    ttsSentenceBufRef.current += incoming;
    // If a sentence end is present, split and send full sentences
    let buf = ttsSentenceBufRef.current;
    const parts = buf.split(/((?:\.\.\.|[\.\!\?])[\)\]"']?(?:\s+|$))/); // keep delimiters; handle ellipsis and EoS
    if (parts.length > 1) {
      let assembled = '';
      let i = 0;
      for (; i < parts.length - 1; i += 2) {
        assembled += parts[i] + (parts[i + 1] || '');
        const sentence = cleanTtsText(assembled);
        if (sentence.length >= 6) enqueueTts((voiceKey || 'luna').toLowerCase(), sentence, true);
        assembled = '';
      }
      // Whatever remains after processing full pairs stays in buffer
      const remainder = parts.slice(i).join('');
      ttsSentenceBufRef.current = remainder;
    } else {
      // No boundary yet; debounce-send long clauses to reduce initial delay
      if (ttsDebounceRef.current) clearTimeout(ttsDebounceRef.current);
      if (buf.length >= 140 && /\s$/.test(buf)) {
        const toSend = buf;
        ttsSentenceBufRef.current = '';
        enqueueTts((voiceKey || 'luna').toLowerCase(), toSend);
      } else {
        ttsDebounceRef.current = setTimeout(() => {
          const pending = ttsSentenceBufRef.current;
          if (pending.length >= 120 && /\s$/.test(pending)) {
            ttsSentenceBufRef.current = '';
            enqueueTts((voiceKey || 'luna').toLowerCase(), pending);
          }
        }, 250);
      }
    }
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
    // Ensure we scroll when the first message(s) appear so they don't jump out of view
    if (isInitialMount.current) {
      if (messages.length > 0) {
        isInitialMount.current = false;
        scrollRef.current?.scrollIntoView({ behavior: 'auto' });
      }
    } else {
      scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [messages]);

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
        .select('id, name, avatar_url, description, system_prompt')
        .eq('id', characterId)
        .maybeSingle();
      setCharacter((data as any) ?? null);
    };
    loadCharacter();
  }, [characterId]);

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
          // An empty array is valid history for a new conversation
          const mapped = (data || []).map((m: any) => ({ role: m.role as 'user' | 'assistant', content: m.content as string }));
          setMessages(mapped);
          didLoadHistoryRef.current = true;
        } else if (res.status === 404) {
          // A 404 means it's a new conversation with no history yet.
          // This is expected, so we just clear the messages.
          setMessages([]);
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
        .select('is_premium, plan_tier, voice_trials_used, voice_quota_used, nsfw_enabled, voice_credits')
        .eq('id', u.user.id)
        .maybeSingle();
      const premium = Boolean(data?.is_premium);
      setIsPremium(premium);
      setNsfwMode(data?.nsfw_enabled || false);
      const tier = (data?.plan_tier as 'free' | 'basic' | 'premium' | undefined) ?? (premium ? 'basic' : 'free');
      setPlanTier(tier);
      
      // Use new voice credits system
      const voiceCredits = Number(data?.voice_credits ?? 0);
      setVoiceRemaining(voiceCredits);
      if (voiceCredits <= 0) setVoiceEnabled(false);
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
    if (e) e.preventDefault();
    if (isDesktop) {
      setTimeout(() => inputRef.current?.focus(), 0);
    }
    const raw = regeneratedInput ?? input;
    const isAutoContinue = !regeneratedInput && (raw?.trim()?.length ?? 0) === 0;
    const messageToSend = isAutoContinue ? 'Continue' : raw;
    if (!characterId || !character) return;
    
    // Create new conversation if none exists
    let conversationToUse = currentConversationId;
    if (!conversationToUse) {
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
      if (!isAutoContinue) additions.push(userMsg);
      additions.push({ role: 'assistant', content: '' });
      addedCountRef.current = additions.length;
      assistantIndex = m.length + additions.length - 1;
      return [...m, ...additions];
    });
    assistantMessageRef.current = '';
    wordBufferRef.current = '';
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
    }
    try {
      // New API call to the Node.js backend
      // Ensure the input stays in view right after we add the placeholder assistant message
      // so the user's first message doesn't jump off-screen on new conversations
      scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
      const res = await apiClient.stream('/chat', {
        character: { ...character, model: modelKey },
        messages: isAutoContinue ? [...messages, { role: 'user', content: 'Continue' }] : [...messages, userMsg],
        nsfwMode,
        conversationId: conversationToUse,
        autoContinue: isAutoContinue,
      });

      if (res.status === 429) {
        const data = await res.json().catch(() => ({} as any));
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
              enqueueTts((voiceKey || 'luna').toLowerCase(), finalText, true);
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
                assistantMessageRef.current += chunk;
                wordBufferRef.current += chunk;

                if (voiceEnabled) {
                  // Buffer and send full sentences or long clauses via HTTP
                  ttsAppendSentence(chunk);
                }

                setMessages(prev => {
                  if (prev.length === 0) {
                    return [{ role: 'assistant', content: assistantMessageRef.current } as any];
                  }
                  const last = prev[prev.length - 1];
                  if (!last || last.role !== 'assistant') {
                    return [...prev, { role: 'assistant', content: assistantMessageRef.current } as any];
                  }
                  const next = [...prev];
                  next[next.length - 1] = { ...last, content: assistantMessageRef.current } as any;
                  return next;
                });
              } else if (data.type === 'final' && data.fullResponse) {
                const finalText: string = data.fullResponse;
                if (!assistantMessageRef.current) {
                  assistantMessageRef.current = finalText;
                  setMessages(prev => {
                    if (prev.length === 0) {
                      return [{ role: 'assistant', content: assistantMessageRef.current } as any];
                    }
                    const last = prev[prev.length - 1];
                    if (!last || last.role !== 'assistant') {
                      return [...prev, { role: 'assistant', content: assistantMessageRef.current } as any];
                    }
                    const next = [...prev];
                    next[next.length - 1] = { ...last, content: assistantMessageRef.current } as any;
                    return next;
                  });
                  if (voiceEnabled) {
                    // Enqueue full text if no chunks were processed
                    enqueueTts((voiceKey || 'luna').toLowerCase(), finalText, true);
                  }
                }
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
      if (isDesktop) {
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    }
  };

  return (
    <div className="w-full animated-gradient-subtle text-white">
      <div className="relative grid grid-cols-1 md:grid-cols-[240px_1fr_240px] gap-2 h-[calc(100vh-100px)]">
        {/* Left Sidebar with selectors */}
        <aside className={`fixed md:relative top-0 left-0 h-full w-64 md:w-auto bg-gray-900 md:bg-transparent z-20 transform ${isLeftSidebarOpen ? 'translate-x-0' : '-translate-x-full'} md:translate-x-0 transition-transform duration-300 ease-in-out md:flex flex-col rounded-r-2xl md:rounded-2xl border border-white/10 p-2 backdrop-blur overflow-hidden`}>
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
              <option className="bg-gray-900 text-white" value="luna">luna (female, gen-z optimist)</option>
              <option className="bg-gray-900 text-white" value="celeste">celeste (female, laid-back)</option>
              <option className="bg-gray-900 text-white" value="ursa">ursa (male, 2000s emo)</option>
              <option className="bg-gray-900 text-white" value="astra">astra (female, wide-eyed)</option>
              <option className="bg-gray-900 text-white" value="esther">esther (female, older)</option>
              <option className="bg-gray-900 text-white" value="estelle">estelle (female, middle-aged)</option>
              <option className="bg-gray-900 text-white" value="andromeda">andromeda (female, yoga vibes)</option>
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
            <div className="flex-1 space-y-2 overflow-y-auto pr-1">
          {messages.map((m, i) => (
            <div key={i} className={`my-2 ${m.role === 'user' ? 'text-right' : 'text-left'}`}>
              <div className={`relative inline-block max-w-[80%] rounded-2xl ${m.role === 'user' ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white' : 'bg-white/10 text-white/90'} px-4 py-2 text-sm`}>
                {/* Bouncing loader for assistant's empty message */}
                {m.role === 'assistant' && m.content === '' && streaming && (
                  <div className="p-2">
                    <BouncingLoader />
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
                      const lastUserMessage = messages[messages.length - 2];
                      if (lastUserMessage && lastUserMessage.role === 'user') {
                        setMessages(prev => prev.slice(0, -2));
                        // Re-submit the last user message
                        onSubmit(undefined, lastUserMessage.content);
                      }
                    }}
                    className="absolute -bottom-2 -right-2 p-1 rounded-full bg-white/10 hover:bg-white/20"
                    title="Regenerate response"
                  >
                    <RefreshIcon className="h-4 w-4" />
                  </button>
                )}

                <div 
                  className="whitespace-pre-wrap"
                  dangerouslySetInnerHTML={{ __html: parseActions(m.content) }} 
                />
              </div>
            </div>
          ))}
              <div ref={scrollRef} />
            </div>
            {cooldownMsg && (
              <div className="mt-3 rounded-lg border border-yellow-500/30 bg-yellow-500/10 px-3 py-2 text-xs text-yellow-200">
                {cooldownMsg}
              </div>
            )}
            <div className="hidden md:block">
              <form onSubmit={onSubmit} className="relative mt-1 flex items-center gap-2">
                <input
                  className="flex-1 rounded-full border border-white/20 bg-white/5 px-4 py-3 pr-24 text-white outline-none placeholder:text-gray-400 focus:border-pink-500"
                  placeholder="Type a message"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  ref={inputRef}
                  autoFocus={isDesktop}
                  disabled={streaming || Boolean(cooldownMsg)}
                />
                {/* Voice Call Button */}
                <div className="absolute right-14 top-1/2 -translate-y-1/2">
                  {character && (
                    <VoiceCallButton
                      characterId={character.id}
                      character={{
                        id: character.id,
                        name: character.name,
                        avatar_url: character.avatar_url || undefined
                      }}
                      conversationId={currentConversationId || undefined}
                      onError={(error) => {
                        console.error('Voice call error:', error);
                        window.alert(`Voice call error: ${error}`);
                      }}
                      onTranscript={(transcript) => {
                        // Add transcript as user message
                        console.log('Adding transcript to chat:', transcript);
                        setMessages(prev => [...prev, { role: 'user', content: transcript }]);
                      }}
                      onAIResponse={(response) => {
                        // Add AI response as assistant message
                        console.log('Adding AI response to chat:', response);
                        setMessages(prev => [...prev, { role: 'assistant', content: response }]);
                      }}
                      disabled={streaming || Boolean(cooldownMsg)}
                    />
                  )}
                </div>
                {/* Send Button */}
                <button type="submit" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-gradient-to-r from-pink-500 to-purple-600 p-2 text-white shadow transition hover:brightness-110 disabled:opacity-50" disabled={streaming || Boolean(cooldownMsg)}>
                  {streaming ? (
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  )}
                </button>
              </form>
            </div>
          </div>
        </main>

        {/* Right Sidebar for History and Memories */}
        <aside className={`fixed md:relative top-0 right-0 h-full w-64 md:w-auto bg-gray-900 md:bg-transparent z-20 transform ${isRightSidebarOpen ? 'translate-x-0' : 'translate-x-full'} md:translate-x-0 transition-transform duration-300 ease-in-out md:flex flex-col rounded-l-2xl md:rounded-2xl border border-white/10 p-2 backdrop-blur overflow-hidden`}>
          <button onClick={() => setIsRightSidebarOpen(false)} className="md:hidden self-end mb-2 p-2 rounded-full bg-red-500/50 text-white">
            <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" /></svg>
          </button>
          <div className="flex-1 overflow-y-auto space-y-2 no-scrollbar">
            <div className="flex justify-between items-center mb-2">
              <h3 className="text-md font-semibold text-white">Memories</h3>
              <button onClick={loadMemories} className="p-1 mr-2 rounded-full hover:bg-white/10" title="Refresh memories">
                <RefreshIcon className="h-4 w-4" />
              </button>
            </div>
            {memoriesLoading ? (
              <p className="text-sm text-white/70 text-center">Loading memories...</p>
            ) : memories.length === 0 ? (
              <p className="text-sm text-white/70 text-center">No memories yet.</p>
            ) : (
              memories.map((mem: any) => (
                <div key={mem.id} className="group relative p-2 rounded-lg bg-white/5">
                  <p className="text-xs text-white/80">{mem.memory_text}</p>
                  <button
                    onClick={async () => {
                      if (!window.confirm('Are you sure you want to delete this memory?')) return;
                      try {
                        await apiClient.delete(`/memories/${mem.id}`);
                        setMemories(m => m.filter(m => m.id !== mem.id));
                      } catch (e) {
                        console.error('Failed to delete memory:', e);
                      }
                    }}
                    className="absolute top-1 right-1 p-0.5 opacity-0 group-hover:opacity-100 transition-opacity bg-red-500/50 hover:bg-red-500/80 text-white w-5 h-5 rounded-full flex items-center justify-center text-xs"
                  >
                    <DeleteIcon className="h-3 w-3" />
                  </button>
                </div>
              ))
            )}
          </div>
          <div className="flex-1 overflow-y-auto space-y-2 mt-4 border-t border-white/10 pt-2">
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
                    onClick={async (e) => {
                      e.preventDefault();
                      e.stopPropagation();
                      if (!window.confirm('Are you sure you want to delete this chat history? This will also delete all associated memories.')) return;
                      try {
                        await apiClient.delete(`/conversations/${conv.id}`);
                        setRecentConversations(rc => rc.filter(c => c.id !== conv.id));
                        // If the deleted conversation is the current one, navigate away
                        if (currentConversationId === conv.id) {
                          navigate('/characters');
                        }
                      } catch (err) {
                        console.error('Failed to delete conversation:', err);
                      }
                    }}
                    className="absolute top-1/2 -translate-y-1/2 right-2 p-1 rounded-full bg-red-500/50 hover:bg-red-500/80 text-white opacity-0 group-hover:opacity-100 transition-opacity"
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

        {/* Mobile UI Elements */}
        <div className={`md:hidden ${isLeftSidebarOpen || isRightSidebarOpen ? 'hidden' : ''}`}>
          {/* Header */}
          <div className={`fixed top-4 ${menuOpen ? 'mt-40' : 'mt-16'} left-4 right-4 z-30 flex justify-between items-center`}>
            <button onClick={() => { setIsLeftSidebarOpen(true); setIsRightSidebarOpen(false); }} className="p-2 rounded-full bg-white/10 backdrop-blur">
              {/* Model Icon */}
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15l7-7 7 7" /></svg>
            </button>
            <button onClick={() => { setIsRightSidebarOpen(true); setIsLeftSidebarOpen(false); }} className="p-2 rounded-full bg-white/10 backdrop-blur">
              {/* History Icon */}
              <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6" fill="none" viewBox="0 0 24 24" stroke="currentColor"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" /></svg>
            </button>
          </div>

          {/* Chat Input */}
          <div className="fixed bottom-0 left-0 right-0 p-2 bg-gray-900 border-t border-white/10 rounded-t-2xl">
            <div className="relative">
              <form onSubmit={onSubmit} className="flex items-center gap-2">
                <input
                  className="flex-1 rounded-full border border-white/20 bg-white/5 px-4 py-3 pr-24 text-white outline-none placeholder:text-gray-400 focus:border-pink-500"
                  placeholder="Type a message"
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  ref={inputRef}
                  disabled={streaming || Boolean(cooldownMsg)}
                />
                {/* Voice Call Button */}
                <div className="absolute right-14 top-1/2 -translate-y-1/2">
                  {character && (
                    <VoiceCallButton
                      characterId={character.id}
                      character={{
                        id: character.id,
                        name: character.name,
                        avatar_url: character.avatar_url || undefined
                      }}
                      conversationId={currentConversationId || undefined}
                      onError={(error) => {
                        console.error('Voice call error:', error);
                        window.alert(`Voice call error: ${error}`);
                      }}
                      onTranscript={(transcript) => {
                        // Add transcript as user message
                        console.log('Adding transcript to chat:', transcript);
                        setMessages(prev => [...prev, { role: 'user', content: transcript }]);
                      }}
                      onAIResponse={(response) => {
                        // Add AI response as assistant message
                        console.log('Adding AI response to chat:', response);
                        setMessages(prev => [...prev, { role: 'assistant', content: response }]);
                      }}
                      disabled={streaming || Boolean(cooldownMsg)}
                    />
                  )}
                </div>
                {/* Send Button */}
                <button type="submit" className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-gradient-to-r from-pink-500 to-purple-600 p-2 text-white shadow transition hover:brightness-110 disabled:opacity-50" disabled={streaming || Boolean(cooldownMsg)}>
                  {streaming ? (
                    <div className="w-5 h-5 border-2 border-white border-t-transparent rounded-full animate-spin" />
                  ) : (
                    <svg xmlns="http://www.w3.org/2000/svg" className="h-5 w-5" viewBox="0 0 20 20" fill="currentColor">
                      <path fillRule="evenodd" d="M10.293 3.293a1 1 0 011.414 0l6 6a1 1 0 010 1.414l-6 6a1 1 0 01-1.414-1.414L14.586 11H3a1 1 0 110-2h11.586l-4.293-4.293a1 1 0 010-1.414z" clipRule="evenodd" />
                    </svg>
                  )}
                </button>
              </form>
            </div>
          </div>
        </div>

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
    </div>
  );
}


