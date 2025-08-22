import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { Link } from 'react-router-dom';

type Character = {
  id: string;
  name: string;
  description: string | null;
  avatar_url: string | null;
};

export default function Characters() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const load = async () => {
      const { data, error } = await supabase
        .from('characters')
        .select('id, name, description, avatar_url')
        .order('created_at', { ascending: true });
      if (error) setError(error.message);
      setCharacters(data ?? []);
      setLoading(false);
    };
    load();
  }, []);

  return (
    <section className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-semibold text-white">Choose Your Companion</h2>
        <Link to="/characters/new" className="rounded-full bg-gradient-to-r from-pink-500 to-purple-600 px-3 py-1 text-sm text-white shadow">New Character</Link>
      </div>
      {loading && <p className="text-gray-300">Loading…</p>}
      {error && <p className="text-red-400">{error}</p>}
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6">
        {characters.map((c) => (
          <div key={c.id} className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/5 shadow-lg transition hover:bg-white/10 hover:shadow-xl">
            <div className="flex flex-col">
              {/* Character Image Container */}
              <div className="relative overflow-hidden bg-white/5 p-2">
                {c.avatar_url ? (
                  <img 
                    src={c.avatar_url} 
                    alt={c.name} 
                    className="w-full aspect-[3/4] object-contain rounded-lg ring-2 ring-pink-500/40" 
                  />
                ) : (
                  <div className="w-full aspect-[3/4] rounded-lg bg-gradient-to-br from-pink-400 to-purple-600 ring-2 ring-pink-500/40" />
                )}
              </div>
              
              {/* Character Info */}
              <div className="p-3 flex flex-col">
                <h3 className="font-medium text-white text-sm mb-2 text-center line-clamp-1">{c.name}</h3>
                {c.description && (
                  <p className="text-xs text-gray-300 line-clamp-2 leading-relaxed text-center mb-3">
                    {c.description}
                  </p>
                )}
                
                {/* Chat Button */}
                <Link 
                  to={`/chat/${c.id}`} 
                  className="w-full rounded-lg bg-gradient-to-r from-pink-500 to-purple-600 px-3 py-2 text-white text-sm font-medium shadow transition hover:brightness-110 text-center"
                >
                  Chat
                </Link>
              </div>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}


