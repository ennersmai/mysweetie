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
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 md:grid-cols-3">
        {characters.map((c) => (
          <Link key={c.id} to={`/chat/${c.id}`} className="group relative overflow-visible rounded-xl border border-white/10 bg-white/5 p-4 transition hover:bg-white/10">
            <div className="flex items-center gap-4">
              <div className="relative">
                {c.avatar_url ? (
                  <>
                    <img src={c.avatar_url} alt={c.name} className="h-24 w-32 rounded-lg object-cover ring-2 ring-pink-500/40" />
                    <img
                      src={c.avatar_url}
                      alt={c.name}
                      className="pointer-events-none absolute -top-6 left-20 hidden h-44 w-56 rounded-2xl object-cover ring-2 ring-pink-500/40 opacity-0 shadow-2xl transition duration-200 group-hover:opacity-100 sm:block z-20"
                    />
                  </>
                ) : (
                  <>
                    <div className="h-24 w-32 rounded-lg bg-gradient-to-br from-pink-400 to-purple-600 ring-2 ring-pink-500/40" />
                    <div className="pointer-events-none absolute -top-6 left-20 hidden h-44 w-56 rounded-2xl bg-gradient-to-br from-pink-400 to-purple-600 opacity-0 ring-2 ring-pink-500/40 shadow-2xl transition duration-200 group-hover:opacity-100 sm:block z-20" />
                  </>
                )}
              </div>
              <div>
                <div className="font-medium text-white">{c.name}</div>
                {c.description && <div className="text-sm text-gray-300 line-clamp-2">{c.description}</div>}
              </div>
            </div>
          </Link>
        ))}
      </div>
    </section>
  );
}


