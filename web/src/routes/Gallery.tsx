import { useEffect, useState } from 'react';
import { authFetch } from '../lib/functionsClient';
import { supabase } from '../lib/supabaseClient';

type Item = { url: string | null; caption: string | null; is_preview: boolean };

export default function Gallery() {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPremium, setIsPremium] = useState(false);
  const [characters, setCharacters] = useState<{ id: string; name: string; avatar_url: string | null }[]>([]);
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [lightboxCaption, setLightboxCaption] = useState<string | null>(null);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      try {
        const { data: u } = await supabase.auth.getUser();
        if (u.user) {
          const { data: p } = await supabase.from('profiles').select('is_premium').eq('id', u.user.id).maybeSingle();
          setIsPremium(Boolean(p?.is_premium));
        }
        const { data: chars } = await supabase.from('characters').select('id, name, avatar_url').order('created_at', { ascending: true });
        setCharacters(chars || []);
        if (chars && chars.length) {
          // Load gallery for the first character by default
          setSelectedCharacterId(chars[0].id);
          const res = await authFetch(`/get-gallery?characterId=${chars[0].id}`);
          const json = await res.json();
          if (!res.ok) throw new Error(json?.error || 'Error');
          setItems(json.items || []);
        }
      } catch (e: any) {
        setError(e.message || String(e));
      }
    };
    load();
  }, []);

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur">
      <h2 className="mb-4 text-xl font-semibold text-white">Gallery</h2>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {characters.map((c, i) => (
          <button
            key={c.id}
            type="button"
            onClick={async () => {
              try {
                setSelectedCharacterId(c.id);
                const res = await authFetch(`/get-gallery?characterId=${c.id}`);
                const json = await res.json();
                if (!res.ok) throw new Error(json?.error || 'Error');
                setItems(json.items || []);
              } catch (e: any) {
                setError(e.message || String(e));
              }
            }}
            className={`flex items-center gap-3 rounded-xl border bg-white/5 p-3 text-left transition hover:bg-white/10 ${
              selectedCharacterId === c.id ? 'border-pink-500/50' : 'border-white/10'
            }`}
          >
            {c.avatar_url ? (
              <img src={c.avatar_url} alt={c.name} className="h-16 w-16 rounded-full object-cover" />
            ) : (
              <div className="h-16 w-16 rounded-full bg-gradient-to-br from-pink-400 to-purple-600" />
            )}
            <div className="flex-1">
              <div className="font-medium text-white">{c.name}</div>
              {!isPremium && i >= 3 && <div className="text-xs text-yellow-300">Premium</div>}
            </div>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 md:grid-cols-4">
        {items.map((it, i) => (
          <button
            key={i}
            type="button"
            className="overflow-hidden rounded border border-white/10 focus:outline-none"
            onClick={() => {
              if (!it.url) return;
              setLightboxUrl(it.url);
              setLightboxCaption(it.caption ?? null);
            }}
            disabled={!it.url}
          >
            {it.url ? (
              <img src={it.url} className="h-40 w-full cursor-zoom-in object-cover transition hover:brightness-110" />
            ) : (
              <div className="flex h-40 w-full items-center justify-center bg-white/10 text-xs text-white/70">Premium</div>
            )}
          </button>
        ))}
      </div>

      {lightboxUrl && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => {
            setLightboxUrl(null);
            setLightboxCaption(null);
          }}
        >
          <div className="max-h-[90vh] max-w-[95vw]" onClick={(e) => e.stopPropagation()}>
            <img src={lightboxUrl} alt={lightboxCaption ?? ''} className="max-h-[90vh] max-w-[95vw] rounded-lg object-contain" />
            {lightboxCaption && (
              <div className="mt-2 text-center text-sm text-white/80">{lightboxCaption}</div>
            )}
            <div className="mt-3 flex justify-center">
              <button
                type="button"
                className="rounded-full bg-white/10 px-4 py-1 text-sm text-white hover:bg-white/15"
                onClick={() => {
                  setLightboxUrl(null);
                  setLightboxCaption(null);
                }}
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}
    </section>
  );
}


