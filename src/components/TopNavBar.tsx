import { ArrowLeft, Menu } from 'lucide-react';

export type TopNavSection = 'dashboard' | 'master-feed' | 'subscribers' | 'settings';

interface TopNavBarProps {
  activeSection: TopNavSection;
  onSelectDashboard: () => void;
  onSelectMasterFeed: () => void;
  onSelectSubscribers: () => void;
  onSelectSettings: () => void;
  showBackToAdmin?: boolean;
  impersonatedUserName?: string | null;
  onBackToAdmin?: () => void;
  onToggleMobileMenu?: () => void;
}

export function TopNavBar({
  activeSection,
  onSelectDashboard,
  onSelectMasterFeed,
  onSelectSubscribers,
  onSelectSettings,
  showBackToAdmin = false,
  impersonatedUserName = null,
  onBackToAdmin,
  onToggleMobileMenu,
}: TopNavBarProps) {
  const btnBase =
    'min-h-[44px] px-3.5 py-2 rounded-lg border text-xs sm:text-sm font-semibold flex items-center justify-center gap-2 transition-all cursor-pointer select-none';

  return (
    <nav
      aria-label="Global Quick Navigation"
      className="sticky top-0 z-30 border-b border-white/12 bg-[#0B0F17]/95 backdrop-blur-md px-3 sm:px-6 py-2.5"
    >
      <div className="max-w-[1440px] mx-auto flex flex-col gap-2">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-2 min-w-0">
            {onToggleMobileMenu && (
              <button
                type="button"
                aria-label="Open navigation menu"
                onClick={onToggleMobileMenu}
                className="lg:hidden min-h-[44px] min-w-[44px] inline-flex items-center justify-center rounded-lg border border-white/15 bg-[#111722] text-slate-200 hover:text-white hover:border-[#D4A853]/50"
              >
                <Menu className="w-5 h-5" />
              </button>
            )}
            <span className="font-display text-sm sm:text-base font-bold text-[#E5B85C] truncate">
              Gold AI Trader
            </span>
          </div>

          {showBackToAdmin && onBackToAdmin && (
            <button
              type="button"
              onClick={onBackToAdmin}
              className="min-h-[40px] inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-amber-400 text-[#0B0F17] text-xs sm:text-sm font-bold hover:bg-amber-300 shadow-sm whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="w-4 h-4" />
              Back to Admin{impersonatedUserName ? ` (${impersonatedUserName})` : ''}
            </button>
          )}
        </div>

        {/* Always-Visible 4 Big Tappable Buttons (Mobile + Desktop) */}
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
          <button
            type="button"
            onClick={onSelectDashboard}
            className={`${btnBase} ${
              activeSection === 'dashboard'
                ? 'border-[#D4A853] bg-[#D4A853]/20 text-[#E5B85C]'
                : 'border-white/12 bg-[#111722] text-slate-200 hover:border-[#D4A853]/50 hover:text-white'
            }`}
          >
            <span aria-hidden="true">🏠</span>
            <span>Dashboard</span>
          </button>

          <button
            type="button"
            onClick={onSelectMasterFeed}
            className={`${btnBase} ${
              activeSection === 'master-feed'
                ? 'border-yellow-400 bg-yellow-400/20 text-yellow-200'
                : 'border-white/12 bg-[#111722] text-slate-200 hover:border-yellow-400/60 hover:text-yellow-200'
            }`}
          >
            <span aria-hidden="true">📡</span>
            <span>Master Feed</span>
          </button>

          <button
            type="button"
            onClick={onSelectSubscribers}
            className={`${btnBase} ${
              activeSection === 'subscribers'
                ? 'border-[#D4A853] bg-[#D4A853]/20 text-[#E5B85C]'
                : 'border-white/12 bg-[#111722] text-slate-200 hover:border-[#D4A853]/50 hover:text-white'
            }`}
          >
            <span aria-hidden="true">👥</span>
            <span>Subscribers / Test Accounts</span>
          </button>

          <button
            type="button"
            onClick={onSelectSettings}
            className={`${btnBase} ${
              activeSection === 'settings'
                ? 'border-[#D4A853] bg-[#D4A853]/20 text-[#E5B85C]'
                : 'border-white/12 bg-[#111722] text-slate-200 hover:border-[#D4A853]/50 hover:text-white'
            }`}
          >
            <span aria-hidden="true">⚙️</span>
            <span>Settings</span>
          </button>
        </div>
      </div>
    </nav>
  );
}
