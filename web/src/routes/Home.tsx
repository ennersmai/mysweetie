export default function Home() {
  return (
    <section className="relative overflow-hidden rounded-2xl border border-white/10 bg-white/5 p-10 shadow-2xl backdrop-blur">
      <div className="pointer-events-none absolute inset-0 bg-[radial-gradient(ellipse_at_top,_var(--tw-gradient-stops))] from-pink-500/20 via-fuchsia-500/10 to-transparent" />
      <div className="relative">
        <h2 className="mb-3 text-3xl font-semibold tracking-tight text-white">Welcome to <span className="bg-gradient-to-r from-pink-500 via-fuchsia-500 to-purple-500 bg-clip-text text-transparent">mysweetie.ai</span></h2>
        <p className="max-w-2xl text-gray-300">
          Premium AI companions with streaming voice. Choose your muse and dive into an immersive, responsive chat experience.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <a href="/characters" className="rounded-full bg-gradient-to-r from-pink-500 to-purple-600 px-5 py-2 text-white shadow transition hover:brightness-110">Explore Characters</a>
          <a href="/subscribe" className="rounded-full border border-white/20 px-5 py-2 text-white/80 transition hover:bg-white/10">Upgrade</a>
        </div>
      </div>
    </section>
  );
}


