import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import { useAuth } from '../contexts/AuthContext';

// Default voices for each style
const REALISTIC_VOICES = ['layla', 'ava', 'mia', 'emma', 'aria', 'natalia'];
const ANIME_VOICES = ['star', 'natsuki', 'mary', 'lana', 'clover', 'chloe'];
const GENERAL_VOICES = ['whisper', 'celeste', 'aurora', 'luna'];

export default function NewCharacter() {
  const navigate = useNavigate();
  const { user } = useAuth();

  const [name, setName] = useState('');
  const [shortDescription, setShortDescription] = useState('');
  const [systemPrompt, setSystemPrompt] = useState('');
  const [voiceKey, setVoiceKey] = useState('layla'); // Default to first realistic voice
  const [avatarFile, setAvatarFile] = useState<File | null>(null);
  const [style, setStyle] = useState<'realistic' | 'anime'>('realistic');
  const [galleryFiles, setGalleryFiles] = useState<FileList | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Update default voice when style changes
  useEffect(() => {
    if (style === 'realistic') {
      setVoiceKey(REALISTIC_VOICES[0]);
    } else {
      setVoiceKey(ANIME_VOICES[0]);
    }
  }, [style]);

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

      const { data: inserted, error: insErr } = await supabase.from('characters').insert({
        name,
        description: shortDescription,
        avatar_url: avatarUrl,
        system_prompt: systemPrompt,
        voice_id: voiceKey || 'luna',
        style,
      }).select('id').single();
      if (insErr) throw insErr;

      // Optional gallery uploads
      if (inserted?.id && galleryFiles && galleryFiles.length > 0) {
        for (let i = 0; i < galleryFiles.length; i++) {
          const file = galleryFiles[i];
          const ext = file.name.split('.').pop() || 'jpg';
          const path = `galleries/${crypto.randomUUID()}.${ext}`;
          const { error: upErr } = await supabase.storage.from('galleries').upload(path, file, { cacheControl: '3600', upsert: false });
          if (upErr) continue;
          await supabase.from('character_galleries').insert({ character_id: inserted.id, image_path: path, caption: null, is_preview: false });
        }
      }
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
        {/* Style selector */}
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">Style</label>
          <div className="inline-flex rounded-full border border-white/20 bg-white/5 p-1">
            <button type="button" className={`px-4 py-1.5 text-sm rounded-full transition ${style === 'realistic' ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white' : 'text-white/80 hover:bg-white/10'}`} onClick={() => setStyle('realistic')}>Realistic</button>
            <button type="button" className={`px-4 py-1.5 text-sm rounded-full transition ${style === 'anime' ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white' : 'text-white/80 hover:bg-white/10'}`} onClick={() => setStyle('anime')}>Anime</button>
          </div>
        </div>
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
              {style === 'realistic' && (
                <>
                  <optgroup label="Realistic Character Voices">
                    {REALISTIC_VOICES.map((v) => (
                      <option key={v} className="bg-gray-900 text-white" value={v}>
                        {v.charAt(0).toUpperCase() + v.slice(1)}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="General Voices">
                    {GENERAL_VOICES.map((v) => (
                      <option key={v} className="bg-gray-900 text-white" value={v}>
                        {v.charAt(0).toUpperCase() + v.slice(1)}
                      </option>
                    ))}
                  </optgroup>
                </>
              )}
              {style === 'anime' && (
                <>
                  <optgroup label="Anime Character Voices">
                    {ANIME_VOICES.map((v) => (
                      <option key={v} className="bg-gray-900 text-white" value={v}>
                        {v.charAt(0).toUpperCase() + v.slice(1)}
                      </option>
                    ))}
                  </optgroup>
                  <optgroup label="General Voices">
                    {GENERAL_VOICES.map((v) => (
                      <option key={v} className="bg-gray-900 text-white" value={v}>
                        {v.charAt(0).toUpperCase() + v.slice(1)}
                      </option>
                    ))}
                  </optgroup>
                </>
              )}
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
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">Gallery images (optional)</label>
          <input
            type="file"
            accept="image/*"
            multiple
            onChange={(e) => setGalleryFiles(e.target.files)}
            className="block w-full text-sm text-gray-300 file:mr-4 file:rounded-full file:border-0 file:bg-white/10 file:px-4 file:py-2 file:text-white hover:file:bg-white/20"
          />
          <p className="text-xs text-gray-400 mt-1">You can upload multiple images. They will appear in the character's gallery.</p>
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


