import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="mt-12 border-t border-white/10 py-8 text-sm text-gray-400">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-3 px-6 sm:flex-row">
        <div className="text-gray-400 text-center sm:text-left">
          <div>© {new Date().getFullYear()} MySweetie.ai</div>
          <div className="text-xs mt-1 italic">
            All characters and images are AI-generated. No real individuals are represented.
          </div>
        </div>
        <nav className="flex items-center gap-4">
          <Link to="/subscribe" className="hover:text-white">Pricing</Link>
          <Link to="/characters" className="hover:text-white">Characters</Link>
          <Link to="/tos" className="hover:text-white">Terms</Link>
        </nav>
      </div>
    </footer>
  );
}


