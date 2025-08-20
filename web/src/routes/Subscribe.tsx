import { useState } from 'react';
import { authFetch } from '../lib/functionsClient';

export default function Subscribe() {
  const [loading, setLoading] = useState<'basic' | 'premium' | null>(null);
  const [error, setError] = useState<string | null>(null);

  const startCheckout = async (tier: 'basic' | 'premium') => {
    setLoading(tier);
    setError(null);
    try {
      const res = await authFetch('/create-checkout-session', {
        method: 'POST',
        body: JSON.stringify({ tier }),
      });
      const json = await res.json();
      if (!res.ok) throw new Error(json?.error || 'Checkout error');
      if (json.url) window.location.href = json.url as string;
    } catch (e: any) {
      setError(e.message || String(e));
    } finally {
      setLoading(null);
    }
  };

  return (
    <section className="mx-auto max-w-4xl rounded-2xl border border-white/10 bg-white/5 p-8 shadow-xl backdrop-blur">
      <h2 className="mb-2 text-2xl font-semibold text-white">Upgrade Your Experience</h2>
      <p className="mb-6 text-sm text-white/70">Free users get unlimited text chat and 3 voice trials. Upgrade for more voice, memory, and premium models.</p>
      {error && <p className="mb-3 text-sm text-red-400">{error}</p>}
      <div className="grid gap-6 sm:grid-cols-2">
        <div className="rounded-xl border border-white/10 bg-white/5 p-6 flex flex-col">
          <h3 className="mb-1 text-xl font-medium text-white">Basic</h3>
          <div className="mb-4 text-3xl font-semibold text-white">£9.99<span className="text-base font-normal text-gray-300">/mo</span></div>
          <ul className="mb-5 space-y-2 text-sm text-white/85 flex-1">
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-pink-500"/> Unlimited text chat</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-pink-500"/> 50 voice streams / month</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-pink-500"/> Doubled memory (20-message context)</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-pink-500"/> Non‑premium models</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-pink-500"/> Gallery previews</li>
          </ul>
          <button
            onClick={() => startCheckout('basic')}
            disabled={loading !== null}
            className="w-full h-11 rounded-full bg-white/10 px-4 text-white backdrop-blur transition hover:bg-white/20 disabled:opacity-50 flex items-center justify-center"
          >
            {loading === 'basic' ? 'Redirecting…' : 'Subscribe for £9.99/mo'}
          </button>
        </div>
        <div className="relative overflow-hidden rounded-xl border border-pink-500/30 bg-gradient-to-br from-pink-500/20 to-purple-600/20 p-6 flex flex-col">
          <div className="pointer-events-none absolute -right-10 -top-10 h-28 w-28 rounded-full bg-pink-500/30 blur-2xl" />
          <div className="mb-1 flex items-center justify-between">
            <h3 className="text-xl font-medium text-white">Premium</h3>
            <span className="rounded-full bg-white/15 px-2 py-0.5 text-xs text-white/90">Most popular</span>
          </div>
          <div className="mb-3 text-3xl font-semibold text-white">£49.99<span className="text-base font-normal text-white/80">/mo</span></div>
          <ul className="mb-5 space-y-2 text-sm text-white flex-1">
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-purple-400"/> Unlimited text chat</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-purple-400"/> 500 voice streams / month</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-purple-400"/> Expanded memory (40-message context)</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-purple-400"/> Access to Premium models</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-purple-400"/> Full‑resolution galleries</li>
            <li className="flex items-start gap-2"><span className="mt-1 inline-block h-1.5 w-1.5 rounded-full bg-purple-400"/> Fantasy mode</li>
          </ul>
          <button
            onClick={() => startCheckout('premium')}
            disabled={loading !== null}
            className="w-full h-11 rounded-full bg-gradient-to-r from-pink-500 to-purple-600 px-4 text-white shadow transition hover:brightness-110 disabled:opacity-50 flex items-center justify-center"
          >
            {loading === 'premium' ? 'Redirecting…' : 'Subscribe'}
          </button>
        </div>
      </div>
      <p className="mt-6 text-xs text-white/60">Voice allowances refresh monthly. Free plan includes 3 voice trials.</p>
    </section>
  );
}


