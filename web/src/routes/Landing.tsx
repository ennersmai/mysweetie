import { useEffect, useState, useRef, useMemo } from 'react';
import { Link } from 'react-router-dom';
import { supabase } from '../lib/supabaseClient';
import AnimatedSection from '../components/AnimatedSection';
import ParticleAnimation from '../components/ParticleAnimation';
import AnimatedHeroText from '../components/AnimatedHeroText';
import { useImagePrefetch } from '../hooks/useImagePrefetch';

type Character = {
  id: string;
  name: string;
  description: string | null;
  avatar_url: string | null;
  style?: 'realistic' | 'anime';
};

type FAQItem = {
  question: string;
  answer: string;
  isOpen: boolean;
};

export default function Landing() {
  const [characters, setCharacters] = useState<Character[]>([]);
  const [styleFilter, setStyleFilter] = useState<'realistic' | 'anime'>('realistic');
  const [currentSlide, setCurrentSlide] = useState(0);
  const [isSliderHovered, setIsSliderHovered] = useState(false);
  const [faqs, setFaqs] = useState<FAQItem[]>([
    {
      question: "How does MySweetie.AI work?",
      answer: "MySweetie.AI uses advanced AI technology to create lifelike conversations with virtual companions. Simply choose a character, start chatting, and experience personalized interactions with memory, voice responses, and fantasy scenarios.",
      isOpen: false
    },
    {
      question: "Is MySweetie.AI free to use?",
      answer: "We offer a free tier with basic features. Premium subscriptions unlock advanced AI models, voice responses, fantasy mode, NSFW mode and exclusive characters. Check our pricing page for detailed plans.",
      isOpen: false
    },
    {
      question: "What makes the AI companions special?",
      answer: "Our AI companions feature persistent memory, natural voice synthesis, and adaptive personalities. They remember your conversations, respond with realistic voices, and can engage in various roleplay scenarios tailored to your preferences.",
      isOpen: false
    },
    {
      question: "Is my data and conversations private?",
      answer: "Absolutely. We prioritize your privacy with end-to-end encryption, secure data storage, and strict privacy policies. Your conversations are never shared and are protected by industry-standard security measures.",
      isOpen: false
    },
    {
      question: "Can I create my own AI companion?",
      answer: "Yes! Premium users can create custom AI companions with personalized appearances, personalities, and backstories. Design your perfect companion and bring them to life with our advanced AI technology.",
      isOpen: false
    }
  ]);

  const heroRef = useRef<HTMLDivElement>(null);
  const featuresRef = useRef<HTMLDivElement>(null);
  const faqRef = useRef<HTMLDivElement>(null);

  // Extract character avatar URLs for prefetching
  const characterImageUrls = useMemo(() => {
    return characters
      .filter(char => char.avatar_url)
      .map(char => char.avatar_url!)
      .slice(0, 12); // Limit to first 12 characters
  }, [characters]);

  // Prefetch character images
  const { isPrefetched } = useImagePrefetch(characterImageUrls, { priority: 'high' });

  // Load characters for current style (newest first) and auto-refresh via realtime
  useEffect(() => {
    let isCancelled = false;

    const loadCharacters = async () => {
      // Show newest characters first; include null style as realistic for backwards-compat
      let query = supabase
        .from('characters')
        .select('id, name, description, avatar_url, style')
        .order('created_at', { ascending: false })
        .limit(12);

      if (styleFilter === 'anime') {
        query = query.eq('style', 'anime');
      } else {
        // realistic or null for older rows
        query = query.or('style.eq.realistic,style.is.null');
      }

      const { data } = await query;
      if (!isCancelled) setCharacters(data || []);
    };

    loadCharacters();

    const channel = supabase
      .channel('realtime:characters')
      .on('postgres_changes', { event: '*', schema: 'public', table: 'characters' }, () => {
        // On any character insert/update/delete, refresh the current style list
        loadCharacters();
      })
      .subscribe();

    return () => {
      isCancelled = true;
      supabase.removeChannel(channel);
    };
  }, [styleFilter]);

  useEffect(() => {
    if (characters.length > 0 && !isSliderHovered) {
      const interval = setInterval(() => {
        setCurrentSlide((prev) => (prev + 1) % characters.length);
      }, 7000);
      return () => clearInterval(interval);
    }
  }, [characters, isSliderHovered]);

  // Reset slide on filter change
  useEffect(() => { setCurrentSlide(0); }, [styleFilter]);

  useEffect(() => {
    const observerOptions = {
      threshold: 0.1,
      rootMargin: '0px 0px -50px 0px'
    };

    const observer = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('animate-fade-in-up');
        }
      });
    }, observerOptions);

    [heroRef, featuresRef, faqRef].forEach((ref) => {
      if (ref.current) observer.observe(ref.current);
    });

    return () => observer.disconnect();
  }, []);

  const toggleFAQ = (index: number) => {
    setFaqs(prev => prev.map((faq, i) => 
      i === index ? { ...faq, isOpen: !faq.isOpen } : faq
    ));
  };

  const MemoryIcon = () => (
    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 12h6m-6 4h6m2 5H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
    </svg>
  );

  const VoiceIcon = () => (
    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 11a7 7 0 01-7 7m0 0a7 7 0 01-7-7m7 7v4m0 0H8m4 0h4m-4-8a3 3 0 01-3-3V5a3 3 0 116 0v6a3 3 0 01-3 3z" />
    </svg>
  );

  const FantasyIcon = () => (
    <svg className="w-8 h-8" fill="none" stroke="currentColor" viewBox="0 0 24 24">
      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11.049 2.927c.3-.921 1.603-.921 1.902 0l1.519 4.674a1 1 0 00.95.69h4.915c.969 0 1.371 1.24.588 1.81l-3.976 2.888a1 1 0 00-.363 1.118l1.518 4.674c.3.922-.755 1.688-1.538 1.118l-3.976-2.888a1 1 0 00-1.176 0l-3.976 2.888c-.783.57-1.838-.197-1.538-1.118l1.518-4.674a1 1 0 00-.363-1.118l-3.976-2.888c-.784-.57-.38-1.81.588-1.81h4.914a1 1 0 00.951-.69l1.519-4.674z" />
    </svg>
  );

  return (
    <div className="min-h-screen">
      {/* Hero Section */}
      <section ref={heroRef} className="relative py-24 md:py-32 px-6 min-h-[85vh] md:min-h-[95vh] overflow-hidden">
        <ParticleAnimation className="absolute inset-0 opacity-40" />
        <div className="relative z-10 max-w-6xl mx-auto text-center">
          <AnimatedHeroText />
          <p className="text-xl md:text-2xl text-gray-300 mb-12 max-w-4xl mx-auto leading-relaxed">
            Choose your perfect companion — Experience the future of AI companionship with lifelike conversations, persistent memory, and voice interactions that feel genuinely human. Chat, flirt, and unlock exclusive experiences anytime you want.
          </p>
          <div className="flex flex-col sm:flex-row gap-4 justify-center">
            <Link 
              to="/characters" 
              className="px-8 py-4 text-lg font-semibold bg-gradient-to-r from-pink-500 to-purple-600 text-white rounded-full shadow-2xl hover:brightness-110 hover:shadow-pink-500/50 transition-all duration-300 transform hover:scale-105"
            >
              Meet Your Companion
            </Link>
            <Link 
              to="/subscribe" 
              className="px-8 py-4 text-lg font-semibold border-2 border-white/30 text-white rounded-full backdrop-blur hover:bg-white/10 transition-all duration-300"
            >
              View Pricing
            </Link>
          </div>
        </div>
      </section>

      {/* Character Slider */}
      {characters.length > 0 && (
        <AnimatedSection className="mx-6 mb-20">
          <div className="relative p-8 pt-20 md:pt-24">
            {/* Style Toggle */}
            <div className="mb-6 flex justify-center">
              <div className="inline-flex rounded-full border border-white/20 bg-white/5 p-1">
                <button
                  type="button"
                  className={`px-4 py-1.5 text-sm rounded-full transition ${styleFilter === 'realistic' ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white' : 'text-white/80 hover:bg-white/10'}`}
                  onClick={() => setStyleFilter('realistic')}
                >
                  Realistic
                </button>
                <button
                  type="button"
                  className={`px-4 py-1.5 text-sm rounded-full transition ${styleFilter === 'anime' ? 'bg-gradient-to-r from-pink-500 to-purple-600 text-white' : 'text-white/80 hover:bg-white/10'}`}
                  onClick={() => setStyleFilter('anime')}
                >
                  Anime
                </button>
              </div>
            </div>
            {/* Sugar glaze top overlay - full card width with melting drips */}
            <div className="pointer-events-none absolute top-0 inset-x-0 z-10 rounded-t-2xl overflow-hidden">
              <svg viewBox="0 0 1440 120" preserveAspectRatio="none" className="w-full h-24 md:h-28 rounded-t-2xl">
                <defs>
                  <linearGradient id="glazeGrad" x1="0" x2="0" y1="0" y2="1">
                    <stop offset="0%" stopColor="white" stopOpacity="0.32" />
                    <stop offset="100%" stopColor="white" stopOpacity="0.08" />
                  </linearGradient>
                  <clipPath id="glazeClip">
                    {/* Rounded top corners only */}
                    <path d="M0,16 Q0,0 16,0 L1424,0 Q1440,0 1440,16 L1440,120 L0,120 Z" />
                  </clipPath>
                </defs>
                <g clipPath="url(#glazeClip)">
                  {/* Base glaze layer */}
                  <path
                    d="M0,0 L1440,0 L1440,30
                    C1400,38 1380,70 1340,68
                    C1290,66 1270,38 1230,40
                    C1200,42 1190,70 1160,74
                    C1130,78 1100,62 1070,60
                    C1040,58 1020,76 990,80
                    C960,84 930,68 900,64
                    C870,60 850,78 820,82
                    C790,86 760,66 740,62
                    C720,58 700,76 680,78
                    C660,80 640,66 620,60
                    C600,54 580,62 560,72
                    C540,82 520,90 500,76
                    C480,62 470,38 440,40
                    C410,42 400,70 370,74
                    C340,78 320,62 300,58
                    C280,54 260,66 240,70
                    C220,74 200,66 180,62
                    C160,58 140,68 120,72
                    C100,76 80,68 60,60
                    C40,52 20,40 0,44 Z"
                    fill="url(#glazeGrad)"
                  />
                  {/* Highlight layer */}
                  <path
                    d="M0,0 L1440,0 L1440,20
                    C1400,28 1380,54 1340,52
                    C1290,50 1270,28 1230,30
                    C1200,32 1190,54 1160,58
                    C1130,62 1100,48 1070,46
                    C1040,44 1020,58 990,62
                    C960,66 930,54 900,50
                    C870,46 850,60 820,64
                    C790,68 760,54 740,50
                    C720,46 700,58 680,60
                    C660,62 640,54 620,50
                    C600,46 580,52 560,58
                    C540,64 520,70 500,60
                    C480,50 470,28 440,30
                    C410,32 400,54 370,58
                    C340,62 320,50 300,46
                    C280,42 260,52 240,56
                    C220,60 200,52 180,48
                    C160,44 140,52 120,56
                    C100,60 80,54 60,48
                    C40,42 20,32 0,34 Z"
                    fill="rgba(255,255,255,0.25)"
                  />
                </g>
              </svg>
            </div>
            <h2 className="text-3xl md:text-4xl font-bold text-white text-center mb-12">
              Meet Our{' '}
              <span className="relative inline-block">
                <span className="absolute -inset-1 rounded-xl bg-gradient-to-r from-pink-500 to-purple-500 opacity-40 blur-xl"></span>
                <span className="relative bg-gradient-to-r from-pink-500 to-purple-500 bg-clip-text text-transparent">Companions</span>
              </span>
            </h2>
            <div 
              className="relative overflow-hidden rounded-2xl"
              onMouseEnter={() => setIsSliderHovered(true)}
              onMouseLeave={() => setIsSliderHovered(false)}
            >
              <div 
                className="flex transition-transform duration-700 ease-in-out"
                style={{ transform: `translateX(-${currentSlide * 100}%)` }}
              >
                {characters.map((character) => (
                  <div key={character.id} className="w-full flex-shrink-0 flex items-center justify-center p-8">
                    <div className="flex flex-col md:flex-row items-center gap-8 max-w-4xl">
                      <div className="flex-shrink-0">
                        {character.avatar_url ? (
                          <div className="relative">
                            <img 
                              src={character.avatar_url} 
                              alt={character.name}
                              className={`max-h-[26rem] md:max-h-[28rem] h-auto w-auto max-w-full object-contain object-center rounded-2xl ring-4 ring-pink-500/40 shadow-2xl transition-opacity duration-500 ${
                                isPrefetched(character.avatar_url) ? 'opacity-100' : 'opacity-0'
                              }`}
                              onLoad={(e) => {
                                (e.target as HTMLImageElement).style.opacity = '1';
                              }}
                              onError={(e) => {
                                (e.target as HTMLImageElement).style.opacity = '0.5';
                              }}
                            />
                            {!isPrefetched(character.avatar_url) && (
                              <div className="absolute inset-0 flex items-center justify-center bg-white/5 rounded-2xl">
                                <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-pink-500"></div>
                              </div>
                            )}
                          </div>
                        ) : (
                          <div className="w-72 h-96 bg-white/10 rounded-2xl flex items-center justify-center">
                            <span className="text-6xl">👤</span>
                          </div>
                        )}
                      </div>
                      <div className="flex-1 text-center md:text-left">
                        <h3 className="text-3xl font-bold text-white mb-4">{character.name}</h3>
                        <p className="text-lg text-gray-300 mb-6 leading-relaxed">
                          {character.description || "A unique AI companion ready to chat with you."}
                        </p>
                        <Link 
                          to={`/chat/${character.id}`}
                          className="inline-block px-6 py-3 bg-gradient-to-r from-pink-500 to-purple-600 text-white rounded-full hover:brightness-110 transition-all duration-300 transform hover:scale-105"
                        >
                          Start Chatting
                        </Link>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
              {/* Prev/Next Controls */}
              <button
                aria-label="Previous"
                onClick={() => setCurrentSlide((prev) => (prev - 1 + characters.length) % characters.length)}
                className="absolute left-2 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/30 hover:bg-black/50 text-white border border-white/20 backdrop-blur shadow-lg transition"
              >
                <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M15 18l-6-6 6-6" />
                </svg>
              </button>
              <button
                aria-label="Next"
                onClick={() => setCurrentSlide((prev) => (prev + 1) % characters.length)}
                className="absolute right-2 top-1/2 -translate-y-1/2 p-3 rounded-full bg-black/30 hover:bg-black/50 text-white border border-white/20 backdrop-blur shadow-lg transition"
              >
                <svg className="w-6 h-6" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M9 18l6-6-6-6" />
                </svg>
              </button>
              {/* Slide Indicators */}
              <div className="flex justify-center space-x-2 mt-8">
                {characters.map((_, index) => (
                  <button
                    key={index}
                    aria-label={`Go to slide ${index + 1}`}
                    onClick={() => setCurrentSlide(index)}
                    className="group p-1"
                  >
                    <svg
                      viewBox="0 0 24 24"
                      className={`w-4 h-4 transition-all duration-300 ${index === currentSlide ? 'text-pink-500 scale-125' : 'text-white/30 group-hover:text-white/50'}`}
                      fill="currentColor"
                    >
                      <path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 6 4 4 6.5 4c1.74 0 3.41.81 4.5 2.09C12.09 4.81 13.76 4 15.5 4 18 4 20 6 20 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z" />
                    </svg>
                  </button>
                ))}
              </div>
            </div>
          </div>
        </AnimatedSection>
      )}

      {/* Features Section */}
      <section ref={featuresRef} className="py-20 px-6">
        <div className="max-w-6xl mx-auto">
          <h2 className="text-3xl md:text-4xl font-bold text-white text-center mb-16">
            Why Choose <span className="bg-gradient-to-r from-pink-500 to-purple-500 bg-clip-text text-transparent">MySweetie.AI</span>
          </h2>
          <div className="grid md:grid-cols-3 gap-8">
            {/* Memory Feature */}
            <div className="group p-8 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-lg hover:bg-white/10 transition-all duration-300 transform hover:scale-105 hover:shadow-2xl hover:shadow-pink-500/20">
              <div className="w-16 h-16 rounded-full bg-gradient-to-r from-pink-500 to-purple-600 flex items-center justify-center mb-6 mx-auto group-hover:scale-110 transition-transform duration-300">
                <MemoryIcon />
              </div>
              <h3 className="text-2xl font-bold text-white text-center mb-4">Persistent Memory</h3>
              <p className="text-gray-300 text-center leading-relaxed">
                Your AI companion remembers every conversation, building deeper relationships and more meaningful interactions over time.
              </p>
            </div>

            {/* Voice Feature */}
            <div className="group p-8 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-lg hover:bg-white/10 transition-all duration-300 transform hover:scale-105 hover:shadow-2xl hover:shadow-pink-500/20">
              <div className="w-16 h-16 rounded-full bg-gradient-to-r from-pink-500 to-purple-600 flex items-center justify-center mb-6 mx-auto group-hover:scale-110 transition-transform duration-300">
                <VoiceIcon />
              </div>
              <h3 className="text-2xl font-bold text-white text-center mb-4">Realistic Voice</h3>
              <p className="text-gray-300 text-center leading-relaxed">
                Hear your companion speak with natural, expressive voices that bring conversations to life with emotional depth and personality.
              </p>
            </div>

            {/* Fantasy Mode Feature */}
            <div className="group p-8 rounded-2xl border border-white/10 bg-white/5 backdrop-blur-lg hover:bg-white/10 transition-all duration-300 transform hover:scale-105 hover:shadow-2xl hover:shadow-pink-500/20">
              <div className="w-16 h-16 rounded-full bg-gradient-to-r from-pink-500 to-purple-600 flex items-center justify-center mb-6 mx-auto group-hover:scale-110 transition-transform duration-300">
                <FantasyIcon />
              </div>
              <h3 className="text-2xl font-bold text-white text-center mb-4">Fantasy Mode</h3>
              <p className="text-gray-300 text-center leading-relaxed">
                Explore immersive roleplay scenarios and creative storytelling with AI companions designed for adult entertainment and fantasy.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* FAQ Section */}
      <AnimatedSection className="mx-6 mb-20">
        <div ref={faqRef} className="p-8">
          <h2 className="text-3xl md:text-4xl font-bold text-white text-center mb-12">
            Frequently Asked <span className="bg-gradient-to-r from-pink-500 to-purple-500 bg-clip-text text-transparent">Questions</span>
          </h2>
          <div className="max-w-4xl mx-auto space-y-4">
            {faqs.map((faq, index) => (
              <div key={index} className="border border-white/10 rounded-xl bg-white/5 backdrop-blur overflow-hidden">
                <button
                  onClick={() => toggleFAQ(index)}
                  className="w-full p-6 text-left flex items-center justify-between hover:bg-white/10 transition-colors duration-200"
                >
                  <h3 className="text-lg font-semibold text-white pr-4">{faq.question}</h3>
                  <svg 
                    className={`w-6 h-6 text-pink-500 transition-transform duration-300 flex-shrink-0 ${faq.isOpen ? 'rotate-180' : ''}`}
                    fill="none" 
                    stroke="currentColor" 
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                <div className={`overflow-hidden transition-all duration-300 ${faq.isOpen ? 'max-h-96 opacity-100' : 'max-h-0 opacity-0'}`}>
                  <div className="px-6 pb-6">
                    <p className="text-gray-300 leading-relaxed">{faq.answer}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </AnimatedSection>
    </div>
  );
}
