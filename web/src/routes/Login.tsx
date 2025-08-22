import { useState, useEffect } from 'react';
import type { FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export default function Login() {
  const { signInWithPassword, signUpWithPassword, user } = useAuth();
  const navigate = useNavigate();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Redirect to characters page if user is already logged in
  useEffect(() => {
    if (user) {
      navigate('/characters');
    }
  }, [user, navigate]);

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    const action = mode === 'login' ? signInWithPassword : signUpWithPassword;
    const res = await action({ email, password });
    if (res && 'error' in res && res.error) setError(res.error.message);
    setLoading(false);
  };

  return (
    <section className="mx-auto max-w-md rounded-2xl border border-white/10 bg-white/5 p-8 shadow-xl backdrop-blur">
      <h2 className="mb-4 text-2xl font-semibold text-white">{mode === 'login' ? 'Sign In' : 'Create Account'}</h2>
      <form onSubmit={onSubmit} className="space-y-4">
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">Email</label>
          <input
            type="email"
            className="w-full rounded border border-white/20 bg-white/5 px-3 py-2 text-white outline-none placeholder:text-gray-400 focus:border-pink-500"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            required
            placeholder="you@example.com"
          />
        </div>
        <div>
          <label className="mb-1 block text-sm font-medium text-gray-300">Password</label>
          <input
            type="password"
            className="w-full rounded border border-white/20 bg-white/5 px-3 py-2 text-white outline-none placeholder:text-gray-400 focus:border-pink-500"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            placeholder="••••••••"
          />
        </div>
        {error && <p className="text-sm text-red-400">{error}</p>}
        <div className="flex items-center gap-3">
          <button type="submit" disabled={loading} className="rounded-full bg-gradient-to-r from-pink-500 to-purple-600 px-4 py-2 text-white shadow disabled:opacity-50">
            {loading ? 'Please wait…' : mode === 'login' ? 'Sign In' : 'Sign Up'}
          </button>
          <button type="button" className="text-sm text-gray-300 underline" onClick={() => setMode(mode === 'login' ? 'signup' : 'login')}>
            {mode === 'login' ? 'Create an account' : 'Have an account? Sign in'}
          </button>
        </div>
      </form>
    </section>
  );
}


