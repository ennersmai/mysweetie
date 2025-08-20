import type { FormEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { useNavigate, useParams } from 'react-router-dom';
import { authFetch } from '../lib/functionsClient';
import { supabase } from '../lib/supabaseClient';

type Message = { role: 'user' | 'assistant'; content: string };

export default function Chat() {
  const { characterId, conversationId } = useParams();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [streaming, setStreaming] = useState(false);
	const [modelKey, setModelKey] = useState('Dolphin Venice');
  const [voiceKey, setVoiceKey] = useState('Aria Velvet');
  const [voiceEnabled, setVoiceEnabled] = useState(true);
  const [fantasyMode, setFantasyMode] = useState(false);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const [character, setCharacter] = useState<{ name: string; avatar_url: string | null; description: string | null } | null>(null);
  const [currentConversationId, setCurrentConversationId] = useState<string | null>(conversationId || null);
  const [conversations, setConversations] = useState<Array<{id: string; title: string; updated_at: string}>>([]);
  const [isPremium, setIsPremium] = useState(false);
  const [planTier, setPlanTier] = useState<'free' | 'basic' | 'premium'>('free');
  const [voiceRemaining, setVoiceRemaining] = useState<number>(0);
  const [cooldownMsg, setCooldownMsg] = useState<string | null>(null);
  const [isDesktop, setIsDesktop] = useState(() => {
    if (typeof window !== 'undefined' && 'matchMedia' in window) {
      return window.matchMedia('(min-width: 768px)').matches;
    }
    return false;
  });

  const MODEL_OPTIONS: { key: string; desc: string; premium?: boolean }[] = [
    { key: 'Dolphin Venice', desc: 'GPT-4o Mini — fast, reliable, and great for everyday conversations.' },
    { key: 'Swift Muse', desc: 'Large Mixture-of-Experts model that balances reasoning and breadth.' },
    { key: 'Crystal Focus', desc: 'Claude 3.5 Sonnet — powerful reasoning with creative capabilities.', premium: true },
    { key: 'Velvet Intellect', desc: 'MythoMax L2 — classic RP model with uncensored NSFW support.', premium: true },
    { key: 'Midnight Nova', desc: 'Llama 3.1 8B — versatile instruct model for roleplay.', premium: true },
    { key: 'Silver Whisper', desc: 'Command R+ — advanced model with excellent NSFW capabilities.', premium: true },
	];
  const audioQueue = useRef<string[]>([]);
  const audioRef = useRef<HTMLAudioElement | null>(null);
  const playingRef = useRef(false);
  const [playingIndex, setPlayingIndex] = useState<number | null>(null);

  useEffect(() => {
    if (!audioRef.current) audioRef.current = new Audio();
  }, []);

  useEffect(() => {
    // Scroll to bottom when new messages arrive
    scrollRef.current?.scrollIntoView({ behavior: 'smooth' });
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
    const loadCharacter = async () => {
      if (!characterId) return;
      const { data } = await supabase
        .from('characters')
        .select('name, avatar_url, description')
        .eq('id', characterId)
        .maybeSingle();
      setCharacter((data as any) ?? null);
    };
    loadCharacter();
  }, [characterId]);

  useEffect(() => {
    const loadConversations = async () => {
      if (!characterId) return;
      const { data: userData } = await supabase.auth.getUser();
      if (!userData.user) return;
      const { data, error } = await supabase
        .from('conversations')
        .select('id, title, updated_at')
        .eq('character_id', characterId)
        .order('updated_at', { ascending: false })
        .limit(50);
      if (error) return;
      setConversations((data || []) as any);
    };
    loadConversations();
  }, [characterId]);

  useEffect(() => {
    const loadHistory = async () => {
      if (!currentConversationId) return;
      const { data, error } = await supabase
        .from('chat_history')
        .select('role, content, created_at')
        .eq('conversation_id', currentConversationId)
        .order('created_at', { ascending: true })
        .limit(200);
      if (error) return;
      const mapped = (data || []).map((m) => ({ role: (m as any).role as 'user' | 'assistant', content: (m as any).content as string }));
      setMessages(mapped);
    };
    loadHistory();
  }, [currentConversationId]);

  useEffect(() => {
    const loadPremium = async () => {
      const { data: u } = await supabase.auth.getUser();
      if (!u.user) return;
      const { data } = await supabase
        .from('profiles')
        .select('is_premium, plan_tier, voice_trials_used, voice_quota_used')
        .eq('id', u.user.id)
        .maybeSingle();
      const premium = Boolean(data?.is_premium);
      setIsPremium(premium);
      const tier = (data?.plan_tier as 'free' | 'basic' | 'premium' | undefined) ?? (premium ? 'basic' : 'free');
      setPlanTier(tier);
      const trials = Number((data as any)?.voice_trials_used ?? 0);
      const quota = Number((data as any)?.voice_quota_used ?? 0);
      let remaining = 0;
      if (!premium) remaining = Math.max(0, 3 - trials);
      else if (tier === 'basic') remaining = Math.max(0, 50 - quota);
      else remaining = Math.max(0, 500 - quota); // Premium gets 500 voice streams
      setVoiceRemaining(remaining);
      if (remaining <= 0) setVoiceEnabled(false);
    };
    loadPremium();
    const id = setInterval(loadPremium, 4000);
    return () => clearInterval(id);
  }, []);

  const playNextAudio = () => {
    if (!voiceEnabled) {
      console.log('Audio disabled, skipping playback');
      return;
    }
    if (playingRef.current) {
      console.log('Already playing audio, will retry when current finishes');
      return; // Already playing, will be called again when current finishes
    }
    
    const next = audioQueue.current.shift();
    if (!next) {
      console.log('No audio chunks in queue');
      return;
    }
    
    console.log(`Playing audio chunk, ${audioQueue.current.length} remaining in queue`);
    playingRef.current = true;
    setPlayingIndex(messages.length - 1); // Set playing for the last (current) assistant message
    
    const el = audioRef.current!;
    el.src = next;
    
    const cleanup = () => {
      playingRef.current = false;
      setPlayingIndex(null);
      // Immediately try to play next chunk without delay
      console.log('Audio chunk finished, checking for next chunk');
      playNextAudio();
    };
    
    el.onended = cleanup;
    el.onerror = () => {
      console.warn('Audio playback error');
      cleanup();
    };
    
    // Auto-play the audio
    el.play().catch((err) => {
      console.warn('Auto-play failed:', err);
      cleanup();
    });
  };

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
      setConversations(prev => [data as any, ...prev]);
      setCurrentConversationId(data.id);
      setMessages([]);
      navigate(`/chat/${characterId}/${data.id}`, { replace: true });
    }
  };

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!input.trim() || !characterId) return;
    
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
        .select('id')
        .single();

      if (error || !data) return;
      conversationToUse = data.id;
      setCurrentConversationId(conversationToUse);
      navigate(`/chat/${characterId}/${conversationToUse}`, { replace: true });
      
      // Reload conversations list
      const { data: convData } = await supabase
        .from('conversations')
        .select('id, title, updated_at')
        .eq('character_id', characterId)
        .order('updated_at', { ascending: false })
        .limit(50);
      if (convData) setConversations(convData as any);
    }
    
    const userMsg: Message = { role: 'user', content: input };
    setMessages((m) => [...m, userMsg, { role: 'assistant', content: '' }]);
    setInput('');
    setStreaming(true);
    
    // Clear audio queue and reset playing state for new conversation
    audioQueue.current = [];
    playingRef.current = false;
    setPlayingIndex(null);
    if (audioRef.current) {
      audioRef.current.pause();
      audioRef.current.src = '';
    }
    try {
		const res = await authFetch('/chat', {
        method: 'POST',
			body: JSON.stringify({ characterId, conversationId: conversationToUse, message: userMsg.content, voice: voiceEnabled, modelKey, voiceKey, fantasyMode }),
      });
      if (res.status === 429) {
        const data = await res.json().catch(() => ({} as any));
        setCooldownMsg(data?.message || "You're sending messages a bit too quickly. Please try again in a moment.");
        // Remove the just-added user and placeholder assistant messages
        setMessages((prev) => prev.slice(0, Math.max(0, prev.length - 2)));
        setTimeout(() => setCooldownMsg(null), 5000);
        return;
      }
      if (!res.body) throw new Error('No stream');
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const chunks = buffer.split('\n\n');
        buffer = chunks.pop() ?? '';
        for (const chunk of chunks) {
          const lines = chunk.split('\n');
          const ev = lines.find((l) => l.startsWith('event:'))?.slice(6).trim();
          const dataLine = lines.find((l) => l.startsWith('data:'))?.slice(5).trim();
          if (!ev || !dataLine) continue;
          if (ev === 'token') {
            const { delta } = JSON.parse(dataLine);
            setMessages((prev) => {
              const copy = [...prev];
              // append delta to last assistant message
              copy[copy.length - 1] = { role: 'assistant', content: copy[copy.length - 1].content + (delta || '') };
              return copy;
            });
          } else if (ev === 'audio') {
            const { audioBase64 } = JSON.parse(dataLine);
            if (audioBase64) {
              audioQueue.current.push(audioBase64);
              console.log(`Added audio chunk to queue, queue size: ${audioQueue.current.length}`);
              playNextAudio();
            }
          } else if (ev === 'end') {
            // Stream ended, make sure all remaining audio plays
            console.log(`Stream ended, ${audioQueue.current.length} audio chunks remaining`);
            playNextAudio();
          }
        }
      }
    } catch (err) {
      // handle error UI as needed
    } finally {
      setStreaming(false);
      // Ensure any remaining audio chunks play after streaming ends
      setTimeout(() => playNextAudio(), 100);
      if (isDesktop) {
        setTimeout(() => inputRef.current?.focus(), 50);
      }
    }
  };

  return (
    <section className="rounded-2xl border border-white/10 bg-transparent text-white">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-[240px_1fr]">
        {/* Sidebar with selectors */}
        <aside className="rounded-2xl border border-white/10 bg-white/5 p-2 backdrop-blur h-auto md:h-[75vh] overflow-hidden md:flex md:flex-col">
          {/* Character card */}
          <div className="mb-4 flex items-center gap-3">
            {character?.avatar_url ? (
              <img src={character.avatar_url} alt={character.name} className="h-12 w-12 rounded-full object-cover ring-2 ring-pink-500/40" />
            ) : (
              <div className="h-12 w-12 rounded-full bg-gradient-to-br from-pink-400 to-purple-600 ring-2 ring-pink-500/40" />
            )}
            <div>
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

          {/* Conversations List */}
          {conversations.length > 0 && (
            <div className="mb-4 max-h-32 overflow-y-auto">
              <div className="mb-2 text-xs text-white/80">Recent Chats</div>
              <div className="space-y-1">
                {conversations.map((conv) => (
                  <button
                    key={conv.id}
                    onClick={() => {
                      setCurrentConversationId(conv.id);
                      navigate(`/chat/${characterId}/${conv.id}`);
                    }}
                    className={`w-full rounded border px-2 py-1.5 text-left text-xs transition ${
                      currentConversationId === conv.id
                        ? 'border-pink-500/50 bg-pink-500/10 text-white'
                        : 'border-white/20 bg-white/5 text-white/90 hover:bg-white/10'
                    }`}
                  >
                    <div className="truncate">{conv.title}</div>
                    <div className="text-[10px] text-white/60">
                      {new Date(conv.updated_at).toLocaleDateString()}
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
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
              <option className="bg-gray-900 text-white">Aria Velvet</option>
              <option className="bg-gray-900 text-white">Nova Azure</option>
              <option className="bg-gray-900 text-white">Mira Whisper</option>
              <option className="bg-gray-900 text-white">Zara Ember</option>
              <option className="bg-gray-900 text-white">Luna Aurora</option>
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
        <div className="rounded-2xl border border-white/10 bg-white/5 p-2 shadow-xl backdrop-blur" onClick={() => isDesktop && inputRef.current?.focus()}>
          <h2 className="mb-1 text-lg font-semibold">Chat</h2>
          <div className="flex h-[50vh] md:h-[55vh] flex-col overflow-hidden">
            <div className="flex-1 space-y-2 overflow-y-auto pr-1">
          {messages.map((m, i) => (
            <div key={i} className={m.role === 'user' ? 'text-right' : 'text-left'}>
              <div className={`relative inline-block max-w-[80%] rounded-2xl ${m.role === 'user' ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white' : 'bg-white/10 text-white/90'} px-3 py-2 text-sm`}>
                {/* Top-left controls row (icon + waveform) */}
                {m.role === 'assistant' && voiceEnabled && (
                  <div className="pointer-events-auto absolute -top-3 left-2 flex items-center gap-2">
                    <button
                      type="button"
                      aria-label="Play voice"
                      className="flex h-6 w-6 items-center justify-center rounded-full bg-white/20 text-white hover:bg-white/30"
                      onClick={async () => {
                        try {
                          setPlayingIndex(i);
                          const res = await authFetch('/tts', {
                            method: 'POST',
                            body: JSON.stringify({ text: m.content, voiceKey, characterId, conversationId: currentConversationId }),
                          });
                          const json = await res.json();
                          if (json?.audioBase64) {
                            audioQueue.current.push(json.audioBase64 as string);
                            playNextAudio();
                            if (typeof json.remaining === 'number') setVoiceRemaining(json.remaining as number);
                          } else {
                            setPlayingIndex(null);
                          }
                        } catch {
                          setPlayingIndex(null);
                        }
                      }}
                    >
                      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="currentColor" className="h-3.5 w-3.5"><path d="M8 5v14l11-7z"/></svg>
                    </button>
                    {playingIndex === i && (
                      <div className="flex items-end gap-1">
                        <span className="wavebar"/>
                        <span className="wavebar"/>
                        <span className="wavebar"/>
                        <span className="wavebar"/>
                        <span className="wavebar"/>
                      </div>
                    )}
                  </div>
                )}
                <div className="whitespace-pre-wrap">{m.content}</div>
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
            <form onSubmit={onSubmit} className="mt-1 flex items-center gap-2">
              <input
                className="flex-1 rounded-full border border-white/20 bg-white/5 px-4 py-3 text-white outline-none placeholder:text-gray-400 focus:border-pink-500"
                placeholder="Type a message"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                ref={inputRef}
                autoFocus={isDesktop}
                disabled={streaming || Boolean(cooldownMsg)}
              />
              <button type="submit" className="rounded-full bg-gradient-to-r from-pink-500 to-purple-600 px-6 py-3 text-white shadow transition hover:brightness-110 disabled:opacity-50" disabled={streaming || Boolean(cooldownMsg)}>
                {streaming ? 'Streaming…' : 'Send'}
              </button>
            </form>
          </div>
        </div>
      </div>
    </section>
  );
}


