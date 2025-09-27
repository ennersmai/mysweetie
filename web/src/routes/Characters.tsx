import { useEffect, useState } from 'react';
import { supabase } from '../lib/supabaseClient';
import { Link } from 'react-router-dom';
import AnimatedSection from '../components/AnimatedSection';

type Character = {
  id: string;
  name: string;
  description: string | null;
  avatar_url: string | null;
  system_prompt: string | null;
};

export default function Characters() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedCharacter, setSelectedCharacter] = useState<Character | null>(null);

  useEffect(() => {
    const load = async () => {
      const { data, error } = await supabase
        .from('characters')
        .select('id, name, description, avatar_url, system_prompt')
        .order('created_at', { ascending: true });
      if (error) setError(error.message);
      setCharacters(data ?? []);
      setLoading(false);
    };
    load();
  }, []);

  return (
    <AnimatedSection className="p-6 max-w-none">
      <div className="mb-6 flex items-center justify-between">
        <h2 className="text-2xl font-semibold text-white">Choose Your Companion</h2>
        <Link to="/characters/new" className="rounded-full bg-gradient-to-r from-pink-500 to-purple-600 px-3 py-1 text-sm text-white shadow">New Character</Link>
      </div>
      {loading && <p className="text-gray-300">Loading…</p>}
      {error && <p className="text-red-400">{error}</p>}
      <div className="grid grid-cols-1 gap-6 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 mb-20">
        {characters.map((c) => (
          <div key={c.id} className="group relative overflow-hidden rounded-xl border border-white/10 bg-white/5 shadow-lg transition hover:bg-white/10 hover:shadow-xl">
            <div className="flex flex-col">
              {/* Character Image Container */}
              <div className="relative overflow-hidden bg-white/5 p-4">
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
              <div className="p-4 flex flex-col">
                <h3 className="font-semibold text-white text-lg mb-3 text-center">{c.name}</h3>
                
                {/* AI Disclaimer */}
                <p className="text-xs text-gray-400 text-center mb-3 italic">
                  AI-generated character. Not a real person.
                </p>
                
                {c.description && (
                  <div 
                    className="text-sm text-gray-300 line-clamp-4 leading-relaxed text-center mb-4 cursor-pointer hover:text-white transition-colors relative group"
                    onClick={() => setSelectedCharacter(c)}
                    title="Click to see personality & system prompt"
                  >
                    {c.description}
                    <div className="absolute inset-0 bg-transparent group-hover:bg-white/5 rounded transition-colors"></div>
                  </div>
                )}
                
                {/* Chat Button */}
                <Link 
                  to={`/chat/${c.id}`} 
                  className="w-full rounded-lg bg-gradient-to-r from-pink-500 to-purple-600 px-4 py-3 text-white font-medium shadow transition hover:brightness-110 text-center"
                >
                  Chat
                </Link>
              </div>
            </div>
          </div>
        ))}
      </div>

      {/* Character Description Modal */}
      {selectedCharacter && (
        <div 
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4"
          onClick={() => setSelectedCharacter(null)}
        >
          <div 
            className="max-w-2xl w-full max-h-[80vh] overflow-y-auto rounded-2xl border border-white/10 bg-white/5 backdrop-blur-lg"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-6">
              {/* Header */}
              <div className="mb-6 flex items-start gap-4">
                {selectedCharacter.avatar_url ? (
                  <img 
                    src={selectedCharacter.avatar_url} 
                    alt={selectedCharacter.name} 
                    className="w-20 aspect-[3/4] rounded-lg object-contain ring-2 ring-pink-500/40 bg-white/5 flex-shrink-0" 
                  />
                ) : (
                  <div className="w-20 aspect-[3/4] rounded-lg bg-gradient-to-br from-pink-400 to-purple-600 ring-2 ring-pink-500/40 flex-shrink-0" />
                )}
                <div className="flex-1">
                  <h3 className="text-2xl font-semibold text-white mb-2">{selectedCharacter.name}</h3>
                  <button
                    onClick={() => setSelectedCharacter(null)}
                    className="text-gray-400 hover:text-white transition-colors text-sm"
                  >
                    ✕ Close
                  </button>
                </div>
              </div>

              {/* Short Description */}
              {selectedCharacter.description && (
                <div className="mb-6">
                  <h4 className="text-lg font-medium text-white mb-3">Description</h4>
                  <p className="text-gray-300 leading-relaxed whitespace-pre-wrap">
                    {selectedCharacter.description}
                  </p>
                </div>
              )}

              {/* System Prompt */}
              {selectedCharacter.system_prompt && (
                <div className="mb-6">
                  <h4 className="text-lg font-medium text-white mb-3">Personality & Behavior</h4>
                  <div className="bg-white/5 rounded-lg p-4 border border-white/10">
                    <p className="text-gray-300 leading-relaxed whitespace-pre-wrap text-sm">
                      {selectedCharacter.system_prompt}
                    </p>
                  </div>
                </div>
              )}

              {/* Action Buttons */}
              <div className="flex gap-3">
                <Link 
                  to={`/chat/${selectedCharacter.id}`} 
                  className="flex-1 rounded-lg bg-gradient-to-r from-pink-500 to-purple-600 px-6 py-3 text-white font-medium shadow transition hover:brightness-110 text-center"
                >
                  Start Chat
                </Link>
                <button
                  onClick={() => setSelectedCharacter(null)}
                  className="px-6 py-3 rounded-lg border border-white/20 text-white hover:bg-white/10 transition-colors"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </AnimatedSection>
  );
}


