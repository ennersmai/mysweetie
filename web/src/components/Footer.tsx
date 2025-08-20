import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="mt-12 border-t border-white/10 py-8 text-sm text-gray-400">
      <div className="mx-auto flex max-w-5xl flex-col items-center justify-between gap-3 px-6 sm:flex-row">
        <div className="text-gray-400">© {new Date().getFullYear()} mysweetie.ai</div>
        <nav className="flex items-center gap-4">
          <Link to="/subscribe" className="hover:text-white">Pricing</Link>
          <Link to="/characters" className="hover:text-white">Characters</Link>
          <Link to="/tos" className="hover:text-white">Terms</Link>
        </nav>
      </div>
    </footer>
  );
}


