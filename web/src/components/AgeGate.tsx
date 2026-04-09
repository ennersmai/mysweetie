import { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';

interface AgeGateProps {
  onAccept: () => void;
}

export default function AgeGate({ onAccept }: AgeGateProps) {
  const [isVisible, setIsVisible] = useState(false);

  useEffect(() => {
    // Check if user has already confirmed age
    const ageConfirmed = localStorage.getItem('mysweetie-age-confirmed');
    if (!ageConfirmed) {
      setIsVisible(true);
    } else {
      onAccept();
    }
  }, [onAccept]);

  const handleAccept = () => {
    // Store confirmation in localStorage
    localStorage.setItem('mysweetie-age-confirmed', 'true');
    localStorage.setItem('mysweetie-age-confirmed-date', new Date().toISOString());
    setIsVisible(false);
    onAccept();
  };

  const handleExit = () => {
    // Redirect to Google
    window.location.href = 'https://www.google.com';
  };

  if (!isVisible) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/90 backdrop-blur-sm">
      <div className="mx-4 w-full max-w-md rounded-2xl border border-white/20 bg-gray-900/95 p-8 shadow-2xl backdrop-blur-lg">
        {/* Logo/Branding */}
        <div className="mb-6 text-center">
          <h1 className="text-3xl font-bold tracking-tight">
            <span className="bg-gradient-to-r from-pink-500 via-fuchsia-500 to-purple-500 bg-clip-text text-transparent">
              MySweetie.AI
            </span>
          </h1>
        </div>

        {/* Main Message */}
        <div className="mb-8 text-center">
          <h2 className="mb-4 text-xl font-semibold text-white">
            Welcome to MySweetie.AI
          </h2>
          <p className="mb-4 text-gray-300 leading-relaxed">
            This experience is for adults only (18+).
          </p>
          <p className="text-sm text-gray-400 leading-relaxed">
            By continuing, you confirm that you are 18 years or older and agree to our{' '}
            <Link to="/tos" className="text-pink-400 hover:text-pink-300 underline">
              Terms of Service
            </Link>
            {' '}and Privacy Policy.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="space-y-3">
          <button
            onClick={handleAccept}
            className="w-full rounded-lg bg-gradient-to-r from-pink-500 to-purple-600 px-6 py-3 text-white font-medium shadow-lg transition hover:brightness-110 hover:shadow-xl"
          >
            I am 18+ and agree
          </button>
          
          <button
            onClick={handleExit}
            className="w-full rounded-lg border border-white/20 bg-white/5 px-6 py-3 text-gray-300 font-medium transition hover:bg-white/10 hover:text-white"
          >
            Exit
          </button>
        </div>

        {/* Footer */}
        <div className="mt-6 text-center">
          <p className="text-xs text-gray-500">
            This confirmation will be remembered on this device.
          </p>
        </div>
      </div>
    </div>
  );
}
