interface MobileBottomNavProps {
  onOpenLeftSidebar: () => void;
  onOpenRightSidebar: () => void;
  showInput: boolean;
  children?: React.ReactNode;
}

export default function MobileBottomNav({ 
  onOpenLeftSidebar, 
  onOpenRightSidebar, 
  showInput,
  children 
}: MobileBottomNavProps) {
  return (
    <div className="md:hidden fixed bottom-0 left-0 right-0 bg-gray-900/95 backdrop-blur-xl border-t border-white/10 z-30" style={{ paddingBottom: 'env(safe-area-inset-bottom)' }}>
      {/* Chat Input Section */}
      {showInput && (
        <div className="px-3 pt-3 pb-2 border-b border-white/5">
          {children}
        </div>
      )}

      {/* Navigation Bar */}
      <div className="flex items-center justify-around py-2 px-4">
        {/* Settings/Model Button */}
        <button
          onClick={onOpenLeftSidebar}
          className="flex flex-col items-center justify-center gap-1 px-4 py-2 rounded-lg active:bg-white/10 transition-colors min-w-[80px]"
        >
          <svg 
            xmlns="http://www.w3.org/2000/svg" 
            className="h-6 w-6 text-pink-400" 
            fill="none" 
            viewBox="0 0 24 24" 
            stroke="currentColor"
          >
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              strokeWidth={2} 
              d="M10.325 4.317c.426-1.756 2.924-1.756 3.35 0a1.724 1.724 0 002.573 1.066c1.543-.94 3.31.826 2.37 2.37a1.724 1.724 0 001.065 2.572c1.756.426 1.756 2.924 0 3.35a1.724 1.724 0 00-1.066 2.573c.94 1.543-.826 3.31-2.37 2.37a1.724 1.724 0 00-2.572 1.065c-.426 1.756-2.924 1.756-3.35 0a1.724 1.724 0 00-2.573-1.066c-1.543.94-3.31-.826-2.37-2.37a1.724 1.724 0 00-1.065-2.572c-1.756-.426-1.756-2.924 0-3.35a1.724 1.724 0 001.066-2.573c-.94-1.543.826-3.31 2.37-2.37.996.608 2.296.07 2.572-1.065z" 
            />
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              strokeWidth={2} 
              d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" 
            />
          </svg>
          <span className="text-xs text-gray-300">Settings</span>
        </button>

        {/* Divider */}
        <div className="h-10 w-px bg-white/10" />

        {/* History/Memories Button */}
        <button
          onClick={onOpenRightSidebar}
          className="flex flex-col items-center justify-center gap-1 px-4 py-2 rounded-lg active:bg-white/10 transition-colors min-w-[80px]"
        >
          <svg 
            xmlns="http://www.w3.org/2000/svg" 
            className="h-6 w-6 text-purple-400" 
            fill="none" 
            viewBox="0 0 24 24" 
            stroke="currentColor"
          >
            <path 
              strokeLinecap="round" 
              strokeLinejoin="round" 
              strokeWidth={2} 
              d="M12 8v4l3 3m6-3a9 9 0 11-18 0 9 9 0 0118 0z" 
            />
          </svg>
          <span className="text-xs text-gray-300">History</span>
        </button>
      </div>
    </div>
  );
}
