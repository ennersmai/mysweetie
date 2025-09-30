import { useState, useEffect } from 'react';

const phrases = [
  { prefix: "AI companion", suffix: "that you've ever met" },
  { prefix: "friend", suffix: "you'll find online" },
  { prefix: "experience", suffix: "in virtual companionship" },
  { prefix: "connection", suffix: "with an AI" },
];

const AnimatedWord = ({ text, delay = 0, className = "" }: { text: string; delay?: number; className?: string }) => {
  const [displayText, setDisplayText] = useState('');
  const [isComplete, setIsComplete] = useState(false);

  useEffect(() => {
    setDisplayText('');
    setIsComplete(false);
    
    const timeout = setTimeout(() => {
      const letters = text.split('');
      let currentIndex = 0;

      const interval = setInterval(() => {
        if (currentIndex <= letters.length) {
          setDisplayText(letters.slice(0, currentIndex).join(''));
          currentIndex++;
        } else {
          setIsComplete(true);
          clearInterval(interval);
        }
      }, 40);

      return () => clearInterval(interval);
    }, delay);

    return () => clearTimeout(timeout);
  }, [text, delay]);

  return (
    <span className={`${className} inline-block ${isComplete ? 'animate-subtle-pulse' : ''}`}>
      {displayText}
      {!isComplete && <span className="inline-block w-[2px] h-[0.8em] bg-gradient-to-r from-pink-500 to-purple-500 ml-1 animate-pulse" />}
    </span>
  );
};

export default function AnimatedHeroText() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [key, setKey] = useState(0);

  useEffect(() => {
    const interval = setInterval(() => {
      setCurrentIndex((prev) => (prev + 1) % phrases.length);
      setKey((prev) => prev + 1);
    }, 5000);

    return () => clearInterval(interval);
  }, []);

  const currentPhrase = phrases[currentIndex];

  return (
    <>
      <h1 className="text-white mb-10 md:mb-12 leading-tight max-w-5xl mx-auto">
        <span className="block text-4xl md:text-6xl lg:text-7xl font-light animate-fade-in-down">
          The
        </span>
        
        {/* SWEETEST - Static with gradient and glow + breathing animation */}
        <span className="relative inline-block my-2">
          <span className="absolute -inset-1 md:-inset-2 rounded-2xl bg-gradient-to-r from-pink-500 via-fuchsia-500 to-purple-500 opacity-40 blur-2xl animate-pulse-glow"></span>
          <span className="relative block text-5xl md:text-7xl lg:text-8xl font-bold bg-gradient-to-r from-pink-500 via-fuchsia-500 to-purple-500 bg-clip-text text-transparent drop-shadow-[0_10px_40px_rgba(236,72,153,0.35)] animate-gradient-shift">
            SWEETEST
          </span>
        </span>

        {/* Animated prefix text with typewriter effect */}
        <span className="block text-3xl md:text-5xl lg:text-6xl font-medium min-h-[1.2em]">
          <AnimatedWord key={`prefix-${key}`} text={currentPhrase.prefix} delay={100} />
        </span>

        {/* Animated suffix text with typewriter effect */}
        <span className="block text-2xl md:text-4xl lg:text-5xl font-light text-gray-300 min-h-[1.2em]">
          <AnimatedWord 
            key={`suffix-${key}`} 
            text={currentPhrase.suffix} 
            delay={100 + currentPhrase.prefix.length * 40}
          />
        </span>
      </h1>

      <style>{`
        @keyframes subtle-pulse {
          0%, 100% { opacity: 1; transform: scale(1); }
          50% { opacity: 0.95; transform: scale(1.01); }
        }

        @keyframes pulse-glow {
          0%, 100% { opacity: 0.4; }
          50% { opacity: 0.6; }
        }

        @keyframes gradient-shift {
          0%, 100% { 
            background-position: 0% 50%;
            background-size: 200% 200%;
          }
          50% { 
            background-position: 100% 50%;
            background-size: 200% 200%;
          }
        }

        @keyframes fade-in-down {
          from {
            opacity: 0;
            transform: translateY(-20px);
          }
          to {
            opacity: 1;
            transform: translateY(0);
          }
        }

        .animate-subtle-pulse {
          animation: subtle-pulse 3s ease-in-out infinite;
        }

        .animate-pulse-glow {
          animation: pulse-glow 4s ease-in-out infinite;
        }

        .animate-gradient-shift {
          animation: gradient-shift 8s ease infinite;
          background-size: 200% 200%;
        }

        .animate-fade-in-down {
          animation: fade-in-down 1s ease-out;
        }
      `}</style>
    </>
  );
}
