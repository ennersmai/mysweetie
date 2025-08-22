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
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3">
        {characters.map((c) => (
          <div key={c.id} className="group relative overflow-visible rounded-xl border border-white/10 bg-white/5 p-4 transition hover:bg-white/10">
            <div className="flex flex-col items-center text-center">
              {/* Character Image */}
              <div className="mb-4 relative">
                {c.avatar_url ? (
                  <img 
                    src={c.avatar_url} 
                    alt={c.name} 
                    className="h-48 w-48 rounded-lg object-contain ring-2 ring-pink-500/40 bg-white/5" 
                  />
                ) : (
                  <div className="h-48 w-48 rounded-lg bg-gradient-to-br from-pink-400 to-purple-600 ring-2 ring-pink-500/40" />
                )}
              </div>
              
              {/* Character Info */}
              <div className="mb-4 w-full">
                <div className="font-medium text-white text-lg mb-2">{c.name}</div>
                {c.description && (
                  <div className="text-sm text-gray-300 line-clamp-3 leading-relaxed">
                    {c.description}
                  </div>
                )}
              </div>
              
              {/* Chat Button */}
              <Link 
                to={`/chat/${c.id}`} 
                className="w-full rounded-lg bg-gradient-to-r from-pink-500 to-purple-600 px-4 py-3 text-white font-medium shadow transition hover:brightness-110 text-center"
              >
                Chat
              </Link>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}


