import { useEffect, useState, useCallback, useRef } from 'react';
import {
  Bot,
  ClipboardList,
  SlidersHorizontal,
  Cable,
  ShieldCheck,
  Menu,
  X,
  LogOut,
  Lock,
  RefreshCw,
  Cloud,
  KeyRound,
} from 'lucide-react';
import type { User as FirebaseUser } from 'firebase/auth';
import type {
  AiTradeApproval,
  ConnectionSnapshot,
  DaySessionLevels,
  PublicBusinessConfig,
  StrategySettings,
  TradeLogEntry,
  UserPublicProfile,
  UserSyncBundle,
} from './types/connectivity';
import {
  auth,
  fetchPublicConfigFromFirestore,
  saveUserBundleToFirestore,
  signInWithGooglePopup,
  subscribeFirebaseAuth,
  syncTradesToFirestore,
} from './lib/firebase';
import { ExecutionGateView } from './components/ExecutionGateView';
import { SessionBotView } from './components/SessionBotView';
import { StrategySettingsView } from './components/StrategySettingsView';
import { TradeLogView } from './components/TradeLogView';
import { AuthGateScreen } from './components/AuthGateScreen';
import { AdminDashboard } from './components/AdminDashboard';
import { BrokerConnectionView } from './components/BrokerConnectionView';
import { TopNavBar, type TopNavSection } from './components/TopNavBar';
import { saveM15Candles, loadSavedM15Candles } from './utils/strategyStorage';
import { getLusakaClock } from './utils/strategyEngine';

type NavTab = 'bot' | 'trades' | 'settings' | 'connections' | 'gate';

const NAV_ITEMS: Array<{
  id: NavTab;
  label: string;
  breadcrumb: string;
  icon: typeof Cable;
}> = [
  {
    id: 'bot',
    label: 'Session Bot',
    breadcrumb: 'Daytime Session Bot',
    icon: Bot,
  },
  {
    id: 'trades',
    label: 'Trade Log',
    breadcrumb: 'Trade Log',
    icon: ClipboardList,
  },
  {
    id: 'settings',
    label: 'Strategy Settings',
    breadcrumb: 'Strategy Settings',
    icon: SlidersHorizontal,
  },
  {
    id: 'connections',
    label: 'Broker Connection',
    breadcrumb: 'Broker & Proxy Feed',
    icon: Cable,
  },
  {
    id: 'gate',
    label: 'Auto-Trade Gate',
    breadcrumb: 'Auto-Trade Pre-Flight',
    icon: ShieldCheck,
  },
];

export default function App() {
  const [isAdminRoute, setIsAdminRoute] = useState<boolean>(() =>
    window.location.pathname.startsWith('/admin')
  );
  const [activeTab, setActiveTab] = useState<NavTab>('bot');
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);

  const [authChecked, setAuthChecked] = useState(false);
  const [authUser, setAuthUser] = useState<UserPublicProfile | null>(null);
  const [publicConfig, setPublicConfig] = useState<PublicBusinessConfig | null>(null);
  const [adminAuthenticated, setAdminAuthenticated] = useState(false);
  const [impersonatingUser, setImpersonatingUser] = useState(false);
  const [adminNavTarget, setAdminNavTarget] = useState<{
    section: TopNavSection;
    trigger: number;
  } | null>(null);

  const [snapshot, setSnapshot] = useState<ConnectionSnapshot | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isRefreshing, setIsRefreshing] = useState(false);

  const [nowMs, setNowMs] = useState<number>(() => Date.now());
  const [lastUpdatedMs, setLastUpdatedMs] = useState<number | null>(null);
  const [lastHealthyFeedMs, setLastHealthyFeedMs] = useState<number>(() => Date.now());
  const [consecutivePollFailures, setConsecutivePollFailures] = useState<number>(0);
  const pollInFlightRef = useRef<boolean>(false);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(() => auth.currentUser);
  const autoRestoreAttemptedRef = useRef<string | null>(null);
  const lastCloudSyncSigRef = useRef<string>('');
  const lastCloudSyncAtRef = useRef<number>(0);

  const [showChangePinModal, setShowChangePinModal] = useState(false);
  const [currentPinInput, setCurrentPinInput] = useState('');
  const [newPinInput, setNewPinInput] = useState('');
  const [confirmPinInput, setConfirmPinInput] = useState('');
  const [changePinBusy, setChangePinBusy] = useState(false);
  const [changePinError, setChangePinError] = useState<string | null>(null);
  const [changePinSuccess, setChangePinSuccess] = useState<string | null>(null);

  useEffect(() => {
    const onPopState = () => {
      setIsAdminRoute(window.location.pathname.startsWith('/admin'));
    };
    window.addEventListener('popstate', onPopState);
    return () => window.removeEventListener('popstate', onPopState);
  }, []);

  const navigateAdmin = useCallback((toAdmin: boolean) => {
    const nextPath = toAdmin ? '/admin' : '/';
    if (window.location.pathname !== nextPath) {
      window.history.pushState({}, '', nextPath);
    }
    setIsAdminRoute(toAdmin);
  }, []);

  const openAdminSection = useCallback(
    (section: TopNavSection) => {
      setAdminNavTarget((prev) => ({ section, trigger: (prev?.trigger ?? 0) + 1 }));
      navigateAdmin(true);
    },
    [navigateAdmin]
  );

  const fetchAuthStatus = useCallback(async () => {
    try {
      setLoadError(null);
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      if (!res.ok) throw new Error('Unable to reach Gold AI Trader auth service');
      const json = (await res.json()) as {
        authenticated: boolean;
        adminAuthenticated?: boolean;
        impersonatingUser?: boolean;
        user?: UserPublicProfile;
        config?: PublicBusinessConfig;
      };
      if (json.config) {
        setPublicConfig(json.config);
      } else {
        const fsCfg = await fetchPublicConfigFromFirestore();
        if (fsCfg?.momo && fsCfg?.plans) {
          setPublicConfig({ momo: fsCfg.momo, plans: fsCfg.plans });
        }
      }
      setAdminAuthenticated(Boolean(json.adminAuthenticated));
      setImpersonatingUser(Boolean(json.impersonatingUser));
      setAuthUser(json.authenticated && json.user ? json.user : null);
      if (!json.authenticated) {
        setSnapshot(null);
      }
    } catch (err) {
      const fsCfg = await fetchPublicConfigFromFirestore();
      if (fsCfg?.momo && fsCfg?.plans) {
        setPublicConfig({ momo: fsCfg.momo, plans: fsCfg.plans });
      }
      setLoadError(
        err instanceof Error ? err.message : 'Service temporarily unavailable'
      );
    } finally {
      setAuthChecked(true);
    }
  }, []);

  const fetchUserSnapshot = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = Boolean(opts?.silent);
    if (silent && pollInFlightRef.current) {
      return;
    }
    if (silent) {
      pollInFlightRef.current = true;
    } else {
      setIsRefreshing(true);
    }

    try {
      const res = await fetch('/api/connections/state', {
        cache: 'no-store',
        headers: { 'Cache-Control': 'no-cache' },
      });
      if (res.status === 401) {
        setAuthUser(null);
        setSnapshot(null);
        setLoadError(null);
        return;
      }
      if (!res.ok) {
        throw new Error('Failed to load Gold AI Trader workspace state');
      }
      const next = (await res.json()) as ConnectionSnapshot;
      const now = Date.now();
      setSnapshot(next);
      setLoadError(null);
      setConsecutivePollFailures(0);
      setLastUpdatedMs(now);

      const backendPaused = next.bot?.feedInfo?.status === 'RECONNECTING';
      const hasAnyFreshTick = Boolean(next.latestTick || next.fallbackTick);
      const isWknd = Boolean(next.bot?.isWeekend);
      if (!backendPaused && (hasAnyFreshTick || isWknd)) {
        setLastHealthyFeedMs(now);
      }

      if (next.userProfile) {
        setAuthUser(next.userProfile);
      }
    } catch (err) {
      setConsecutivePollFailures((c) => c + 1);
      if (!silent) {
        setLoadError(
          err instanceof Error ? err.message : 'Connectivity service unavailable'
        );
      }
    } finally {
      if (silent) {
        pollInFlightRef.current = false;
      } else {
        setIsRefreshing(false);
      }
    }
  }, []);

  useEffect(() => {
    if (!isAdminRoute) {
      void fetchAuthStatus();
    }
  }, [isAdminRoute, fetchAuthStatus]);

  useEffect(() => {
    return subscribeFirebaseAuth((fbUser) => {
      setFirebaseUser(fbUser);
      if (!fbUser) {
        autoRestoreAttemptedRef.current = null;
      }
    });
  }, []);

  // Automatically restore user session from Firestore after server restart/redeploy
  useEffect(() => {
    if (isAdminRoute || !authChecked || authUser || !firebaseUser) return;
    if (autoRestoreAttemptedRef.current === firebaseUser.uid) return;
    autoRestoreAttemptedRef.current = firebaseUser.uid;
    let cancelled = false;
    (async () => {
      try {
        const idToken = await firebaseUser.getIdToken();
        const res = await fetch('/api/auth/firebase-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ idToken }),
        });
        if (!res.ok || cancelled) return;
        const json = (await res.json()) as {
          ok?: boolean;
          user?: UserPublicProfile;
        };
        if (json.ok && json.user && !cancelled) {
          setAuthUser(json.user);
        }
      } catch {
        // Ignore silent restore errors; user can log in manually
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isAdminRoute, authChecked, authUser, firebaseUser]);

  // Persist user runtime state & trades to Firestore whenever key state changes
  useEffect(() => {
    if (
      isAdminRoute ||
      impersonatingUser ||
      !authUser ||
      !firebaseUser ||
      !firebaseUser.emailVerified
    ) {
      return;
    }
    const trades = snapshot?.bot?.tradeLog || [];
    const sig = [
      authUser.id,
      authUser.status,
      authUser.balance.toFixed(2),
      authUser.equity.toFixed(2),
      authUser.autoTradeEnabled,
      authUser.brokerName,
      authUser.brokerServer,
      authUser.accountType,
      authUser.brokerSetup?.accountVariant ?? 'STANDARD',
      authUser.brokerSetup?.confirmedAt ?? '',
      authUser.mt5Login,
      trades.length,
      trades[0]?.id || '',
      trades[0]?.status || '',
      trades[0]?.tp1Hit ? 1 : 0,
      snapshot?.bot?.levels?.totalTradesToday ?? 0,
      snapshot?.bot?.settings?.slPips ?? 0,
      snapshot?.bot?.strategyModule ?? 'EMA_STOCHASTIC_PRO',
      snapshot?.bot?.settings?.emaPro?.settingsVersion ?? 1,
      snapshot?.bot?.settings?.riskPercent ?? 0.5,
    ].join('|');

    if (sig === lastCloudSyncSigRef.current) {
      return;
    }

    const flushCloudSync = async () => {
      try {
        lastCloudSyncSigRef.current = sig;
        lastCloudSyncAtRef.current = Date.now();
        const meRes = await fetch('/api/auth/me', { cache: 'no-store' });
        if (!meRes.ok) return;
        const meJson = (await meRes.json()) as { syncBundle?: UserSyncBundle };
        if (!meJson.syncBundle) return;
        const isRootAdmin =
          firebaseUser.email?.toLowerCase() === 'muyobakuyewana@gmail.com';
        await saveUserBundleToFirestore(meJson.syncBundle, {
          asAdmin: isRootAdmin,
        });
        if (meJson.syncBundle.trades.length > 0) {
          const targetTradeUid = isRootAdmin
            ? meJson.syncBundle.ownerId || meJson.syncBundle.appUserId || firebaseUser.uid
            : firebaseUser.uid;
          await syncTradesToFirestore(targetTradeUid, meJson.syncBundle.trades);
        }
      } catch {
        // Non-blocking background persistence
      }
    };

    const elapsed = Date.now() - lastCloudSyncAtRef.current;
    if (elapsed >= 8000) {
      void flushCloudSync();
      return;
    }

    const delayMs = 8000 - elapsed;
    const timer = window.setTimeout(() => {
      void flushCloudSync();
    }, delayMs);
    return () => {
      window.clearTimeout(timer);
    };
  }, [isAdminRoute, impersonatingUser, authUser, firebaseUser, snapshot?.bot]);

  // 1-second live Lusaka clock ticker (runs continuously, including background tabs)
  useEffect(() => {
    if (isAdminRoute) return;
    const clockTimer = window.setInterval(() => {
      setNowMs(Date.now());
    }, 1000);
    return () => {
      window.clearInterval(clockTimer);
    };
  }, [isAdminRoute]);

  useEffect(() => {
    if (isAdminRoute || !authUser || authUser.status !== 'ACTIVE') {
      return;
    }

    void fetchUserSnapshot({ silent: false });

    // Auto-poll every 3 seconds without stopping in background tabs
    const pollTimer = window.setInterval(() => {
      void fetchUserSnapshot({ silent: true });
    }, 3000);

    const source = new EventSource('/api/feed/stream');

    source.addEventListener('status', (evt) => {
      try {
        const next = JSON.parse((evt as MessageEvent).data) as ConnectionSnapshot;
        const now = Date.now();
        setSnapshot(next);
        setLastUpdatedMs(now);
        setConsecutivePollFailures(0);
        if (
          next.bot?.feedInfo?.status !== 'RECONNECTING' &&
          (next.latestTick || next.fallbackTick || next.bot?.isWeekend)
        ) {
          setLastHealthyFeedMs(now);
        }
        if (next.userProfile) {
          setAuthUser(next.userProfile);
        }
      } catch {
        // Ignore malformed SSE chunk
      }
    });

    source.addEventListener('tick', (evt) => {
      try {
        const payload = JSON.parse((evt as MessageEvent).data) as {
          snapshot: ConnectionSnapshot;
        };
        if (payload.snapshot) {
          const now = Date.now();
          setSnapshot(payload.snapshot);
          setLastUpdatedMs(now);
          setConsecutivePollFailures(0);
          if (
            payload.snapshot.bot?.feedInfo?.status !== 'RECONNECTING' &&
            (payload.snapshot.latestTick ||
              payload.snapshot.fallbackTick ||
              payload.snapshot.bot?.isWeekend)
          ) {
            setLastHealthyFeedMs(now);
          }
          if (payload.snapshot.userProfile) {
            setAuthUser(payload.snapshot.userProfile);
          }
        }
      } catch {
        // Ignore malformed SSE chunk
      }
    });

    return () => {
      window.clearInterval(pollTimer);
      source.close();
    };
  }, [isAdminRoute, authUser?.id, authUser?.status, fetchUserSnapshot]);

  // Cache closed real TickerAll M15 candles locally (never fallback)
  useEffect(() => {
    if (snapshot?.bot?.closedCandles && snapshot.bot.closedCandles.length > 0) {
      const existing = loadSavedM15Candles().filter(
        (c) => c.closed && (c.source === 'tickerall' || c.source === 'history')
      );
      const map = new Map(existing.map((c) => [c.openTimeMs, c]));
      for (const c of snapshot.bot.closedCandles) {
        if (c.closed && (c.source === 'tickerall' || c.source === 'history')) {
          map.set(c.openTimeMs, c);
        }
      }
      const merged = Array.from(map.values())
        .sort((a, b) => b.openTimeMs - a.openTimeMs)
        .slice(0, 500);
      saveM15Candles(merged);
    }
  }, [snapshot?.bot?.closedCandles]);

  const handleImpersonateUser = async (userId: string) => {
    const res = await fetch(
      `/api/admin/users/${encodeURIComponent(userId)}/impersonate`,
      { method: 'POST' }
    );
    const json = (await res.json()) as {
      ok?: boolean;
      error?: string;
      user?: UserPublicProfile;
      impersonatingUser?: boolean;
    };
    if (!res.ok || !json.ok || !json.user) {
      throw new Error(json.error || 'Unable to login as selected subscriber');
    }
    setAuthUser(json.user);
    setAdminAuthenticated(true);
    setImpersonatingUser(true);
    setActiveTab('bot');
    setSnapshot(null);
    setAdminNavTarget(null);
    navigateAdmin(false);
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const readJsonSafe = async <T,>(res: Response): Promise<Partial<T>> => {
    try {
      const text = await res.text();
      return text ? (JSON.parse(text) as Partial<T>) : {};
    } catch {
      return {};
    }
  };

  const handleBackToAdmin = async () => {
    try {
      if (impersonatingUser) {
        await fetch('/api/admin/exit-impersonate', { method: 'POST' });
        setImpersonatingUser(false);
        setAuthUser(null);
        setSnapshot(null);
      }
    } catch {
      // Proceed back to admin view even if impersonation exit request fails
    }
    openAdminSection('dashboard');
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/auth/logout', { method: 'POST' });
    } catch {
      // Continue local session reset even on network error
    } finally {
      setAuthUser(null);
      setImpersonatingUser(false);
      setSnapshot(null);
      await fetchAuthStatus();
    }
  };

  const handleSaveStrategySettings = async (
    settings: StrategySettings
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/strategy/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(settings),
      });
      const json = await readJsonSafe<ConnectionSnapshot & { error?: string }>(res);
      if (res.ok) {
        const updated = json as ConnectionSnapshot;
        setSnapshot(updated);
        if (updated.userProfile) setAuthUser(updated.userProfile);
        return { ok: true };
      }
      return {
        ok: false,
        error: json.error || `Failed to save strategy settings (HTTP ${res.status})`,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Network error saving strategy settings',
      };
    }
  };

  const handleSaveLevels = async (
    payload: Partial<DaySessionLevels> & { reset?: boolean }
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/strategy/levels', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = await readJsonSafe<ConnectionSnapshot & { error?: string }>(res);
      if (res.ok) {
        setSnapshot(json as ConnectionSnapshot);
        return { ok: true };
      }
      return {
        ok: false,
        error: json.error || `Failed to update D1 levels (HTTP ${res.status})`,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Network error updating D1 levels',
      };
    }
  };

  const handleLogTrade = async (
    entry: Partial<TradeLogEntry>
  ): Promise<{ ok: boolean; error?: string; approval?: AiTradeApproval }> => {
    try {
      const res = await fetch('/api/trades', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(entry),
      });
      const json = (await readJsonSafe<
        ConnectionSnapshot & {
          ok?: boolean;
          error?: string;
          approval?: AiTradeApproval;
          snapshot?: ConnectionSnapshot;
        }
      >(res)) as ConnectionSnapshot & {
        ok?: boolean;
        error?: string;
        approval?: AiTradeApproval;
        snapshot?: ConnectionSnapshot;
      };
      if (res.ok) {
        setSnapshot(json);
        if (json.userProfile) setAuthUser(json.userProfile);
        return { ok: true, approval: json.bot?.lastAiApproval ?? undefined };
      }
      if (json.snapshot) {
        setSnapshot(json.snapshot);
        if (json.snapshot.userProfile) setAuthUser(json.snapshot.userProfile);
      }
      return {
        ok: false,
        error: json.error || `Trade blocked (HTTP ${res.status})`,
        approval: json.approval,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Network error calling trade gate',
      };
    }
  };

  const handleRunAiApprover = async (): Promise<{
    ok: boolean;
    error?: string;
    approval?: AiTradeApproval;
  }> => {
    try {
      const res = await fetch('/api/ai/approve-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({}),
      });
      const json = await readJsonSafe<{
        ok?: boolean;
        error?: string;
        approval?: AiTradeApproval;
        snapshot?: ConnectionSnapshot;
      }>(res);
      if (json.snapshot) {
        setSnapshot(json.snapshot);
        if (json.snapshot.userProfile) setAuthUser(json.snapshot.userProfile);
      }
      return {
        ok: Boolean(res.ok && json.ok),
        error: json.error,
        approval: json.approval,
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Network error contacting Gemini AI Approver',
      };
    }
  };

  const handleUpdateTradeStatus = async (
    id: string,
    status: TradeLogEntry['status'],
    exitPrice?: number
  ) => {
    try {
      const res = await fetch(`/api/trades/${encodeURIComponent(id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          status,
          ...(exitPrice !== undefined ? { exitPrice } : {}),
        }),
      });
      if (res.ok) {
        const updated = (await res.json()) as ConnectionSnapshot;
        setSnapshot(updated);
        if (updated.userProfile) setAuthUser(updated.userProfile);
      }
    } catch {
      // Next background refresh reconciles server trade state
    }
  };

  const handleDeleteTrade = async (id: string) => {
    try {
      const res = await fetch(`/api/trades/${encodeURIComponent(id)}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        const updated = (await res.json()) as ConnectionSnapshot;
        setSnapshot(updated);
      }
    } catch {
      // Ignore transient network failures
    }
  };

  const handleClearTrades = async () => {
    try {
      const res = await fetch('/api/trades', { method: 'DELETE' });
      if (res.ok) {
        const updated = (await res.json()) as ConnectionSnapshot;
        setSnapshot(updated);
      }
    } catch {
      // Ignore transient network failures
    }
  };

  const handleClearSignals = async () => {
    try {
      const res = await fetch('/api/signals', { method: 'DELETE' });
      if (res.ok) {
        const updated = (await res.json()) as ConnectionSnapshot;
        setSnapshot(updated);
      }
    } catch {
      // Ignore transient network failures
    }
  };

  const handleToggleAutoTrade = async (
    enabled: boolean
  ): Promise<{ ok: boolean; error?: string }> => {
    try {
      const res = await fetch('/api/user/auto-trade', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ enabled }),
      });
      const json = await readJsonSafe<{
        ok?: boolean;
        error?: string;
        user?: UserPublicProfile;
        snapshot?: ConnectionSnapshot;
      }>(res);
      if (json.user) setAuthUser(json.user);
      if (json.snapshot) setSnapshot(json.snapshot);
      return {
        ok: Boolean(res.ok && json.ok),
        error: json.error || (!res.ok ? `Auto-trade request failed (HTTP ${res.status})` : undefined),
      };
    } catch (err) {
      return {
        ok: false,
        error: err instanceof Error ? err.message : 'Network error updating Auto Trade',
      };
    }
  };

  const handleSyncBrokerBalance = async (): Promise<{
    ok: boolean;
    message?: string;
    error?: string;
  }> => {
    try {
      const res = await fetch('/api/user/broker/sync-balance', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const json = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
        user?: UserPublicProfile;
        snapshot?: ConnectionSnapshot;
      };
      if (json.user) setAuthUser(json.user);
      if (json.snapshot) setSnapshot(json.snapshot);
      return {
        ok: Boolean(json.ok),
        message: json.message,
        error: json.error,
      };
    } catch {
      return { ok: false, error: 'Network error syncing broker balance' };
    }
  };

  const handleBotControl = async (payload: {
    action:
      | 'START'
      | 'PAUSE'
      | 'STOP'
      | 'EMERGENCY_STOP'
      | 'CLOSE_ALL'
      | 'SET_MODE'
      | 'SET_DIRECTIONS';
    tradingMode?: 'SIGNALS_ONLY' | 'AUTOMATIC_TRADING' | 'BOTH';
    allowBuy?: boolean;
    allowSell?: boolean;
    confirm?: boolean;
  }): Promise<{ ok: boolean; message?: string; error?: string }> => {
    try {
      const res = await fetch('/api/bot/control', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        message?: string;
        error?: string;
        snapshot?: ConnectionSnapshot;
      };
      if (json.snapshot) {
        setSnapshot(json.snapshot);
        if (json.snapshot.userProfile) {
          setAuthUser(json.snapshot.userProfile);
        }
      }
      return {
        ok: Boolean(res.ok && json.ok),
        message: json.message,
        error: json.error,
      };
    } catch {
      return { ok: false, error: 'Network error updating bot control state' };
    }
  };

  const handleChangePinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setChangePinError(null);
    setChangePinSuccess(null);
    const trimmedNew = newPinInput.trim();
    if (trimmedNew.length < 4 || trimmedNew.length > 128) {
      setChangePinError('New PIN / Password must be at least 4 characters.');
      return;
    }
    if (trimmedNew !== confirmPinInput.trim()) {
      setChangePinError('New PIN / Password and confirmation do not match.');
      return;
    }
    setChangePinBusy(true);
    try {
      const firebaseIdToken =
        !currentPinInput.trim() && auth.currentUser
          ? await auth.currentUser.getIdToken().catch(() => undefined)
          : undefined;
      const res = await fetch('/api/auth/change-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          currentPin: currentPinInput,
          newPin: trimmedNew,
          ...(firebaseIdToken ? { firebaseIdToken } : {}),
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        syncBundle?: UserSyncBundle;
      };
      if (!res.ok || !json.ok) {
        setChangePinError(json.error || 'Unable to change PIN / Password.');
        return;
      }
      if (auth.currentUser && json.syncBundle) {
        try {
          await saveUserBundleToFirestore(json.syncBundle, {
            asAdmin:
              auth.currentUser.email?.toLowerCase() === 'muyobakuyewana@gmail.com',
          });
        } catch {
          // Non-blocking fallback
        }
      }
      setCurrentPinInput('');
      setNewPinInput('');
      setConfirmPinInput('');
      setChangePinSuccess('Your App PIN / Password has been updated.');
    } catch {
      setChangePinError('Network error while updating PIN / Password.');
    } finally {
      setChangePinBusy(false);
    }
  };

  if (isAdminRoute) {
    return (
      <AdminDashboard
        onBackToUserApp={() => {
          setAdminNavTarget(null);
          navigateAdmin(false);
          void fetchAuthStatus();
        }}
        onImpersonateUser={handleImpersonateUser}
        onAdminAuthChange={setAdminAuthenticated}
        onGoSubscriberSettings={
          authUser && authUser.status === 'ACTIVE'
            ? () => {
                setAdminNavTarget(null);
                navigateAdmin(false);
                setActiveTab('settings');
                window.scrollTo({ top: 0, behavior: 'smooth' });
              }
            : undefined
        }
        initialSection={adminNavTarget?.section ?? null}
        sectionTrigger={adminNavTarget?.trigger ?? 0}
      />
    );
  }

  if (!authChecked) {
    return (
      <div className="min-h-screen bg-[#0B0F17] text-slate-300 flex items-center justify-center text-xs">
        Loading Gold AI Trader session...
      </div>
    );
  }

  if (!authUser || authUser.status !== 'ACTIVE') {
    return (
      <div className="min-h-screen bg-[#0B0F17] flex flex-col">
        <TopNavBar
          activeSection="dashboard"
          onSelectDashboard={() => {
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          onSelectMasterFeed={() => openAdminSection('master-feed')}
          onSelectSubscribers={() => openAdminSection('subscribers')}
          onSelectSettings={() => openAdminSection('settings')}
          showBackToAdmin={Boolean(adminAuthenticated || impersonatingUser)}
          impersonatedUserName={impersonatingUser ? authUser?.fullName ?? null : null}
          onBackToAdmin={() => void handleBackToAdmin()}
        />
        <div className="flex-1">
          <AuthGateScreen
            loggedInUser={authUser}
            publicConfig={publicConfig}
            onAuthenticated={async (user) => {
              setAuthUser(user);
              if (user.status === 'ACTIVE') {
                await fetchUserSnapshot();
              }
            }}
            onRefreshSession={fetchAuthStatus}
            onLogout={handleLogout}
            onNavigateAdmin={() => openAdminSection('dashboard')}
            isImpersonating={impersonatingUser}
            onBackToAdmin={() => void handleBackToAdmin()}
          />
        </div>
      </div>
    );
  }

  const currentNav = NAV_ITEMS.find((n) => n.id === activeTab) || NAV_ITEMS[0];
  const liveLusakaClock = getLusakaClock(nowMs);
  const isWeekend = snapshot?.bot?.isWeekend ?? liveLusakaClock.isWeekend;
  const weekendDayUpper = (
    snapshot?.bot?.lusakaWeekday ?? liveLusakaClock.weekday
  ).toUpperCase();
  const feedInfo = snapshot?.bot?.feedInfo;
  const autoLot = snapshot?.bot?.autoLotInfo;
  const isUscUnit =
    authUser.brokerSetup?.accountVariant === 'CENT_USC' ||
    snapshot?.bot?.symbolSpec?.currency === 'USC';

  const feedPausedReconnecting = Boolean(
    !isWeekend &&
      authUser.feedAccess &&
      (feedInfo?.status === 'RECONNECTING' ||
        (consecutivePollFailures > 0 && nowMs - lastHealthyFeedMs >= 15_000) ||
        (lastUpdatedMs !== null &&
          nowMs - lastHealthyFeedMs >= 15_000 &&
          !snapshot?.latestTick &&
          !snapshot?.fallbackTick))
  );
  const lastUpdatedClock = getLusakaClock(lastUpdatedMs ?? nowMs);
  const secondsSinceUpdate = lastUpdatedMs !== null ? Math.max(0, Math.floor((nowMs - lastUpdatedMs) / 1000)) : 0;

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col">
      <TopNavBar
        activeSection={activeTab === 'settings' ? 'settings' : 'dashboard'}
        onSelectDashboard={() => {
          setActiveTab('bot');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
        onSelectMasterFeed={() => openAdminSection('master-feed')}
        onSelectSubscribers={() => openAdminSection('subscribers')}
        onSelectSettings={() => {
          setActiveTab('settings');
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }}
        showBackToAdmin={Boolean(adminAuthenticated || impersonatingUser)}
        impersonatedUserName={impersonatingUser ? authUser.fullName : null}
        onBackToAdmin={() => void handleBackToAdmin()}
        onToggleMobileMenu={() => setMobileMenuOpen((v) => !v)}
      />

      <div className="flex-1 flex min-h-0">
        {/* Mobile Sidebar Backdrop */}
        {mobileMenuOpen && (
          <div
            className="fixed inset-0 z-40 bg-black/60 lg:hidden"
            onClick={() => setMobileMenuOpen(false)}
          />
        )}

        {/* Left Sidebar (256px) */}
        <aside
          className={`fixed inset-y-0 left-0 z-50 w-[256px] bg-[#0E131D] border-r border-white/8 flex flex-col justify-between transition-transform duration-150 lg:static lg:translate-x-0 ${
            mobileMenuOpen ? 'translate-x-0' : '-translate-x-full'
          }`}
        >
        <div>
          <div className="h-16 px-5 border-b border-white/8 flex items-center justify-between">
            <a
              href="/"
              onClick={(e) => {
                e.preventDefault();
                setActiveTab('bot');
              }}
              className="flex flex-col leading-tight"
            >
              <span className="font-display text-base font-bold tracking-tight text-[#E5B85C] whitespace-nowrap">
                Gold AI Trader
              </span>
              <span className="text-[10px] uppercase tracking-wider text-slate-400">
                EMA STOCHASTIC PRO · XAUUSD
              </span>
            </a>
            <button
              type="button"
              aria-label="Close navigation"
              onClick={() => setMobileMenuOpen(false)}
              className="lg:hidden p-1.5 text-slate-400 hover:text-white"
            >
              <X className="w-4 h-4" />
            </button>
          </div>

          <nav aria-label="Workspace Sections" className="p-3 space-y-1">
            {NAV_ITEMS.map((item) => {
              const Icon = item.icon;
              const active = activeTab === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    setActiveTab(item.id);
                    setMobileMenuOpen(false);
                  }}
                  className={`w-full flex items-center gap-3 px-3 py-2.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-[#D4A853]/12 text-[#E5B85C]'
                      : 'text-slate-400 hover:text-slate-100 hover:bg-white/[0.04]'
                  }`}
                >
                  <Icon className="w-4 h-4 shrink-0" />
                  <span className="truncate">{item.label}</span>
                </button>
              );
            })}
          </nav>
        </div>

        {/* Bottom Subscriber Account Summary */}
        <div className="p-4 border-t border-white/8 text-xs space-y-2">
          <div className="flex items-center justify-between text-slate-400">
            <span>Trader</span>
            <span className="text-slate-200 font-medium truncate max-w-[130px]">
              {authUser.fullName}
            </span>
          </div>
          <div className="flex items-center justify-between text-slate-400">
            <span>Plan</span>
            <span className="font-mono text-[#E5B85C]">
              {authUser.planLabel} ({authUser.daysLeft}d left)
            </span>
          </div>
          <div className="flex items-center justify-between text-slate-400">
            <span>Broker</span>
            <span className="font-mono text-slate-200 truncate max-w-[125px]">
              {authUser.brokerConnected ? authUser.brokerName : 'Disconnected'}
            </span>
          </div>
          <div className="flex items-center justify-between text-slate-400">
            <span>Balance</span>
            <span className="font-mono text-emerald-300 font-semibold">
              {isUscUnit
                ? `${authUser.balance.toFixed(2)} USC`
                : `$${authUser.balance.toFixed(2)}`}
            </span>
          </div>
          {!authUser.firebaseLinked && !impersonatingUser && (
            <button
              type="button"
              onClick={async () => {
                try {
                  const { idToken } = await signInWithGooglePopup();
                  const res = await fetch('/api/auth/firebase-sync', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ idToken }),
                  });
                  const json = (await res.json()) as {
                    ok?: boolean;
                    user?: UserPublicProfile;
                    syncBundle?: UserSyncBundle;
                  };
                  if (json.ok && json.user) {
                    setAuthUser(json.user);
                    if (json.syncBundle) {
                      await saveUserBundleToFirestore(json.syncBundle, {
                        asAdmin:
                          auth.currentUser?.email?.toLowerCase() ===
                          'muyobakuyewana@gmail.com',
                      });
                    }
                  }
                } catch {
                  // Ignore popup cancel
                }
              }}
              className="w-full inline-flex items-center justify-center gap-1.5 px-2.5 py-1.5 rounded border border-sky-500/35 bg-sky-500/10 text-sky-200 text-[11px] font-medium hover:bg-sky-500/20"
            >
              <Cloud className="w-3 h-3" />
              Link Google Cloud Backup
            </button>
          )}
          <div className="pt-2 border-t border-white/6 flex items-center justify-between gap-2">
            <a
              href="/admin"
              onClick={(e) => {
                e.preventDefault();
                navigateAdmin(true);
              }}
              className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-[#E5B85C]"
            >
              <Lock className="w-3 h-3" />
              Admin
            </a>
            <button
              type="button"
              onClick={() => {
                setShowChangePinModal(true);
                setChangePinError(null);
                setChangePinSuccess(null);
              }}
              className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-[#E5B85C]"
            >
              <KeyRound className="w-3 h-3" />
              Change PIN
            </button>
            <button
              type="button"
              onClick={() => void handleLogout()}
              className="inline-flex items-center gap-1 text-[11px] text-slate-400 hover:text-red-300"
            >
              <LogOut className="w-3 h-3" />
              Logout
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content Shell */}
      <div className="flex-1 min-w-0 flex flex-col">
        {/* Top Subscriber Status Bar: Trader Name, Plan, Days Left, Balance, Auto Lot, Feed Status */}
        <header className="min-h-14 px-4 sm:px-6 py-2 border-b border-white/8 bg-[#0E131D]/90 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3 min-w-0">
            <button
              type="button"
              aria-label="Open navigation"
              onClick={() => setMobileMenuOpen(true)}
              className="lg:hidden p-2 -ml-2 text-slate-300 hover:text-white"
            >
              <Menu className="w-4 h-4" />
            </button>
            <div className="flex items-center gap-2 text-xs sm:text-sm truncate">
              <span className="font-semibold text-slate-100 truncate">
                {authUser.fullName}
              </span>
              <span className="px-2 py-0.5 rounded border border-[#D4A853]/35 bg-[#D4A853]/10 text-[11px] font-mono text-[#E5B85C] shrink-0">
                {authUser.planLabel} · {authUser.daysLeft}d left
              </span>
              <span className="text-slate-600 hidden md:inline" aria-hidden="true">
                /
              </span>
              <span className="text-xs text-slate-400 hidden md:inline truncate">
                {currentNav.breadcrumb}
              </span>
            </div>
          </div>

          <div className="flex flex-wrap items-center gap-2.5 shrink-0">
            {/* Auto Lot Progress Readout */}
            <div className="hidden xl:flex items-center gap-3 px-3 py-1.5 rounded-md border border-white/10 bg-[#111722] text-xs font-mono tabular-nums">
              <span className="text-[#E5B85C] font-semibold">
                Auto Lot: {(autoLot?.effectiveLot ?? 0.01).toFixed(2)}
              </span>
              <span className="text-white/15">|</span>
              <span className="text-slate-200">
                Bal:{' '}
                {isUscUnit
                  ? `${authUser.balance.toFixed(2)} USC`
                  : `$${authUser.balance.toFixed(2)}`}
              </span>
              {autoLot?.nextTierBalance && (
                <>
                  <span className="text-white/15">|</span>
                  <span className="text-slate-400">
                    Next ({autoLot.nextTierLot?.toFixed(2)} lots) @{' '}
                    {isUscUnit
                      ? `${autoLot.nextTierBalance} USC`
                      : `$${autoLot.nextTierBalance}`}
                  </span>
                </>
              )}
            </div>

            {/* Live Auto-Refresh Indicator */}
            <div className="hidden md:flex items-center gap-1.5 px-2.5 py-1.5 rounded-md border border-white/10 bg-[#111722] text-[11px] font-mono tabular-nums text-slate-300">
              <span
                className={`inline-block w-1.5 h-1.5 rounded-full ${
                  feedPausedReconnecting ? 'bg-amber-400 animate-pulse' : 'bg-emerald-400'
                }`}
              />
              <span>
                Last Updated: {lastUpdatedClock.timeLusaka} - Auto-refresh every 3s ({secondsSinceUpdate}s)
              </span>
            </div>

            {/* Proxy Feed Live / Offline / Reconnecting Badge */}
            <div
              title={feedPausedReconnecting ? 'Feed Paused - Reconnecting...' : feedInfo?.message}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-md border text-xs font-mono font-semibold whitespace-nowrap ${
                feedPausedReconnecting
                  ? 'border-amber-500/40 bg-amber-950/35 text-amber-200'
                  : feedInfo?.isLive
                    ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                    : 'border-red-500/35 bg-red-950/30 text-red-300'
              }`}
            >
              {feedPausedReconnecting
                ? 'Feed Paused - Reconnecting...'
                : feedInfo?.label ?? 'Feed Offline ●'}
            </div>

            <button
              type="button"
              onClick={() => void fetchUserSnapshot({ silent: false })}
              disabled={isRefreshing}
              title="Manual backup refresh (auto-refreshes every 3s)"
              className="inline-flex items-center gap-1 px-2.5 py-1.5 text-xs font-medium rounded-md border border-white/12 bg-[#111722] text-slate-200 hover:bg-white/5 disabled:opacity-40 transition-colors"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${isRefreshing ? 'animate-spin' : ''}`} />
            </button>

            <button
              type="button"
              onClick={() => void handleLogout()}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-white/12 bg-[#111722] text-slate-300 hover:text-white transition-colors"
            >
              <LogOut className="w-3.5 h-3.5" />
              Logout
            </button>
          </div>
        </header>

        {isWeekend && (
          <div
            role="status"
            className="px-4 sm:px-6 py-3 border-b border-amber-500/40 bg-amber-950/35 text-center"
          >
            <p className="text-xs sm:text-sm font-display font-bold tracking-wide text-amber-200">
              {weekendDayUpper} - MARKET CLOSED - BACKTEST MODE ONLY - NO LIVE TRADING
            </p>
          </div>
        )}

        {/* Main Viewport */}
        <main className="flex-1 p-4 sm:p-6 max-w-[1440px] w-full mx-auto">
          {loadError ? (
            <div className="border border-red-500/30 bg-red-950/20 rounded-lg p-6 text-center">
              <p className="text-sm font-semibold text-red-200">
                Unable to reach Gold AI Trader service
              </p>
              <p className="mt-1 text-xs text-red-300/80 font-mono">
                {loadError}
              </p>
              <button
                type="button"
                onClick={() => void fetchUserSnapshot()}
                className="mt-4 px-4 py-2 text-xs font-medium rounded-md bg-[#D4A853] text-[#0B0F17] hover:bg-[#E0B866] transition-colors"
              >
                Retry Connection
              </button>
            </div>
          ) : !snapshot ? (
            /* Loading Skeleton matching layout geometry */
            <div className="space-y-6 animate-pulse">
              <div className="h-[100px] border border-white/8 bg-[#111722] rounded-lg" />
              <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
                <div className="lg:col-span-5 h-[480px] border border-white/8 bg-[#111722] rounded-lg" />
                <div className="lg:col-span-7 h-[480px] border border-white/8 bg-[#111722] rounded-lg" />
              </div>
            </div>
          ) : (
            <>
              {activeTab === 'bot' && (
                <SessionBotView
                  snapshot={snapshot}
                  user={authUser}
                  nowMs={nowMs}
                  lastUpdatedMs={lastUpdatedMs}
                  feedPausedReconnecting={feedPausedReconnecting}
                  isProbing={isRefreshing}
                  onRunProbe={() => void fetchUserSnapshot({ silent: false })}
                  onLogTrade={handleLogTrade}
                  onRunAiApprover={handleRunAiApprover}
                  onSaveSettings={handleSaveStrategySettings}
                  onToggleAutoTrade={handleToggleAutoTrade}
                  onSyncBrokerBalance={handleSyncBrokerBalance}
                  onBotControl={handleBotControl}
                  onNavigateTab={(tab) => setActiveTab(tab)}
                />
              )}

              {activeTab === 'trades' && (
                <TradeLogView
                  snapshot={snapshot}
                  onLogTrade={handleLogTrade}
                  onUpdateTradeStatus={handleUpdateTradeStatus}
                  onDeleteTrade={handleDeleteTrade}
                  onClearTrades={handleClearTrades}
                  onClearSignals={handleClearSignals}
                />
              )}

              {activeTab === 'settings' && (
                <StrategySettingsView
                  snapshot={snapshot}
                  onSaveSettings={handleSaveStrategySettings}
                  onSaveLevels={handleSaveLevels}
                />
              )}

              {activeTab === 'connections' && (
                <BrokerConnectionView
                  user={authUser}
                  snapshot={snapshot}
                  onUserUpdated={(updatedUser, updatedSnapshot) => {
                    setAuthUser(updatedUser);
                    setSnapshot(updatedSnapshot);
                  }}
                />
              )}

              {activeTab === 'gate' && (
                <ExecutionGateView
                  snapshot={snapshot}
                  user={authUser}
                  onBotControl={handleBotControl}
                  onNavigateConnections={() => setActiveTab('connections')}
                />
              )}
            </>
          )}
        </main>
      </div>
      </div>

      {showChangePinModal && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setShowChangePinModal(false)}
        >
          <div
            className="max-w-md w-full bg-[#111722] border border-white/15 rounded-xl p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/8 pb-3">
              <h3 className="text-sm font-semibold text-[#E5B85C] flex items-center gap-1.5">
                <KeyRound className="w-4 h-4" />
                Change App PIN / Password
              </h3>
              <button
                type="button"
                onClick={() => setShowChangePinModal(false)}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {changePinError && (
              <div className="p-2.5 rounded border border-red-500/35 bg-red-950/25 text-xs text-red-300">
                {changePinError}
              </div>
            )}
            {changePinSuccess && (
              <div className="p-2.5 rounded border border-emerald-500/35 bg-emerald-950/25 text-xs text-emerald-300">
                {changePinSuccess}
              </div>
            )}

            <form onSubmit={handleChangePinSubmit} className="space-y-3">
              <label className="block text-xs">
                <span className="text-slate-300">
                  Current PIN / Password
                  {authUser.firebaseLinked ? ' (or leave blank if signed in with Google)' : ''}
                </span>
                <input
                  type="password"
                  required={!authUser.firebaseLinked}
                  placeholder="Enter current PIN / password"
                  value={currentPinInput}
                  onChange={(e) => setCurrentPinInput(e.target.value)}
                  className="mt-1.5 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>

              <label className="block text-xs">
                <span className="text-slate-300">New PIN / Password (min 4 chars)</span>
                <input
                  type="password"
                  required
                  minLength={4}
                  placeholder="Enter new PIN or password"
                  value={newPinInput}
                  onChange={(e) => setNewPinInput(e.target.value)}
                  className="mt-1.5 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>

              <label className="block text-xs">
                <span className="text-slate-300">Confirm New PIN / Password</span>
                <input
                  type="password"
                  required
                  minLength={4}
                  placeholder="Repeat new PIN or password"
                  value={confirmPinInput}
                  onChange={(e) => setConfirmPinInput(e.target.value)}
                  className="mt-1.5 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>

              <div className="flex justify-end gap-2 pt-1">
                <button
                  type="button"
                  onClick={() => setShowChangePinModal(false)}
                  className="px-3 py-2 rounded border border-white/12 text-xs text-slate-300 hover:text-white"
                >
                  Close
                </button>
                <button
                  type="submit"
                  disabled={changePinBusy}
                  className="px-4 py-2 rounded bg-[#D4A853] text-[#0B0F17] text-xs font-bold hover:bg-[#E0B866] disabled:opacity-50"
                >
                  {changePinBusy ? 'Updating...' : 'Save New PIN'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
