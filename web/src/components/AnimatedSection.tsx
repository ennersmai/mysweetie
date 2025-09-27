import type { ReactNode } from 'react';

interface AnimatedSectionProps {
  children: ReactNode;
  className?: string;
  variant?: 'default' | 'subtle';
}

export default function AnimatedSection({ 
  children, 
  className = '', 
  variant = 'subtle' 
}: AnimatedSectionProps) {
  const gradientClass = variant === 'subtle' ? 'animated-gradient-subtle' : 'animated-gradient';
  
  return (
    <section className={`relative overflow-hidden rounded-2xl border border-white/10 backdrop-blur shadow-2xl ${gradientClass} ${className}`}>
      {/* Content overlay for better readability */}
      <div className="relative bg-black/20 backdrop-blur-sm">
        <div className="relative bg-white/5 backdrop-blur">
          {children}
        </div>
      </div>
    </section>
  );
}
