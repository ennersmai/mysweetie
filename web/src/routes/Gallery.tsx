import { useEffect, useState, useMemo } from 'react';
import { authFetch } from '../lib/functionsClient';
import { supabase } from '../lib/supabaseClient';
import AnimatedSection from '../components/AnimatedSection';
import { useImagePrefetch } from '../hooks/useImagePrefetch';

type Item = { url: string | null; caption: string | null; is_preview: boolean };

export default function Gallery() {
  const [items, setItems] = useState<Item[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [isPremium, setIsPremium] = useState(false);
  const [characters, setCharacters] = useState<{ id: string; name: string; avatar_url: string | null; style?: 'realistic' | 'anime' }[]>([]);
  const [styleFilter, setStyleFilter] = useState<'realistic' | 'anime'>('realistic');
  const [lightboxUrl, setLightboxUrl] = useState<string | null>(null);
  const [lightboxCaption, setLightboxCaption] = useState<string | null>(null);
  const [selectedCharacterId, setSelectedCharacterId] = useState<string | null>(null);
  const [loadedImages, setLoadedImages] = useState<Set<string>>(new Set());

  // Extract image URLs for prefetching
  const imageUrls = useMemo(() => {
    return items
      .filter(item => item.url)
      .map(item => item.url!)
      .slice(0, 20); // Limit to first 20 images to avoid overwhelming the browser
  }, [items]);

  // Prefetch images
  const { isPrefetched } = useImagePrefetch(imageUrls, { priority: 'low' });

  // Handle image load
  const handleImageLoad = (url: string) => {
    setLoadedImages(prev => new Set([...prev, url]));
  };

  useEffect(() => {
    const load = async () => {
      try {
        const { data: u } = await supabase.auth.getUser();
        if (u.user) {
          const { data: p } = await supabase.from('profiles').select('is_premium').eq('id', u.user.id).maybeSingle();
          setIsPremium(Boolean(p?.is_premium));
        }
        const { data: chars } = await supabase
          .from('characters')
          .select('id, name, avatar_url, style')
          .neq('id', '00000000-0000-0000-0000-000000000000') // Exclude system character
          .order('created_at', { ascending: true });
        setCharacters(chars || []);
        const filtered = (chars || []).filter((c: any) => (c.style as any) ? c.style === styleFilter : styleFilter === 'realistic');
        if (filtered && filtered.length) {
          // Load gallery for the first character by default
          setSelectedCharacterId(filtered[0].id);
          const res = await authFetch(`/get-gallery?characterId=${filtered[0].id}`);
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
    <AnimatedSection className="p-6">
      <h2 className="mb-4 text-xl font-semibold text-white">Gallery</h2>
      {/* Style toggle */}
      <div className="mb-4 flex justify-center">
        <div className="inline-flex rounded-full border border-white/20 bg-white/5 p-1">
          <button
            type="button"
            className={`px-4 py-1.5 text-sm rounded-full transition ${styleFilter === 'realistic' ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white' : 'text-white/80 hover:bg-white/10'}`}
            onClick={async () => {
              setStyleFilter('realistic');
              const filtered = characters.filter(c => (c.style as any) ? c.style === 'realistic' : true);
              if (filtered.length) {
                setSelectedCharacterId(filtered[0].id);
                const res = await authFetch(`/get-gallery?characterId=${filtered[0].id}`);
                const json = await res.json();
                if (res.ok) setItems(json.items || []);
              } else {
                setSelectedCharacterId(null);
                setItems([]);
              }
            }}
          >
            Realistic
          </button>
          <button
            type="button"
            className={`px-4 py-1.5 text-sm rounded-full transition ${styleFilter === 'anime' ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white' : 'text-white/80 hover:bg-white/10'}`}
            onClick={async () => {
              setStyleFilter('anime');
              const filtered = characters.filter(c => (c.style as any) ? c.style === 'anime' : false);
              if (filtered.length) {
                setSelectedCharacterId(filtered[0].id);
                const res = await authFetch(`/get-gallery?characterId=${filtered[0].id}`);
                const json = await res.json();
                if (res.ok) setItems(json.items || []);
              } else {
                setSelectedCharacterId(null);
                setItems([]);
              }
            }}
          >
            Anime
          </button>
        </div>
      </div>
      
      {/* AI Disclaimer */}
      <div className="mb-6 p-3 rounded-lg bg-white/5 border border-white/10">
        <p className="text-sm text-gray-300 text-center italic">
          <strong>Disclaimer:</strong> All images are AI-generated and do not depict real people.
        </p>
      </div>
      
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      <div className="mb-6 grid grid-cols-2 gap-3 sm:grid-cols-3">
        {characters.filter(c => (c.style as any) ? c.style === styleFilter : styleFilter === 'realistic').map((c, i) => (
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
              <img 
                loading="lazy" 
                src={c.avatar_url} 
                alt={c.name} 
                className="w-16 aspect-[3/4] rounded-lg object-contain bg-white/5 ring-2 ring-pink-500/40 transition-opacity duration-300" 
              />
            ) : (
              <div className="w-16 aspect-[3/4] rounded-lg bg-gradient-to-br from-pink-400 to-purple-600 ring-2 ring-pink-500/40" />
            )}
            <div className="flex-1">
              <div className="font-medium text-white">{c.name}</div>
              {!isPremium && i >= 3 && <div className="text-xs text-yellow-300">Premium</div>}
            </div>
          </button>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4 xl:grid-cols-5">
        {items.map((it, i) => (
          <button
            key={i}
            type="button"
            className="overflow-hidden rounded-xl border border-white/10 bg-white/5 shadow-lg transition hover:bg-white/10 hover:shadow-xl focus:outline-none"
            onClick={() => {
              if (!it.url) return;
              setLightboxUrl(it.url);
              setLightboxCaption(it.caption ?? null);
            }}
            disabled={!it.url}
          >
            <div className="p-3">
              {it.url ? (
                <div className="relative w-full aspect-[3/4] bg-white/5 rounded-lg ring-2 ring-pink-500/40 overflow-hidden">
                  <img 
                    loading="lazy" 
                    src={it.url} 
                    className={`w-full h-full cursor-zoom-in object-contain transition-all duration-300 hover:brightness-110 ${
                      loadedImages.has(it.url) ? 'opacity-100' : 'opacity-0'
                    }`}
                    onLoad={(e) => {
                      handleImageLoad(it.url);
                      (e.target as HTMLImageElement).style.opacity = '1';
                    }}
                    onError={(e) => {
                      handleImageLoad(it.url); // Mark as "loaded" even on error to hide spinner
                      (e.target as HTMLImageElement).style.opacity = '0.5';
                    }}
                  />
                  {!loadedImages.has(it.url) && (
                    <div className="absolute inset-0 flex items-center justify-center bg-white/5 rounded-lg">
                      <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-pink-500"></div>
                    </div>
                  )}
                </div>
              ) : (
                <div className="flex w-full aspect-[3/4] items-center justify-center bg-white/10 rounded-lg text-xs text-white/70">Premium</div>
              )}
            </div>
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
          <div className="max-h-[70vh] max-w-[95vw]" onClick={(e) => e.stopPropagation()}>
            <img src={lightboxUrl} alt={lightboxCaption ?? ''} className="max-h-[70vh] max-w-[95vw] rounded-lg object-contain" />
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
    </AnimatedSection>
  );
}


