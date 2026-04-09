import { Link, NavLink } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { useState, useEffect } from 'react';
import { supabase } from '../lib/supabaseClient';
import ParticleAnimation from './ParticleAnimation';
import logo from '../assets/logo.png';

export default function Navbar({ menuOpen, setMenuOpen }: { menuOpen: boolean; setMenuOpen: (open: boolean) => void; }) {
  const { user } = useAuth();
  const [lastChatUrl, setLastChatUrl] = useState('/characters');

  useEffect(() => {
    const fetchLastChat = async () => {
      if (!user) return;
      const { data } = await supabase
        .from('conversations')
        .select('character_id, id')
        .order('updated_at', { ascending: false })
        .limit(1)
        .maybeSingle();
      if (data) {
        setLastChatUrl(`/chat/${data.character_id}/${data.id}`);
      }
    };
    fetchLastChat();
  }, [user]);

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-2 rounded-full border border-white/20 transition hover:bg-white/10 ${isActive ? 'bg-white/10' : ''}`;

  return (
    <nav className="relative p-4 text-white border-b border-white/10 bg-white/5 backdrop-blur overflow-hidden">
      <ParticleAnimation className="absolute inset-0 opacity-40" />
      <div className="relative container mx-auto flex justify-between items-center">
        <Link to="/" className="flex items-center gap-2">
          {/* Logo Placeholder */}
          <img src={logo} alt="MySweetie.AI Logo" className="w-40" />
        </Link>
        
        {/* Desktop Nav */}
        <div className="hidden md:flex items-center gap-2">
          <NavLink to="/characters" className={navLinkClass}>Characters</NavLink>
          <NavLink to="/gallery" className={navLinkClass}>Gallery</NavLink>
          {user && <Link to={lastChatUrl} className="px-3 py-2 rounded-full border border-white/20 transition hover:bg-white/10">Chat</Link>}
          <NavLink to="/subscribe" className="rounded-full bg-gradient-to-r from-pink-500 to-purple-600 px-4 py-2 text-white shadow transition hover:brightness-110">Upgrade</NavLink>
          {user ? (
            <NavLink to="/account" className={navLinkClass}>Account</NavLink>
          ) : (
            <NavLink to="/login" className={navLinkClass}>Login</NavLink>
          )}
        </div>
        
        {/* Mobile Nav */}
        <div className="md:hidden">
          <button onClick={() => setMenuOpen(!menuOpen)}>
            {/* Hamburger Icon */}
            <svg className="w-6 h-6" fill="none" stroke="currentColor" viewBox="0 0 24 24" xmlns="http://www.w3.org/2000/svg"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16m-7 6h7" /></svg>
          </button>
        </div>
      </div>
      
      {/* Mobile Menu */}
      {menuOpen && (
        <div className="md:hidden mt-4">
          <div className="grid grid-cols-3 gap-2 text-center">
            <NavLink to="/characters" className={navLinkClass} onClick={() => setMenuOpen(false)}>Characters</NavLink>
            <NavLink to="/gallery" className={navLinkClass} onClick={() => setMenuOpen(false)}>Gallery</NavLink>
            {user && <Link to={lastChatUrl} className="px-3 py-2 rounded-full border border-white/20 transition hover:bg-white/10" onClick={() => setMenuOpen(false)}>Chat</Link>}
            <NavLink to="/subscribe" className={navLinkClass} onClick={() => setMenuOpen(false)}>Upgrade</NavLink>
            {user ? (
              <NavLink to="/account" className={navLinkClass} onClick={() => setMenuOpen(false)}>Account</NavLink>
            ) : (
              <NavLink to="/login" className={navLinkClass} onClick={() => setMenuOpen(false)}>Login</NavLink>
            )}
          </div>
        </div>
      )}
    </nav>
  );
}
