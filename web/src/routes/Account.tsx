import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { authFetch } from '../lib/functionsClient';

type Profile = {
  display_name: string | null;
  is_premium: boolean;
  subscription_id: string | null;
  plan_tier?: string | null;
};

type Conversation = {
  id: string;
  title: string;
  updated_at: string;
  character: {
    id: string;
    name: string;
    avatar_url: string | null;
  };
};

export default function Account() {
  const { user, signOut } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [conversationsLoading, setConversationsLoading] = useState(false);

  useEffect(() => {
    const load = async () => {
      if (!user) {
        setLoading(false);
        return;
      }
      let { data, error } = await supabase
        .from('profiles')
        .select('display_name, is_premium, subscription_id, plan_tier')
        .eq('id', user.id)
        .maybeSingle();
      if (!data && !error) {
        // Create a profile row if missing
        const { error: insErr } = await supabase
          .from('profiles')
          .insert({ id: user.id })
          .single();
        if (!insErr) {
          const refetch = await supabase
            .from('profiles')
            .select('display_name, is_premium, subscription_id, plan_tier')
            .eq('id', user.id)
            .maybeSingle();
          data = refetch.data as any;
          error = refetch.error as any;
        }
      }
      if (error) setError(error.message);
      setProfile((data as any) ?? null);
      setDisplayNameInput((data as any)?.display_name ?? '');
      setLoading(false);
    };
    load();
  }, [user]);

  useEffect(() => {
    const loadConversations = async () => {
      if (!user) return;
      setConversationsLoading(true);
      try {
        const { data, error } = await supabase
          .from('conversations')
          .select(`
            id,
            title,
            updated_at,
            character:characters(id, name, avatar_url)
          `)
          .eq('user_id', user.id)
          .order('updated_at', { ascending: false })
          .limit(20);
        
        if (error) {
          console.error('Error loading conversations:', error);
          return;
        }
        
        setConversations((data || []) as any);
      } catch (err) {
        console.error('Failed to load conversations:', err);
      } finally {
        setConversationsLoading(false);
      }
    };

    loadConversations();
  }, [user]);

  if (!user) {
    return (
      <section className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur">
        <h2 className="mb-4 text-xl font-semibold text-white">Account</h2>
        <p className="text-gray-300">You are not signed in.</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-2xl rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur">
      <h2 className="mb-4 text-xl font-semibold text-white">Your Account</h2>
      {loading && <p className="text-gray-300">Loading…</p>}
      {error && <p className="text-red-400">{error}</p>}
      {profile && (
        <div className="space-y-3 text-white/90">
          <div className="text-sm">Email: {user.email}</div>
          <form
            onSubmit={async (e: FormEvent) => {
              e.preventDefault();
              try {
                setSaving(true);
                const res = await authFetch('/update-profile', { method: 'POST', body: JSON.stringify({ display_name: displayNameInput }) });
                const json = await res.json();
                if (!res.ok) throw new Error(json?.error || 'Failed to update');
                setProfile((p) => (p ? { ...p, display_name: displayNameInput } : p));
              } catch (e: any) {
                setError(e.message || String(e));
              } finally {
                setSaving(false);
              }
            }}
            className="flex items-center gap-2"
          >
            <label className="text-sm">Display name:</label>
            <input
              className="min-w-0 flex-1 rounded border border-white/20 bg-white/5 px-2 py-1 text-sm text-white outline-none focus:border-pink-500"
              value={displayNameInput}
              onChange={(e) => setDisplayNameInput(e.target.value)}
              maxLength={64}
            />
            <button disabled={saving} className="rounded bg-white/10 px-3 py-1 text-sm text-white hover:bg-white/15 disabled:opacity-50">Save</button>
          </form>
          <div className="text-sm">Status: {profile.is_premium ? 'Paid' : 'Free'}</div>
          <div className="text-sm">Plan tier: {profile.plan_tier ?? (profile.is_premium ? 'basic' : 'free')}</div>
          {profile.subscription_id && (
            <div className="text-sm text-white/70">Subscription ID: {profile.subscription_id}</div>
          )}
          <div className="pt-2">
            {profile.is_premium ? (
              <button
                onClick={async () => {
                  const res = await authFetch('/create-portal-session', { method: 'POST' });
                  const json = await res.json();
                  if (json?.url) window.location.href = json.url as string;
                }}
                className="rounded-full border border-white/20 px-4 py-2 text-white/90 hover:bg-white/10"
              >
                Manage Subscription
              </button>
            ) : (
              <a href="/subscribe" className="rounded-full bg-gradient-to-r from-pink-500 to-purple-600 px-4 py-2 text-white shadow">Upgrade</a>
            )}
          </div>
        </div>
      )}
      <div className="mt-6">
        <button onClick={() => signOut()} className="rounded-full border border-white/20 px-4 py-2 text-white/90 hover:bg-white/10">Sign out</button>
      </div>

      {/* Chat History Section */}
      <div className="mt-8">
        <h3 className="mb-4 text-lg font-semibold text-white">Recent Chats</h3>
        {conversationsLoading ? (
          <p className="text-gray-300">Loading conversations...</p>
        ) : conversations.length === 0 ? (
          <p className="text-gray-300">No conversations yet. <Link to="/characters" className="text-pink-400 hover:text-pink-300">Start chatting with a character!</Link></p>
        ) : (
          <div className="space-y-3">
            {conversations.map((conv) => (
              <Link
                key={conv.id}
                to={`/chat/${conv.character.id}/${conv.id}`}
                className="block rounded-lg border border-white/10 bg-white/5 p-4 transition hover:bg-white/10"
              >
                <div className="flex items-center gap-3">
                  {conv.character.avatar_url ? (
                    <img
                      src={conv.character.avatar_url}
                      alt={conv.character.name}
                      className="h-12 w-16 rounded-lg object-cover ring-2 ring-pink-500/30"
                    />
                  ) : (
                    <div className="h-12 w-16 rounded-lg bg-gradient-to-br from-pink-400 to-purple-600 ring-2 ring-pink-500/30" />
                  )}
                  <div className="flex-1">
                    <div className="flex items-center justify-between">
                      <h4 className="font-medium text-white">{conv.title}</h4>
                      <span className="text-xs text-gray-400">
                        {new Date(conv.updated_at).toLocaleDateString()}
                      </span>
                    </div>
                    <p className="text-sm text-gray-300">with {conv.character.name}</p>
                  </div>
                </div>
              </Link>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}


