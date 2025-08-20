import { useState } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../contexts/AuthContext';

export default function NewCharacter() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [name, setName] = useState('');
  const [shortDescription, setShortDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [voiceKey, setVoiceKey] = useState('Aria Velvet');
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: FormEvent) => {
    e.preventDefault();
    if (!user) {
      setError('You must be signed in.');
      return;
    }
    if (!name.trim() || !shortDescription.trim() || !systemPrompt.trim()) {
      setError('Please fill name, short description, and system prompt.');
      return;
    }
    setLoading(true);
    setError(null);

    let avatarUrl: string | null = null;
    try {
      if (avatarFile) {
        const ext = avatarFile.name.split('.').pop() || 'jpg';
        const path = `avatars/${crypto.randomUUID()}.${ext}`;
        const { error: upErr } = await supabase.storage
          .from('avatars')
          .upload(path, avatarFile, { cacheControl: '3600', upsert: true, contentType: avatarFile.type });
        if (upErr) throw upErr;
        const { data: pub } = supabase.storage.from('avatars').getPublicUrl(path);
        avatarUrl = pub?.publicUrl ?? null;
      }

      // Map artistic voice names to IDs (keep in sync with backend VOICE_MAP)
      const VOICE_MAP: Record<string, string> = {
        'Aria Velvet': 'wrxvN1LZJIfL3HHvffqe',
        'Nova Azure': 'EXAVITQu4vr4xnSDxMaL',
        'Mira Whisper': '21m00Tcm4TlvDq8ikWAM',
        'Zara Ember': '4tRn1lSkEn13EVTuqb0g',
        'Luna Aurora': 'gE0owC0H9C8SzfDyIUtB',
      };

      const { error: insErr } = await supabase.from('characters').insert({
        name,
        description: shortDescription,
        avatar_url: avatarUrl,
        system_prompt: systemPrompt,
        voice_id: VOICE_MAP[voiceKey] || null,
      });
      if (insErr) throw insErr;
      navigate('/characters');
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(false);
    }
  };

  return (
    <section className="mx-auto max-w-2xl rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur">
      <h2 className="mb-4 text-2xl font-semibold text-white">Create Character</h2>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      <form onSubmit={handleSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">Name</label>
          <input
            className="w-full rounded border border-white/20 bg-white/5 px-3 py-2 text-white outline-none placeholder:text-gray-400 focus:border-pink-500"
            placeholder="Aria"
            value={name}
            onChange={(e) => setName(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">Short description (card)</label>
          <input
            className="w-full rounded border border-white/20 bg-white/5 px-3 py-2 text-white outline-none placeholder:text-gray-400 focus:border-pink-500"
            placeholder="Playful singer-songwriter"
            value={shortDescription}
            onChange={(e) => setShortDescription(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">System prompt (long)</label>
          <textarea
            className="min-h-[140px] w-full rounded border border-white/20 bg-white/5 px-3 py-2 text-white outline-none placeholder:text-gray-400 focus:border-pink-500"
            placeholder="You are Aria..."
            value={systemPrompt}
            onChange={(e) => setSystemPrompt(e.target.value)}
            required
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">Default Voice</label>
          <div className="relative">
            <select
              className="w-full appearance-none rounded border border-white/20 bg-black/40 px-3 py-2 pr-8 text-sm text-white outline-none focus:border-pink-500"
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
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">Avatar (optional)</label>
          <input
            type="file"
            accept="image/*"
            onChange={(e) => setAvatarFile(e.target.files?.[0] ?? null)}
            className="block w-full text-sm text-gray-300 file:mr-4 file:rounded-full file:border-0 file:bg-white/10 file:px-4 file:py-2 file:text-white hover:file:bg-white/20"
          />
        </div>
        <div className="pt-2">
          <button
            type="submit"
            disabled={loading}
            className="rounded-full bg-gradient-to-r from-pink-500 to-purple-600 px-5 py-2 text-white shadow disabled:opacity-50"
          >
            {loading ? 'Creating…' : 'Create Character'}
          </button>
        </div>
      </form>
    </section>
  );
}


