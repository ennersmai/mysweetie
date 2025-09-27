import { Routes, Route, useLocation } from 'react-router-dom';
import { useState, useEffect } from 'react';
import { AuthProvider } from './contexts/AuthContext';
import Landing from './routes/Landing';
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
import ProtectedRoute from './components/ProtectedRoute';
import Navbar from './components/Navbar';

function App() {
  const [menuOpen, setMenuOpen] = useState(false);
  const location = useLocation();
  const isChatPage = location.pathname.startsWith('/chat');
  const [isMobile, setIsMobile] = useState(window.innerWidth < 768);

  useEffect(() => {
    const handleResize = () => {
      setIsMobile(window.innerWidth < 768);
    };

    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);


  return (
      <AuthProvider>
        <Navbar menuOpen={menuOpen} setMenuOpen={setMenuOpen} />
        <main className={`container mx-auto px-4 ${isChatPage ? '' : 'py-[3px]'}`}>
          <Routes>
                <Route path="/" element={<Landing />} />
                <Route path="/login" element={<Login />} />
                <Route path="/tos" element={<Tos />} />
                <Route path="/characters" element={<ProtectedRoute><Characters /></ProtectedRoute>} />
                <Route path="/characters/new" element={<ProtectedRoute><NewCharacter /></ProtectedRoute>} />
                <Route path="/chat/:characterId" element={<ProtectedRoute><Chat menuOpen={menuOpen} /></ProtectedRoute>} />
                <Route path="/chat/:characterId/:conversationId" element={<ProtectedRoute><Chat menuOpen={menuOpen} /></ProtectedRoute>} />
                <Route path="/gallery" element={<ProtectedRoute><Gallery /></ProtectedRoute>} />
                <Route path="/subscribe" element={<ProtectedRoute><Subscribe /></ProtectedRoute>} />
                <Route path="/account" element={<ProtectedRoute><Account /></ProtectedRoute>} />
                <Route path="/admin" element={<ProtectedRoute><Admin /></ProtectedRoute>} />
              </Routes>
            </main>
            {isChatPage && isMobile ? null : <Footer />}
          </AuthProvider>
    );
  }

export default App;
