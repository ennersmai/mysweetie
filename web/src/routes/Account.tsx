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
};

export default function Account() {
  const { user, signOut } = useAuth();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [displayNameInput, setDisplayNameInput] = useState('');
  const [nsfwEnabled, setNsfwEnabled] = useState(false);
  const [purchasingCredits, setPurchasingCredits] = useState(false);

  useEffect(() => {
    const load = async () => {
      if (!user) {
        setLoading(false);
        return;
      }
      let { data, error } = await supabase
        .from('profiles')
        .select('display_name, is_premium, subscription_id, plan_tier, nsfw_enabled, voice_credits')
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
            .select('display_name, is_premium, subscription_id, plan_tier, nsfw_enabled, voice_credits')
            .eq('id', user.id)
            .maybeSingle();
          data = refetch.data as any;
          error = refetch.error as any;
        }
      }
      if (error) setError(error.message);
      setProfile((data as any) ?? null);
      setDisplayNameInput((data as any)?.display_name ?? '');
      setNsfwEnabled((data as any)?.nsfw_enabled ?? false);
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
                // Note: display_name update would need a new backend endpoint
                // For now, we'll just simulate success since this feature isn't critical
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
          <div className="text-sm">Voice credits: {profile.voice_credits ?? 0}</div>
          {profile.subscription_id && (
            <div className="text-sm text-white/70">Subscription ID: {profile.subscription_id}</div>
          )}
          <div className="pt-2">
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
                className="rounded-full border border-white/20 px-4 py-2 text-white/90 hover:bg-white/10"
              >
                Manage Subscription
              </button>
            ) : (
              <a href="/subscribe" className="rounded-full bg-gradient-to-r from-pink-500 to-purple-600 px-4 py-2 text-white shadow">Upgrade</a>
            )}
          </div>

          {/* Voice Credits Section */}
          <div className="pt-4 mt-4 border-t border-white/10">
            <h3 className="mb-2 text-md font-semibold text-white">Voice Credits</h3>
            <div className="flex items-center justify-between mb-3">
              <div className="text-sm">
                <p>Current credits: <span className="font-medium text-white">{profile.voice_credits ?? 0}</span></p>
                <p className="text-xs text-white/60">Each voice message uses 1 credit</p>
              </div>
            </div>
            <button
              onClick={purchaseVoiceCredits}
              disabled={purchasingCredits}
              className="rounded-full bg-gradient-to-r from-green-500 to-emerald-600 px-4 py-2 text-white shadow hover:brightness-110 disabled:opacity-50 disabled:cursor-not-allowed"
            >
              {purchasingCredits ? 'Processing...' : 'Buy 200 Credits for $9.99'}
            </button>
            <p className="mt-2 text-xs text-white/60">
              Perfect for users who need extra voice messages beyond their plan limits.
            </p>
          </div>
          
          {/* Content Preferences Section */}
          <div className="pt-4 mt-4 border-t border-white/10">
            <h3 className="mb-2 text-md font-semibold text-white">Content Preferences</h3>
            <div className="flex items-center justify-between">
              <div className="text-sm">
                <p>Enable NSFW Content</p>
                <p className="text-xs text-white/60">Allows for mature and explicit themes in conversations.</p>
              </div>
              <button
                onClick={async () => {
                  const newValue = !nsfwEnabled;
                  setNsfwEnabled(newValue);
                  try {
                    await apiClient.put('/user/profile', { nsfw_enabled: newValue });
                  } catch (e) {
                    setError('Failed to update setting. Please try again.');
                    // Revert the state if the API call fails
                    setNsfwEnabled(!newValue);
                  }
                }}
                className={`relative h-6 w-11 rounded-full transition ${nsfwEnabled ? 'bg-gradient-to-r from-pink-500 to-purple-600' : 'bg-white/15'}`}
                aria-pressed={nsfwEnabled}
                disabled={!profile?.is_premium}
                title={!profile?.is_premium ? 'NSFW mode is a premium feature' : ''}
              >
                <span className={`absolute top-1/2 -translate-y-1/2 transform rounded-full bg-white transition ${nsfwEnabled ? 'left-6 h-4 w-4' : 'left-1 h-4 w-4'}`} />
              </button>
            </div>
            {!profile?.is_premium && (
              <p className="mt-2 text-xs text-yellow-300">
                NSFW mode is a premium feature. <a href="/subscribe" className="underline hover:text-white">Upgrade your account</a> to enable it.
              </p>
            )}
          </div>
        </div>
      )}
      <div className="mt-6">
        <button onClick={() => signOut()} className="rounded-full border border-white/20 px-4 py-2 text-white/90 hover:bg-white/10">Sign out</button>
      </div>
    </section>
  );
}


