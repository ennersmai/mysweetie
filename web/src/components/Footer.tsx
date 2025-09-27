import { Link } from 'react-router-dom';

export default function Footer() {
  return (
    <footer className="mt-12 border-t border-transparent [border-image:linear-gradient(to_right,transparent,theme(colors.pink.500/.2),transparent)_1] py-8 text-sm text-gray-400">
      <div className="flex flex-col items-center justify-between gap-3 px-4 sm:px-6 lg:px-8 sm:flex-row">
        <div className="text-gray-400 text-center sm:text-left">
          <div>© {new Date().getFullYear()} MySweetie.ai</div>
          <div className="text-xs mt-1 italic">
            All characters and images are AI-generated. No real individuals are represented.
          </div>
        </div>
        <nav className="flex items-center gap-4 md:gap-8">
          <Link to="/subscribe" className="hover:text-white">Pricing</Link>
          <Link to="/characters" className="hover:text-white">Characters</Link>
          <Link to="/tos" className="hover:text-white">Terms</Link>
        </nav>
      </div>
    </footer>
  );
}


