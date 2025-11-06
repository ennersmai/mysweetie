import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { supabase } from '../lib/supabaseClient';
import { apiClient } from '../lib/apiClient';

type Profile = {
  display_name: string | null;
  is_premium: boolean;
  subscription_id: string | null;
  plan_tier?: string | null;
  nsfw_enabled?: boolean;
  voice_credits?: number;
  welcome_credits?: number;
  text_messages_today?: number;
  last_text_reset_date?: string | null;
};

export default function Account() {
  const { user, signOut } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [purchasingCredits, setPurchasingCredits] = useState(false);
  const [userMemoryInput, setUserMemoryInput] = useState('');
  const [savingMemory, setSavingMemory] = useState(false);

  useEffect(() => {
    const load = async () => {
      if (!user) {
        setLoading(false);
        return;
      }
      let { data, error } = await supabase
        .from('profiles')
        .select('display_name, is_premium, subscription_id, plan_tier, nsfw_enabled, voice_credits, welcome_credits, text_messages_today, last_text_reset_date')
        .eq('id', user.id)
        .maybeSingle();
      if (!data && !error) {
        // Create a profile row if missing with welcome credits
        const { error: insErr } = await supabase
          .from('profiles')
          .insert({ id: user.id, welcome_credits: 20 })
          .single();
        if (!insErr) {
          const refetch = await supabase
            .from('profiles')
            .select('display_name, is_premium, subscription_id, plan_tier, nsfw_enabled, voice_credits, welcome_credits, text_messages_today, last_text_reset_date')
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

  const purchaseVoiceCredits = async () => {
    setPurchasingCredits(true);
    setError(null);
    try {
      const res = await apiClient.post('/stripe/create-checkout-session', { 
        tier: 'voice_credits' 
      });
      
      if (!res.ok) {
        const errorData = await res.json();
        if (res.status === 503) {
          throw new Error('Payment system not available in development mode');
        }
        throw new Error(errorData?.error || 'Checkout error');
      }
      
      const json = await res.json();
      if (json.url) {
        window.location.href = json.url as string;
      } else {
        throw new Error('No checkout URL received');
      }
    } catch (e: any) {
      setError(e.message || String(e));
      console.error('Voice credits purchase error:', e);
    } finally {
      setPurchasingCredits(false);
    }
  };

  if (!user) {
    return (
      <section className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl backdrop-blur">
        <h2 className="mb-4 text-xl font-semibold text-white">Account</h2>
        <p className="text-gray-300">You are not signed in.</p>
      </section>
    );
  }

  return (
    <section className="mx-auto max-w-3xl rounded-2xl border border-white/10 bg-white/5 p-8 shadow-xl backdrop-blur">
      <h2 className="mb-6 text-2xl font-semibold text-white">Your Account</h2>
      {loading && <p className="text-gray-300">Loading…</p>}
      {error && <p className="mb-4 rounded-lg bg-red-500/10 border border-red-500/20 p-3 text-sm text-red-400">{error}</p>}
      {profile && (
        <div className="space-y-6">
          {/* Profile Section */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-6">
            <h3 className="mb-4 text-lg font-semibold text-white">Profile Information</h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <span className="text-sm text-white/70">Email</span>
                <span className="text-sm text-white">{user.email}</span>
              </div>
              
              <div className="border-t border-white/10 pt-4">
                <form
                  onSubmit={async (e: FormEvent) => {
                    e.preventDefault();
                    try {
                      setSaving(true);
                      setError(null);
                      const res = await apiClient.put('/user/profile', { display_name: displayNameInput });
                      if (!res.ok) {
                        const errorData = await res.json();
                        throw new Error(errorData?.error || 'Failed to update persona');
                      }
                      setProfile((p) => (p ? { ...p, display_name: displayNameInput } : p));
                    } catch (e: any) {
                      setError(e.message || String(e));
                    } finally {
                      setSaving(false);
                    }
                  }}
                  className="space-y-2"
                >
                  <label className="block text-sm font-medium text-white/90">
                    Persona Name
                    <span className="block text-xs font-normal text-white/50 mt-1">The AI will use this name when talking to you</span>
                  </label>
                  <div className="flex gap-2">
                    <input
                      className="flex-1 rounded-lg border border-white/20 bg-white/5 px-4 py-2 text-sm text-white outline-none focus:border-pink-500 focus:ring-2 focus:ring-pink-500/20"
                      value={displayNameInput}
                      onChange={(e) => setDisplayNameInput(e.target.value)}
                      maxLength={64}
                      placeholder="Your name"
                    />
                    <button 
                      disabled={saving} 
                      className="rounded-lg bg-gradient-to-r from-pink-500 to-purple-600 px-6 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50 transition"
                    >
                      {saving ? 'Saving...' : 'Save'}
                    </button>
                  </div>
                </form>
              </div>
            </div>
          </div>

          {/* User Memory Section */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-6">
            <h3 className="mb-4 text-lg font-semibold text-white">What do you want the AI to remember you with?</h3>
            <div className="space-y-4">
              <p className="text-sm text-white/70">
                Add basic information about yourself that the AI characters will remember. This helps them understand who you are and create more personalized conversations.
              </p>
              <form
                onSubmit={async (e: FormEvent) => {
                  e.preventDefault();
                  if (!userMemoryInput.trim()) return;
                  try {
                    setSavingMemory(true);
                    setError(null);
                    const res = await apiClient.post('/memories', {
                      characterId: 'system', // Use a special system character for user memories
                      memoryText: userMemoryInput.trim(),
                      role: 'user'
                    });
                    if (!res.ok) {
                      const errorData = await res.json();
                      throw new Error(errorData?.error || 'Failed to save memory');
                    }
                    setUserMemoryInput('');
                    // Show success feedback
                    setError(null);
                  } catch (e: any) {
                    setError(e.message || String(e));
                  } finally {
                    setSavingMemory(false);
                  }
                }}
                className="space-y-3"
              >
                <textarea
                  className="w-full rounded-lg border border-white/20 bg-white/5 px-4 py-3 text-sm text-white outline-none focus:border-pink-500 focus:ring-2 focus:ring-pink-500/20 resize-none"
                  value={userMemoryInput}
                  onChange={(e) => setUserMemoryInput(e.target.value)}
                  placeholder="e.g., I'm a college student studying computer science. I love anime and video games. I'm usually pretty confident but can be shy around new people..."
                  rows={4}
                  maxLength={500}
                />
                <div className="flex items-center justify-between">
                  <span className="text-xs text-white/50">{userMemoryInput.length}/500 characters</span>
                  <button 
                    disabled={savingMemory || !userMemoryInput.trim()} 
                    className="rounded-lg bg-gradient-to-r from-blue-500 to-cyan-600 px-6 py-2 text-sm font-medium text-white hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition"
                  >
                    {savingMemory ? 'Saving...' : 'Save Memory'}
                  </button>
                </div>
              </form>
              <div className="text-xs text-white/50">
                <p>💡 <strong>Tips:</strong> Include your personality, interests, background, or how you'd like characters to see you.</p>
              </div>
            </div>
          </div>

          {/* Subscription Section */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-6">
            <h3 className="mb-4 text-lg font-semibold text-white">Subscription</h3>
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <span className="text-sm text-white/70">Plan</span>
                <span className="text-sm font-medium text-white">{profile.plan_tier ?? (profile.is_premium ? 'basic' : 'free')}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-white/70">Status</span>
                <span className={`text-sm font-medium ${profile.is_premium ? 'text-green-400' : 'text-white/70'}`}>
                  {profile.is_premium ? 'Active' : 'Free'}
                </span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-white/70">Welcome Credits</span>
                <span className="text-sm font-medium text-white">{profile.welcome_credits ?? 0}</span>
              </div>
              <div className="flex items-center justify-between">
                <span className="text-sm text-white/70">Voice Credits</span>
                <span className="text-sm font-medium text-white">{profile.voice_credits ?? 0}</span>
              </div>
              {profile.welcome_credits !== undefined && profile.welcome_credits <= 0 && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white/70">Text Messages Today</span>
                  <span className="text-sm font-medium text-white">{profile.text_messages_today ?? 0}/20</span>
                </div>
              )}
              {profile.subscription_id && (
                <div className="flex items-center justify-between">
                  <span className="text-sm text-white/70">Subscription ID</span>
                  <span className="text-xs text-white/50 font-mono">{profile.subscription_id}</span>
                </div>
              )}
            </div>
            <div className="border-t border-white/10 pt-4 mt-4">
              {profile.is_premium ? (
                <button
                  onClick={async () => {
                    try {
                      const res = await apiClient.post('/stripe/create-portal-session', {});
                      if (res.ok) {
                        const json = await res.json();
                        if (json?.url) window.location.href = json.url as string;
                      } else if (res.status === 503) {
                        setError('Payment system not available in development mode');
                      } else {
                        const errorData = await res.json();
                        setError(errorData?.error || 'Failed to create portal session');
                      }
                    } catch (error: any) {
                      setError('Failed to access subscription management');
                      console.error('Portal session error:', error);
                    }
                  }}
                  className="w-full rounded-lg border border-white/20 px-4 py-2 text-white/90 hover:bg-white/10 transition"
                >
                  Manage Subscription
                </button>
              ) : (
                <a 
                  href="/subscribe" 
                  className="block text-center rounded-lg bg-gradient-to-r from-pink-500 to-purple-600 px-4 py-2 text-white shadow hover:brightness-110 transition"
                >
                  Upgrade to Premium
                </a>
              )}
            </div>
          </div>

          {/* Welcome Credits Section */}
          {(profile.welcome_credits ?? 0) > 0 && (
            <div className="rounded-xl border border-white/10 bg-white/5 p-6">
              <h3 className="mb-4 text-lg font-semibold text-white">Welcome Credits</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-white/90">Remaining</p>
                    <p className="text-xs text-white/50 mt-1">One-time starter pack for new users</p>
                  </div>
                  <span className="text-2xl font-bold bg-gradient-to-r from-pink-500 to-purple-600 bg-clip-text text-transparent">
                    {profile.welcome_credits ?? 0}
                  </span>
                </div>
                <p className="text-xs text-white/50">
                  Welcome credits are shared between voice and text messages. Once used up, voice access stops and text moves to a free tier with daily limits.
                </p>
              </div>
            </div>
          )}

          {/* Voice Credits Section */}
          <div className="rounded-xl border border-white/10 bg-white/5 p-6">
            <h3 className="mb-4 text-lg font-semibold text-white">Voice Credits</h3>
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <p className="text-sm text-white/90">Current Balance</p>
                  <p className="text-xs text-white/50 mt-1">Each voice message uses 1 credit</p>
                </div>
                <span className="text-2xl font-bold bg-gradient-to-r from-pink-500 to-purple-600 bg-clip-text text-transparent">
                  {profile.voice_credits ?? 0}
                </span>
              </div>
              <div className="border-t border-white/10 pt-4">
                <button
                  onClick={purchaseVoiceCredits}
                  disabled={purchasingCredits}
                  className="w-full rounded-lg bg-gradient-to-r from-green-500 to-emerald-600 px-4 py-3 text-white shadow-lg hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed transition font-medium"
                >
                  {purchasingCredits ? 'Processing...' : 'Buy 200 Credits for $9.99'}
                </button>
                <p className="mt-3 text-xs text-center text-white/50">
                  Perfect for extra voice messages beyond your plan limits
                </p>
              </div>
            </div>
          </div>

          {/* Text Message Status */}
          {(profile.welcome_credits ?? 0) <= 0 && (
            <div className="rounded-xl border border-white/10 bg-white/5 p-6">
              <h3 className="mb-4 text-lg font-semibold text-white">Text Messages</h3>
              <div className="space-y-4">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm text-white/90">Daily Usage</p>
                    <p className="text-xs text-white/50 mt-1">Free tier limit: 20 messages per day</p>
                  </div>
                  <span className="text-2xl font-bold bg-gradient-to-r from-blue-500 to-cyan-600 bg-clip-text text-transparent">
                    {profile.text_messages_today ?? 0}/20
                  </span>
                </div>
                <p className="text-xs text-white/50">
                  After welcome credits are used, text messages are limited to 20 per day. Upgrade for unlimited messaging!
                </p>
                <div className="border-t border-white/10 pt-4">
                  <a 
                    href="/subscribe" 
                    className="block text-center rounded-lg bg-gradient-to-r from-pink-500 to-purple-600 px-4 py-3 text-white shadow-lg hover:brightness-110 transition font-medium"
                  >
                    Upgrade for Unlimited
                  </a>
                </div>
              </div>
            </div>
          )}
        </div>
      )}
      <div className="mt-6">
        <button onClick={() => signOut()} className="rounded-full border border-white/20 px-4 py-2 text-white/90 hover:bg-white/10">Sign out</button>
      </div>
    </section>
  );
}


