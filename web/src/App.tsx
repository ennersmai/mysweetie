import { Link, NavLink, Route, Routes } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Home from './routes/Home';
import Login from './routes/Login';
import Characters from './routes/Characters';
import Chat from './routes/Chat';
import Gallery from './routes/Gallery';
import Subscribe from './routes/Subscribe';
import Account from './routes/Account';
import NewCharacter from './routes/NewCharacter';
import Admin from './routes/Admin';
import Tos from './routes/Tos';
import Footer from './components/Footer';

function HeaderNav() {
  const { user } = useAuth();
  return (
    <header className="w-full border-b border-white/10 bg-white/5 backdrop-blur">
      <div className="mx-auto flex max-w-5xl items-center justify-between px-6 py-4">
        <Link to="/" className="text-2xl font-semibold tracking-tight text-white">
          <span className="bg-gradient-to-r from-pink-500 via-fuchsia-500 to-purple-500 bg-clip-text text-transparent">mysweetie.ai</span>
        </Link>
        <nav className="flex items-center gap-4 text-sm text-gray-300">
          <NavLink to="/characters" className={({ isActive }) => (isActive ? 'font-medium text-white' : '')}>
            Characters
          </NavLink>
          <NavLink to="/gallery" className={({ isActive }) => (isActive ? 'font-medium text-white' : '')}>Gallery</NavLink>
          <NavLink to="/subscribe" className={({ isActive }) => (isActive ? 'font-medium text-white' : '')}>
            <span className="rounded-full bg-gradient-to-r from-pink-500 to-purple-600 px-3 py-1 text-white shadow">Upgrade</span>
          </NavLink>
          {user ? (
            <>
              <NavLink to="/account" className={({ isActive }) => (isActive ? 'font-medium text-white' : '')}>Account</NavLink>
              <NavLink to="/admin" className={({ isActive }) => (isActive ? 'font-medium text-white' : '')}>Admin</NavLink>
            </>
          ) : (
            <NavLink to="/login" className={({ isActive }) => (isActive ? 'font-medium text-white' : '')}>Login</NavLink>
          )}
        </nav>
      </div>
    </header>
  );
}

export default function App() {
  return (
    <AuthProvider>
      <div className="min-h-screen text-gray-100 flex flex-col">
        <HeaderNav />
        <div className="mx-auto flex-1 w-full max-w-7xl px-2 py-1 sm:px-4 flex flex-col">
          <main className="flex-1">
            <Routes>
              <Route path="/" element={<Home />} />
              <Route path="/login" element={<Login />} />
              <Route path="/characters" element={<Characters />} />
              <Route path="/characters/new" element={<NewCharacter />} />
              <Route path="/chat/:characterId" element={<Chat />} />
              <Route path="/chat/:characterId/:conversationId" element={<Chat />} />
              <Route path="/gallery" element={<Gallery />} />
              <Route path="/subscribe" element={<Subscribe />} />
              <Route path="/account" element={<Account />} />
              <Route path="/admin" element={<Admin />} />
              <Route path="/tos" element={<Tos />} />
            </Routes>
          </main>
        </div>
        <Footer />
      </div>
    </AuthProvider>
  );
}
