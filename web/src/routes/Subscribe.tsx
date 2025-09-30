import { useState } from 'react';
import { apiClient } from '../lib/apiClient';

export default function Subscribe() {
  const [loading, setLoading] = useState<'basic' | 'premium' | 'voice_credits' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startCheckout = async (tier: 'basic' | 'premium' | 'voice_credits') => {
    setLoading(tier);
    setError(null);
    try {
      const res = await apiClient.post('/stripe/create-checkout-session', { tier });
      
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
      console.error('Checkout error:', e);
    } finally {
      setLoading(null);
    }
  };

  return (
    <section className="mx-auto max-w-5xl rounded-2xl border border-white/10 bg-white/5 p-8 shadow-xl backdrop-blur">
      <h2 className="mb-2 text-2xl font-semibold text-white">Upgrade Your Experience</h2>
      <p className="mb-6 text-sm text-white/70">Free users get unlimited text chat and 10 voice trials per month. Upgrade for more voice credits, enhanced AI memory, and premium features.</p>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      <div className="grid gap-6 sm:grid-cols-3">
        {/* Basic Plan */}
        <div className="rounded-xl border border-white/10 bg-white/5 p-6 flex flex-col">
          <h3 className="mb-1 text-xl font-medium text-white">Basic</h3>
          <div className="mb-4 text-3xl font-semibold text-white">$9.99<span className="text-base font-normal text-gray-300">/mo</span></div>
          <ul className="mb-5 space-y-2 text-sm text-white/85 flex-1">
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-pink-500"/> Unlimited text chat</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-pink-500"/> 200 voice credits / month</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-pink-500"/> AI remembers 50 memories</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-pink-500"/> Full-resolution galleries</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-pink-500"/> NSFW & Fantasy modes</li>
          </ul>
          <button
            onClick={() => startCheckout('basic')}
            disabled={loading !== null}
            className="w-full h-11 rounded-full bg-white/10 px-4 text-white backdrop-blur transition hover:bg-white/20 disabled:opacity-50 flex items-center justify-center"
          >
            {loading === 'basic' ? 'Redirecting…' : 'Subscribe'}
          </button>
        </div>

        {/* Premium Plan */}
        <div className="relative overflow-hidden rounded-xl border border-pink-500/30 bg-gradient-to-br from-pink-500/20 to-purple-600/20 p-6 flex flex-col">
          <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-pink-500/30 blur-2xl" />
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-xl font-medium text-white">Premium</h3>
            <span className="rounded-full bg-white/15 px-2 py-0.5 text-xs text-white/90">Most popular</span>
          </div>
          <div className="mb-3 text-3xl font-semibold text-white">$49.99<span className="text-base font-normal text-white/80">/mo</span></div>
          <ul className="mb-5 space-y-2 text-sm text-white flex-1">
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-purple-400"/> Unlimited text chat</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-purple-400"/> <strong>1,000 voice credits</strong> / month</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-purple-400"/> AI remembers 100 memories</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-purple-400"/> Full‑resolution galleries</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-purple-400"/> NSFW & Fantasy modes</li>
          </ul>
          <button
            onClick={() => startCheckout('premium')}
            disabled={loading !== null}
            className="w-full h-11 rounded-full bg-gradient-to-r from-pink-500 to-purple-600 px-4 text-white shadow transition hover:brightness-110 disabled:opacity-50 flex items-center justify-center"
          >
            {loading === 'premium' ? 'Redirecting…' : 'Subscribe'}
          </button>
        </div>

        {/* Voice Credits Add-on */}
        <div className="rounded-xl border border-emerald-500/30 bg-gradient-to-br from-emerald-500/10 to-green-600/10 p-6 flex flex-col">
          <h3 className="mb-1 text-xl font-medium text-white">Voice Credits</h3>
          <div className="mb-4 text-3xl font-semibold text-white">$9.99<span className="text-base font-normal text-gray-300"> once</span></div>
          <ul className="mb-5 space-y-2 text-sm text-white/85 flex-1">
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400"/> 200 voice credits</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400"/> No expiration</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400"/> Works with any plan</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-emerald-400"/> Perfect for extra voice messages</li>
          </ul>
          <button
            onClick={() => startCheckout('voice_credits' as any)}
            disabled={loading !== null}
            className="w-full h-11 rounded-full bg-gradient-to-r from-emerald-500 to-green-600 px-4 text-white shadow transition hover:brightness-110 disabled:opacity-50 flex items-center justify-center"
          >
            {loading === 'voice_credits' ? 'Redirecting…' : 'Buy Credits'}
          </button>
        </div>
      </div>
      
      {/* AI Disclaimer */}
      <div className="mt-6 p-4 rounded-lg bg-white/5 border border-white/10">
        <p className="text-sm text-gray-300 text-center italic">
          <strong>By subscribing, you acknowledge that all content is AI-generated and that MySweetie.ai does not feature real individuals.</strong>
        </p>
      </div>
      
      <p className="mt-4 text-xs text-white/60">Voice credits refresh monthly for subscribers. Free plan includes 10 voice trials per month. Additional voice credits never expire.</p>
    </section>
  );
}


