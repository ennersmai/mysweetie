import AnimatedSection from '../components/AnimatedSection';

export default function Home() {
  return (
    <AnimatedSection className="p-10">
      <div className="relative">
        <h2 className="mb-3 text-3xl font-semibold tracking-tight text-white drop-shadow-lg">Welcome to <span className="bg-gradient-to-r from-pink-500 via-fuchsia-500 to-purple-500 bg-clip-text text-transparent">mysweetie.ai</span></h2>
        <p className="max-w-2xl text-gray-100 drop-shadow">
          Premium AI companions with streaming voice. Choose your muse and dive into an immersive, responsive chat experience.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a href="/characters" className="rounded-full bg-gradient-to-r from-pink-500 to-purple-600 px-5 py-2 text-white shadow-lg transition hover:brightness-110 hover:shadow-pink-500/25">Explore Characters</a>
          <a href="/subscribe" className="rounded-full border border-white/30 bg-white/10 px-5 py-2 text-white backdrop-blur transition hover:bg-white/20">Upgrade</a>
        </div>
      </div>
    </AnimatedSection>
  );
}


