import { useState, useEffect, useCallback, useRef } from 'react';
import {
  ShieldCheck,
  KeyRound,
  Users,
  Activity,
  CheckCircle2,
  XCircle,
  Ban,
  Pause,
  Play,
  CalendarPlus,
  LogOut,
  ArrowLeft,
  Save,
  Eye,
  X,
  Search,
  UserCheck,
  Radio,
  ArrowRight,
  Cloud,
  Copy,
  Check,
  UserPlus,
} from 'lucide-react';
import type { User as FirebaseUser } from 'firebase/auth';
import type {
  AdminDashboardData,
  MasterConfigSyncBundle,
  MoMoConfig,
  PlanPricing,
  SpreadSensitivity,
  UserSyncBundle,
} from '../types/connectivity';
import { TopNavBar, type TopNavSection } from './TopNavBar';
import {
  auth,
  ensureAdminDocExists,
  fetchAllUsersFromFirestoreForAdmin,
  formatFirestoreErrorForUi,
  saveAdminMasterConfigToFirestore,
  saveAdminPublicConfigToFirestore,
  saveUserBundleToFirestore,
  signInWithGooglePopup,
  subscribeFirebaseAuth,
  syncTradesToFirestore,
} from '../lib/firebase';

interface AdminDashboardProps {
  onBackToUserApp: () => void;
  onImpersonateUser: (userId: string) => Promise<void>;
  onAdminAuthChange?: (authed: boolean) => void;
  onGoSubscriberSettings?: () => void;
  initialSection?: TopNavSection | null;
  sectionTrigger?: number;
}

type SubscriberFilter = 'ALL' | 'PENDING' | 'APPROVED' | 'TEST';

export function AdminDashboard({
  onBackToUserApp,
  onImpersonateUser,
  onAdminAuthChange,
  onGoSubscriberSettings,
  initialSection = null,
  sectionTrigger = 0,
}: AdminDashboardProps) {
  const [authenticated, setAuthenticated] = useState<boolean | null>(null);
  const [password, setPassword] = useState('');
  const [authError, setAuthError] = useState<string | null>(null);
  const [dashboard, setDashboard] = useState<AdminDashboardData | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [activeNavSection, setActiveNavSection] = useState<TopNavSection>(
    initialSection && initialSection !== 'dashboard' ? initialSection : 'dashboard'
  );
  const [highlightMasterFeed, setHighlightMasterFeed] = useState(false);
  const [searchQuery, setSearchQuery] = useState('');
  const [userFilter, setUserFilter] = useState<SubscriberFilter>('ALL');
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(() => auth.currentUser);
  const [cloudSyncing, setCloudSyncing] = useState(false);
  const [cloudSyncedAt, setCloudSyncedAt] = useState<string | null>(null);
  const autoSyncedAdminUidRef = useRef<string | null>(null);

  const masterFeedRef = useRef<HTMLDivElement | null>(null);
  const subscribersRef = useRef<HTMLDivElement | null>(null);
  const settingsRef = useRef<HTMLDivElement | null>(null);
  const highlightTimerRef = useRef<number | null>(null);

  const [previewScreenshot, setPreviewScreenshot] = useState<{
    name: string;
    url: string;
    txId: string;
  } | null>(null);

  // Admin config fields (write-only for keys/passwords!)
  const [tickerAllApiKey, setTickerAllApiKey] = useState('');
  const [baseUrl, setBaseUrl] = useState('https://api.tickerall.com');
  const [brokerServer, setBrokerServer] = useState('');
  const [mt5AccountNumber, setMt5AccountNumber] = useState('');
  const [mt5Password, setMt5Password] = useState('');

  const [airtelNumber, setAirtelNumber] = useState('');
  const [mtnNumber, setMtnNumber] = useState('');
  const [recipientName, setRecipientName] = useState('');
  const [whatsappRenewNumber, setWhatsappRenewNumber] = useState('');
  const [weeklyKwacha, setWeeklyKwacha] = useState(150);
  const [weeklyUsd, setWeeklyUsd] = useState(5);
  const [monthlyKwacha, setMonthlyKwacha] = useState(500);
  const [monthlyUsd, setMonthlyUsd] = useState(20);
  const [quarterlyKwacha, setQuarterlyKwacha] = useState(1200);
  const [quarterlyUsd, setQuarterlyUsd] = useState(45);
  const [newAdminPassword, setNewAdminPassword] = useState('');

  // Dynamic Spread Policy (Admin Configurable)
  const [maxSpreadPoints, setMaxSpreadPoints] = useState(80);
  const [spreadSensitivity, setSpreadSensitivity] = useState<SpreadSensitivity>('BALANCED');
  const [allowHighSpreadTrades, setAllowHighSpreadTrades] = useState(false);
  const [spreadCommissionPerLot, setSpreadCommissionPerLot] = useState(0);
  const [spreadSlippagePoints, setSpreadSlippagePoints] = useState(5);
  const [spreadMaxQuoteAgeSeconds, setSpreadMaxQuoteAgeSeconds] = useState(15);
  const [spreadMinNetRr, setSpreadMinNetRr] = useState(1.6);
  const [spreadDefaultSymbol, setSpreadDefaultSymbol] = useState('XAUUSD');
  const [spreadDefaultDigits, setSpreadDefaultDigits] = useState(2);
  const [spreadDefaultPointSize, setSpreadDefaultPointSize] = useState(0.01);

  // Admin Forgot PIN (on /admin login) & Subscriber PIN Reset Modal state
  const [showAdminResetPin, setShowAdminResetPin] = useState(false);
  const [adminResetNewPin, setAdminResetNewPin] = useState('');
  const [adminResetConfirmPin, setAdminResetConfirmPin] = useState('');
  const [resetPinTarget, setResetPinTarget] = useState<{
    id: string;
    fullName: string;
    phone: string;
  } | null>(null);
  const [resetPinMode, setResetPinMode] = useState<'GENERATE_CODE' | 'SET_PIN'>('GENERATE_CODE');
  const [subscriberTempPin, setSubscriberTempPin] = useState('');
  const [generatedResetResult, setGeneratedResetResult] = useState<{
    code: string;
    expiresAt: string;
    phone: string;
    fullName: string;
  } | null>(null);
  const [copiedResetCode, setCopiedResetCode] = useState(false);

  const hydrateForms = (d: AdminDashboardData) => {
    setBaseUrl(d.tickerAllConfig.baseUrl || 'https://api.tickerall.com');
    setBrokerServer(d.tickerAllConfig.brokerServer || '');
    setMt5AccountNumber(d.tickerAllConfig.mt5AccountNumber || '');
    setAirtelNumber(d.momo.airtelNumber);
    setMtnNumber(d.momo.mtnNumber);
    setRecipientName(d.momo.recipientName);
    setWhatsappRenewNumber(d.momo.whatsappRenewNumber);
    setWeeklyKwacha(d.plans.weekly.kwacha);
    setWeeklyUsd(d.plans.weekly.usd);
    setMonthlyKwacha(d.plans.monthly.kwacha);
    setMonthlyUsd(d.plans.monthly.usd);
    setQuarterlyKwacha(d.plans.quarterly.kwacha);
    setQuarterlyUsd(d.plans.quarterly.usd);
    if (d.spreadPolicy) {
      setMaxSpreadPoints(d.spreadPolicy.maxSpreadPoints);
      setSpreadSensitivity(d.spreadPolicy.spreadSensitivity);
      setAllowHighSpreadTrades(d.spreadPolicy.allowHighSpreadTrades);
      setSpreadCommissionPerLot(d.spreadPolicy.commissionPerLot);
      setSpreadSlippagePoints(d.spreadPolicy.estimatedSlippagePoints);
      setSpreadMaxQuoteAgeSeconds(d.spreadPolicy.maxQuoteAgeSeconds);
      setSpreadMinNetRr(d.spreadPolicy.minNetRewardRisk);
      setSpreadDefaultSymbol(d.spreadPolicy.defaultSymbol);
      setSpreadDefaultDigits(d.spreadPolicy.defaultDigits);
      setSpreadDefaultPointSize(d.spreadPolicy.defaultPointSize);
    }
  };

  const fetchDashboard = useCallback(async () => {
    try {
      const meRes = await fetch('/api/admin/me');
      if (!meRes.ok) {
        setAuthenticated(false);
        onAdminAuthChange?.(false);
        return;
      }
      const meJson = (await meRes.json()) as { authenticated?: boolean };
      if (!meJson.authenticated) {
        setAuthenticated(false);
        onAdminAuthChange?.(false);
        return;
      }
      setAuthenticated(true);
      onAdminAuthChange?.(true);
      const res = await fetch('/api/admin/dashboard');
      if (res.ok) {
        const json = (await res.json()) as { dashboard?: AdminDashboardData };
        if (json.dashboard) {
          setDashboard(json.dashboard);
          hydrateForms(json.dashboard);
        }
      }
    } catch {
      setAuthenticated(false);
      onAdminAuthChange?.(false);
    }
  }, [onAdminAuthChange]);

  useEffect(() => {
    void fetchDashboard();
  }, [fetchDashboard]);

  useEffect(() => {
    return subscribeFirebaseAuth((fbUser) => {
      setFirebaseUser(fbUser);
      if (!fbUser) {
        autoSyncedAdminUidRef.current = null;
      }
    });
  }, []);

  const syncAdminWithFirestore = useCallback(
    async (explicitFbUser?: FirebaseUser | null, opts?: { silent?: boolean }) => {
      const activeFbUser = explicitFbUser ?? auth.currentUser;
      const silent = Boolean(opts?.silent);
      if (!activeFbUser) return;
      if (activeFbUser.email?.toLowerCase() !== 'muyobakuyewana@gmail.com') {
        if (!silent) {
          setNotice(
            `Signed in as ${activeFbUser.email} — Admin Firestore sync requires muyobakuyewana@gmail.com.`
          );
        }
        return;
      }
      if (!silent) {
        setCloudSyncing(true);
      }
      try {
        await ensureAdminDocExists();
        const [idToken, cloudState] = await Promise.all([
          activeFbUser.getIdToken(),
          fetchAllUsersFromFirestoreForAdmin(),
        ]);
        const res = await fetch('/api/admin/firestore-sync', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            idToken,
            firestoreUsers: cloudState.users,
            publicConfig: cloudState.publicConfig,
            masterConfig: cloudState.masterConfig,
          }),
        });
        const json = (await res.json()) as {
          ok?: boolean;
          error?: string;
          dashboard?: AdminDashboardData;
          allBundles?: UserSyncBundle[];
          publicConfig?: { momo: MoMoConfig; plans: PlanPricing };
          masterConfigBundle?: MasterConfigSyncBundle;
        };
        if (!res.ok || !json.ok || !json.dashboard) {
          if (!silent) {
            setNotice(json.error || 'Firestore sync could not complete');
          }
          return;
        }
        setDashboard(json.dashboard);
        if (!silent || (!brokerServer.trim() && !mt5AccountNumber.trim())) {
          hydrateForms(json.dashboard);
        }

        // Backfill server accounts, MoMo/plans public config, and encrypted Master config back to Firestore
        if (json.publicConfig) {
          await saveAdminPublicConfigToFirestore(
            json.publicConfig.momo,
            json.publicConfig.plans
          );
        }
        if (json.masterConfigBundle) {
          await saveAdminMasterConfigToFirestore(json.masterConfigBundle);
        }
        const userSyncErrors: string[] = [];
        if (Array.isArray(json.allBundles)) {
          for (const bundle of json.allBundles) {
            try {
              await saveUserBundleToFirestore(bundle, { asAdmin: true });
              if (bundle.trades.length > 0) {
                const targetId = bundle.ownerId || bundle.appUserId;
                await syncTradesToFirestore(targetId, bundle.trades);
              }
            } catch (userErr) {
              userSyncErrors.push(
                `${bundle.fullName || bundle.appUserId}: ${formatFirestoreErrorForUi(userErr)}`
              );
            }
          }
        }
        if (
          json.dashboard.tickerAllConfig.desiredConnected &&
          json.dashboard.totals.tickerAllStatus !== 'LIVE'
        ) {
          window.setTimeout(() => {
            void fetchDashboard();
          }, 4000);
        }
        setCloudSyncedAt(new Date().toLocaleTimeString());
        if (userSyncErrors.length > 0) {
          setNotice(
            `Cloud sync partial warning (${userSyncErrors.length} error): ${userSyncErrors[0]}`
          );
        } else if (!silent) {
          setNotice(
            `Firestore Cloud Sync complete — Master feed, MoMo settings, & ${json.dashboard.users.length} trader account(s) persisted permanently.`
          );
        }
      } catch (err) {
        if (!silent) {
          setNotice(
            `Firestore sync error: ${formatFirestoreErrorForUi(err)}`
          );
        }
      } finally {
        if (!silent) {
          setCloudSyncing(false);
        }
      }
    },
    [fetchDashboard, brokerServer, mt5AccountNumber]
  );

  useEffect(() => {
    if (
      authenticated &&
      firebaseUser &&
      firebaseUser.email?.toLowerCase() === 'muyobakuyewana@gmail.com' &&
      autoSyncedAdminUidRef.current !== firebaseUser.uid
    ) {
      autoSyncedAdminUidRef.current = firebaseUser.uid;
      void syncAdminWithFirestore(firebaseUser);
    }
  }, [authenticated, firebaseUser, syncAdminWithFirestore]);

  useEffect(() => {
    if (
      !authenticated ||
      !firebaseUser ||
      firebaseUser.email?.toLowerCase() !== 'muyobakuyewana@gmail.com'
    ) {
      return;
    }
    const intervalId = window.setInterval(() => {
      void syncAdminWithFirestore(firebaseUser, { silent: true });
    }, 30_000);
    return () => {
      window.clearInterval(intervalId);
    };
  }, [authenticated, firebaseUser, syncAdminWithFirestore]);

  const handleConnectAdminGoogle = async () => {
    setCloudSyncing(true);
    setNotice(null);
    try {
      const { user: fbUser } = await signInWithGooglePopup();
      autoSyncedAdminUidRef.current = fbUser.uid;
      await syncAdminWithFirestore(fbUser);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Google sign-in failed');
    } finally {
      setCloudSyncing(false);
    }
  };

  const jumpToMasterFeed = useCallback(() => {
    setActiveNavSection('master-feed');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    window.setTimeout(() => {
      masterFeedRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 60);
    if (highlightTimerRef.current !== null) {
      window.clearTimeout(highlightTimerRef.current);
    }
    setHighlightMasterFeed(true);
    highlightTimerRef.current = window.setTimeout(() => {
      setHighlightMasterFeed(false);
      highlightTimerRef.current = null;
    }, 3000);
  }, []);

  const jumpToSubscribers = useCallback(() => {
    setActiveNavSection('subscribers');
    window.setTimeout(() => {
      subscribersRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 40);
  }, []);

  const jumpToSettings = useCallback(() => {
    setActiveNavSection('settings');
    window.setTimeout(() => {
      settingsRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }, 40);
  }, []);

  const jumpToDashboardTop = useCallback(() => {
    setActiveNavSection('dashboard');
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, []);

  useEffect(() => {
    return () => {
      if (highlightTimerRef.current !== null) {
        window.clearTimeout(highlightTimerRef.current);
      }
    };
  }, []);

  useEffect(() => {
    if (!authenticated || !dashboard || !initialSection) return;
    if (initialSection === 'master-feed') {
      jumpToMasterFeed();
    } else if (initialSection === 'subscribers') {
      jumpToSubscribers();
    } else if (initialSection === 'settings') {
      jumpToSettings();
    } else {
      jumpToDashboardTop();
    }
  }, [
    authenticated,
    dashboard !== null,
    initialSection,
    sectionTrigger,
    jumpToMasterFeed,
    jumpToSubscribers,
    jumpToSettings,
    jumpToDashboardTop,
  ]);

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setActionBusy(true);
    try {
      const res = await fetch('/api/admin/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        dashboard?: AdminDashboardData;
      };
      if (!res.ok || !json.ok || !json.dashboard) {
        setAuthError(json.error || 'Invalid Admin Password');
        return;
      }
      setAuthenticated(true);
      onAdminAuthChange?.(true);
      setPassword('');
      setDashboard(json.dashboard);
      hydrateForms(json.dashboard);
    } catch (err) {
      setAuthError(
        err instanceof Error ? err.message : 'Unable to reach admin authentication endpoint'
      );
    } finally {
      setActionBusy(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/admin/logout', { method: 'POST' });
    } catch {
      // Clear local admin session state regardless of network failure
    } finally {
      setAuthenticated(false);
      onAdminAuthChange?.(false);
      setDashboard(null);
    }
  };

  const handleLoginAsUser = async (userId: string) => {
    setActionBusy(true);
    setNotice(null);
    try {
      await onImpersonateUser(userId);
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Unable to open user dashboard');
    } finally {
      setActionBusy(false);
    }
  };

  const handleAdminResetPinViaGoogle = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    const trimmed = adminResetNewPin.trim();
    if (trimmed.length < 4 || trimmed.length > 128) {
      setAuthError('New Admin PIN / Password must be at least 4 characters.');
      return;
    }
    if (trimmed !== adminResetConfirmPin.trim()) {
      setAuthError('New Admin PIN / Password and confirmation do not match.');
      return;
    }
    setActionBusy(true);
    try {
      const { idToken } = await signInWithGooglePopup();
      const res = await fetch('/api/admin/reset-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ newPin: trimmed, firebaseIdToken: idToken }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        dashboard?: AdminDashboardData;
      };
      if (!res.ok || !json.ok || !json.dashboard) {
        setAuthError(json.error || 'Unable to reset Admin PIN.');
        return;
      }
      setAuthenticated(true);
      onAdminAuthChange?.(true);
      setAdminResetNewPin('');
      setAdminResetConfirmPin('');
      setShowAdminResetPin(false);
      setDashboard(json.dashboard);
      hydrateForms(json.dashboard);
      setNotice('Admin PIN / Password has been reset and /admin unlocked.');
    } catch (err) {
      setAuthError(err instanceof Error ? err.message : 'Unable to verify Admin Google account.');
    } finally {
      setActionBusy(false);
    }
  };

  const handleSaveAdminConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setNotice(null);

    const planNumbers = [
      Number(weeklyKwacha),
      Number(weeklyUsd),
      Number(monthlyKwacha),
      Number(monthlyUsd),
      Number(quarterlyKwacha),
      Number(quarterlyUsd),
    ];
    if (planNumbers.some((v) => !Number.isFinite(v) || v <= 0)) {
      setNotice('Plan prices (ZMW and USD) must all be valid positive numbers.');
      return;
    }
    const spreadNums = [
      Number(maxSpreadPoints),
      Number(spreadMaxQuoteAgeSeconds),
      Number(spreadMinNetRr),
      Number(spreadDefaultDigits),
      Number(spreadDefaultPointSize),
    ];
    if (
      spreadNums.some((v) => !Number.isFinite(v) || v <= 0) ||
      !Number.isFinite(Number(spreadCommissionPerLot)) ||
      Number(spreadCommissionPerLot) < 0 ||
      !Number.isFinite(Number(spreadSlippagePoints)) ||
      Number(spreadSlippagePoints) < 0
    ) {
      setNotice('Spread policy numeric settings must be valid finite numbers.');
      return;
    }

    setActionBusy(true);
    try {
      const res = await fetch('/api/admin/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(tickerAllApiKey.trim() ? { tickerAllApiKey: tickerAllApiKey.trim() } : {}),
          baseUrl,
          brokerServer,
          mt5AccountNumber,
          ...(mt5Password.trim() ? { mt5Password: mt5Password.trim() } : {}),
          ...(newAdminPassword.trim() ? { newAdminPassword: newAdminPassword.trim() } : {}),
          momo: {
            airtelNumber,
            mtnNumber,
            recipientName,
            whatsappRenewNumber,
          },
          plans: {
            weekly: { label: 'Weekly', kwacha: Number(weeklyKwacha), usd: Number(weeklyUsd), days: 7 },
            monthly: { label: 'Monthly', kwacha: Number(monthlyKwacha), usd: Number(monthlyUsd), days: 30 },
            quarterly: { label: 'Quarterly', kwacha: Number(quarterlyKwacha), usd: Number(quarterlyUsd), days: 90 },
          },
          spreadPolicy: {
            maxSpreadPoints: Number(maxSpreadPoints),
            spreadSensitivity,
            allowHighSpreadTrades,
            commissionPerLot: Number(spreadCommissionPerLot),
            estimatedSlippagePoints: Number(spreadSlippagePoints),
            maxQuoteAgeSeconds: Number(spreadMaxQuoteAgeSeconds),
            minNetRewardRisk: Number(spreadMinNetRr),
            defaultSymbol: spreadDefaultSymbol.trim() || 'XAUUSD',
            defaultDigits: Number(spreadDefaultDigits),
            defaultPointSize: Number(spreadDefaultPointSize),
          },
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        dashboard?: AdminDashboardData;
        masterConfigBundle?: MasterConfigSyncBundle;
      };
      if (res.ok && json.ok && json.dashboard) {
        const pinChanged = Boolean(newAdminPassword.trim());
        setDashboard(json.dashboard);
        setTickerAllApiKey('');
        setMt5Password('');
        setNewAdminPassword('');
        if (auth.currentUser?.email?.toLowerCase() === 'muyobakuyewana@gmail.com') {
          try {
            await saveAdminPublicConfigToFirestore(
              json.dashboard.momo,
              json.dashboard.plans
            );
            if (json.masterConfigBundle) {
              await saveAdminMasterConfigToFirestore(json.masterConfigBundle);
            }
            setCloudSyncedAt(new Date().toLocaleTimeString());
            setNotice(
              pinChanged
                ? 'Admin settings, new Admin PIN, & Firestore Cloud backup saved permanently.'
                : 'Admin Master Key, MoMo Numbers, & Plan Prices saved to server and Firestore Cloud.'
            );
          } catch (cloudErr) {
            setNotice(
              `Saved on server, but Firestore Cloud backup failed: ${formatFirestoreErrorForUi(cloudErr)}`
            );
          }
        } else {
          setNotice(
            'Saved on server only — click "Connect Google Cloud Sync" above so Master Key, MoMo numbers, and prices persist permanently in Firestore.'
          );
        }
      } else {
        setNotice(json.error || `Failed to save config (HTTP ${res.status})`);
      }
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : 'Network error saving admin configuration.'
      );
    } finally {
      setActionBusy(false);
    }
  };

  const handleMasterFeedAction = async (connect: boolean) => {
    setActionBusy(true);
    setNotice(null);
    try {
      const res = await fetch(
        connect ? '/api/admin/tickerall/connect' : '/api/admin/tickerall/disconnect',
        { method: 'POST' }
      );
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        dashboard?: AdminDashboardData;
        masterConfigBundle?: MasterConfigSyncBundle;
      };
      if (json.dashboard) setDashboard(json.dashboard);
      let cloudErrMsg: string | null = null;
      const isAdminGoogle =
        auth.currentUser?.email?.toLowerCase() === 'muyobakuyewana@gmail.com';
      if (json.masterConfigBundle && isAdminGoogle) {
        try {
          await saveAdminMasterConfigToFirestore(json.masterConfigBundle);
          setCloudSyncedAt(new Date().toLocaleTimeString());
        } catch (cloudErr) {
          cloudErrMsg = formatFirestoreErrorForUi(cloudErr);
        }
      }
      if (!json.ok) {
        setNotice(json.error || 'Master feed action returned notice');
      } else if (cloudErrMsg) {
        setNotice(
          `Master Feed updated on server, but Firestore backup failed: ${cloudErrMsg}`
        );
      } else if (!isAdminGoogle) {
        setNotice(
          connect
            ? 'Master Proxy Feed connected on server. Connect Google Cloud Sync above so this 24/7 state persists across restarts.'
            : 'Master Proxy Feed disconnected on server.'
        );
      } else {
        setNotice(
          connect
            ? 'Master Proxy TickerAll Feed connected & backed up to Firestore — stays active 24/7 until Admin clicks Disconnect.'
            : 'Master Proxy Feed disconnected by Admin & saved to Firestore.'
        );
      }
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : 'Network error updating Master Proxy Feed.'
      );
    } finally {
      setActionBusy(false);
    }
  };

  const handleUserAction = async (
    userId: string,
    action: 'APPROVE' | 'REJECT' | 'EXTEND_7_DAYS' | 'BLOCK' | 'PAUSE_FEED' | 'RESUME_FEED'
  ) => {
    setActionBusy(true);
    setNotice(null);
    try {
      const res = await fetch(`/api/admin/users/${encodeURIComponent(userId)}/action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        dashboard?: AdminDashboardData;
        updatedUserBundle?: UserSyncBundle;
      };
      if (res.ok && json.ok && json.dashboard) {
        setDashboard(json.dashboard);
        const isAdminGoogle =
          auth.currentUser?.email?.toLowerCase() === 'muyobakuyewana@gmail.com';
        if (json.updatedUserBundle && isAdminGoogle) {
          try {
            await saveUserBundleToFirestore(json.updatedUserBundle, { asAdmin: true });
            setCloudSyncedAt(new Date().toLocaleTimeString());
            setNotice(`Action ${action} applied & saved to Firestore Cloud.`);
          } catch (cloudErr) {
            setNotice(
              `Action ${action} applied locally, but Firestore sync failed: ${formatFirestoreErrorForUi(cloudErr)}`
            );
          }
        } else {
          setNotice(
            `Action ${action} applied locally — click "Connect Google Cloud Sync" above to save permanently to Firestore.`
          );
        }
      } else {
        setNotice(json.error || `Action ${action} failed (HTTP ${res.status})`);
      }
    } catch (err) {
      setNotice(err instanceof Error ? err.message : `Network error running ${action}.`);
    } finally {
      setActionBusy(false);
    }
  };

  const handleCreateOrAuthorizeTestAccount = async () => {
    setActionBusy(true);
    setNotice(null);
    try {
      const res = await fetch('/api/admin/test-account/create', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        dashboard?: AdminDashboardData;
        updatedUserBundle?: UserSyncBundle;
      };
      if (!res.ok || !json.ok || !json.dashboard) {
        setNotice(json.error || 'Unable to create or authorize Demo Test Account.');
        return;
      }
      setDashboard(json.dashboard);
      const isAdminGoogle =
        auth.currentUser?.email?.toLowerCase() === 'muyobakuyewana@gmail.com';
      if (json.updatedUserBundle && isAdminGoogle) {
        try {
          await saveUserBundleToFirestore(json.updatedUserBundle, { asAdmin: true });
          setCloudSyncedAt(new Date().toLocaleTimeString());
          setNotice(
            'Demo Test Account authorized (ACTIVE + Feed ALLOWED) & saved to Firestore Cloud.'
          );
        } catch (cloudErr) {
          setNotice(
            `Demo Test Account ready locally, but Firestore sync failed: ${formatFirestoreErrorForUi(cloudErr)}`
          );
        }
      } else {
        setNotice(
          'Demo Test Account authorized locally (ACTIVE + Feed ALLOWED). Connect Google Cloud Sync to back up to Firestore.'
        );
      }
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : 'Network error provisioning Demo Test Account.'
      );
    } finally {
      setActionBusy(false);
    }
  };

  const handleSubscriberResetPin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!resetPinTarget) return;
    if (resetPinMode === 'SET_PIN' && subscriberTempPin.trim().length < 4) {
      setNotice('Temporary PIN / Password must be at least 4 characters.');
      return;
    }
    setActionBusy(true);
    setNotice(null);
    try {
      const res = await fetch(
        `/api/admin/users/${encodeURIComponent(resetPinTarget.id)}/reset-pin`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(
            resetPinMode === 'GENERATE_CODE'
              ? { mode: 'GENERATE_CODE' }
              : { mode: 'SET_PIN', newPin: subscriberTempPin.trim() }
          ),
        }
      );
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        mode?: 'GENERATE_CODE' | 'SET_PIN';
        resetCode?: string;
        expiresAt?: string;
        dashboard?: AdminDashboardData;
        updatedUserBundle?: UserSyncBundle;
      };
      if (!res.ok || !json.ok) {
        setNotice(json.error || 'Unable to reset subscriber PIN');
        return;
      }
      if (json.dashboard) {
        setDashboard(json.dashboard);
      }
      if (json.mode === 'GENERATE_CODE' && json.resetCode && json.expiresAt) {
        setGeneratedResetResult({
          code: json.resetCode,
          expiresAt: json.expiresAt,
          phone: resetPinTarget.phone,
          fullName: resetPinTarget.fullName,
        });
        setCopiedResetCode(false);
        setNotice(`6-digit PIN reset code generated for ${resetPinTarget.fullName}.`);
      } else {
        if (
          json.updatedUserBundle &&
          auth.currentUser?.email?.toLowerCase() === 'muyobakuyewana@gmail.com'
        ) {
          try {
            await saveUserBundleToFirestore(json.updatedUserBundle, { asAdmin: true });
            setCloudSyncedAt(new Date().toLocaleTimeString());
            setNotice(`PIN updated directly for ${resetPinTarget.fullName} & saved to Firestore.`);
          } catch (cloudErr) {
            setNotice(
              `PIN updated locally for ${resetPinTarget.fullName}, but Firestore sync failed: ${formatFirestoreErrorForUi(cloudErr)}`
            );
          }
        } else {
          setNotice(`PIN updated directly for ${resetPinTarget.fullName}.`);
        }
        setSubscriberTempPin('');
        setResetPinTarget(null);
      }
    } catch (err) {
      setNotice(
        err instanceof Error ? err.message : 'Network error resetting subscriber PIN.'
      );
    } finally {
      setActionBusy(false);
    }
  };

  const [showPass, setShowPass] = useState(false);

  if (authenticated === null) {
    return (
      <div className="min-h-screen bg-[#0B0F17] text-slate-300 flex items-center justify-center text-xs">
        Verifying Admin session...
      </div>
    );
  }

  if (!authenticated) {
    return (
      <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex items-center justify-center p-4">
        <div className="w-full max-w-md border border-white/10 bg-[#111722] rounded-xl p-6 space-y-5">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-[#E5B85C] font-display font-bold text-base">
              <ShieldCheck className="w-5 h-5" />
              Admin Control (/admin)
            </div>
            <button
              type="button"
              onClick={onBackToUserApp}
              className="inline-flex items-center gap-1 text-xs text-slate-400 hover:text-white"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              User App
            </button>
          </div>
          <p className="text-xs text-slate-400">
            Password protected. Controls Master TickerAll Proxy Key, subscriber MoMo approvals, and Proxy Feed access only.
          </p>
          {authError && (
            <div className="p-2.5 rounded border border-red-500/35 bg-red-950/25 text-xs text-red-300">
              {authError}
            </div>
          )}
          {showAdminResetPin ? (
            <form onSubmit={handleAdminResetPinViaGoogle} className="space-y-4">
              <div className="flex items-center justify-between border-b border-white/8 pb-2">
                <span className="text-xs font-semibold text-[#E5B85C]">
                  Reset /admin PIN via Admin Google
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setShowAdminResetPin(false);
                    setAuthError(null);
                  }}
                  className="text-[11px] text-slate-400 hover:text-white"
                >
                  Back to Login
                </button>
              </div>
              <label className="block text-xs">
                <span className="text-slate-300">New Admin PIN / Password (min 4 chars)</span>
                <input
                  type="password"
                  required
                  minLength={4}
                  placeholder="Enter new Admin PIN or password"
                  value={adminResetNewPin}
                  onChange={(e) => setAdminResetNewPin(e.target.value)}
                  className="mt-1.5 w-full px-3.5 py-2.5 rounded bg-[#0B0F17] border border-white/12 text-slate-100 text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
              <label className="block text-xs">
                <span className="text-slate-300">Confirm New Admin PIN / Password</span>
                <input
                  type="password"
                  required
                  minLength={4}
                  placeholder="Confirm new Admin PIN or password"
                  value={adminResetConfirmPin}
                  onChange={(e) => setAdminResetConfirmPin(e.target.value)}
                  className="mt-1.5 w-full px-3.5 py-2.5 rounded bg-[#0B0F17] border border-white/12 text-slate-100 text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
              <p className="text-[11px] text-slate-400">
                Verifies with authorized Admin Google account (<span className="font-mono text-slate-300">muyobakuyewana@gmail.com</span>).
              </p>
              <button
                type="submit"
                disabled={actionBusy}
                className="w-full py-2.5 rounded bg-[#D4A853] text-[#0B0F17] text-xs font-bold hover:bg-[#E0B866] disabled:opacity-50"
              >
                {actionBusy ? 'Verifying Google...' : 'Verify Admin Google & Reset PIN'}
              </button>
            </form>
          ) : (
            <form onSubmit={handleLogin} className="space-y-4">
              <label className="block text-xs">
                <div className="flex items-center justify-between">
                  <span className="text-slate-300">Admin PIN / Password</span>
                  <button
                    type="button"
                    onClick={() => setShowPass((v) => !v)}
                    className="text-[11px] text-[#E5B85C] hover:underline"
                  >
                    {showPass ? 'Hide' : 'Show'}
                  </button>
                </div>
                <input
                  type={showPass ? 'text' : 'password'}
                  name="admin-access-key"
                  autoComplete="new-password"
                  required
                  placeholder="Enter Admin PIN or password (case-sensitive)"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    if (authError) setAuthError(null);
                  }}
                  className="mt-1.5 w-full px-3.5 py-2.5 rounded bg-[#0B0F17] border border-white/12 text-slate-100 text-xs focus:outline-none focus:border-[#D4A853]"
                />
              </label>
              <div className="flex items-center justify-between gap-2 text-[11px]">
                <span className="text-slate-500">
                  Case-sensitive · Default uses <span className="font-mono text-slate-400">ADMIN_PASSWORD</span>.
                </span>
                <button
                  type="button"
                  onClick={() => {
                    setShowAdminResetPin(true);
                    setAuthError(null);
                  }}
                  className="text-[#E5B85C] hover:underline whitespace-nowrap"
                >
                  Forgot Admin PIN?
                </button>
              </div>
              <button
                type="submit"
                disabled={actionBusy}
                className="w-full py-2.5 rounded bg-[#D4A853] text-[#0B0F17] text-xs font-bold hover:bg-[#E0B866] disabled:opacity-50"
              >
                {actionBusy ? 'Verifying...' : 'Unlock /admin Dashboard'}
              </button>
            </form>
          )}
        </div>
      </div>
    );
  }

  const testAccount = dashboard
    ? dashboard.users.find((u) => u.accountType === 'Demo' && /test/i.test(u.fullName)) ||
      dashboard.users.find((u) => /test/i.test(u.fullName)) ||
      dashboard.users.find((u) => u.accountType === 'Demo' && u.status === 'ACTIVE') ||
      dashboard.users.find((u) => /kuyewana/i.test(u.fullName)) ||
      dashboard.users.find((u) => u.accountType === 'Demo') ||
      dashboard.users[0] ||
      null
    : null;

  const filteredUsers = (dashboard?.users || []).filter((u) => {
    if (userFilter === 'PENDING' && u.status !== 'PENDING') return false;
    if (userFilter === 'APPROVED' && u.status !== 'ACTIVE') return false;
    if (
      userFilter === 'TEST' &&
      !(
        u.accountType === 'Demo' ||
        /kuyewana|test/i.test(u.fullName)
      )
    ) {
      return false;
    }
    const q = searchQuery.trim().toLowerCase();
    if (!q) return true;
    return (
      u.fullName.toLowerCase().includes(q) ||
      u.phone.toLowerCase().includes(q) ||
      u.brokerName.toLowerCase().includes(q)
    );
  });

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100">
      <TopNavBar
        activeSection={activeNavSection}
        onSelectDashboard={jumpToDashboardTop}
        onSelectMasterFeed={jumpToMasterFeed}
        onSelectSubscribers={jumpToSubscribers}
        onSelectSettings={onGoSubscriberSettings ?? jumpToSettings}
      />

      <div className="p-4 sm:p-6">
      <div className="max-w-[1440px] mx-auto space-y-6">
        {/* Top Bar */}
        <header className="flex flex-wrap items-center justify-between gap-4 border border-white/10 bg-[#111722] rounded-lg p-4">
          <div className="flex items-center gap-3">
            <ShieldCheck className="w-5 h-5 text-[#E5B85C]" />
            <div>
              <h1 className="text-base font-display font-bold text-slate-50">
                Gold AI Trader — Admin Proxy &amp; Subscription Console (/admin)
              </h1>
              <p className="text-xs text-slate-400">
                Single TickerAll Proxy Key · Admin cannot view full user API keys, force Auto ON, close user trades, or withdraw user funds.
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2.5">
            <button
              type="button"
              onClick={() => void fetchDashboard()}
              className="px-3 py-1.5 rounded border border-white/12 bg-[#0B0F17] text-xs text-slate-200 hover:border-[#D4A853]/50"
            >
              Refresh
            </button>
            <button
              type="button"
              onClick={onBackToUserApp}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-white/12 bg-[#0B0F17] text-xs text-slate-200 hover:text-white"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Subscriber Portal
            </button>
            <button
              type="button"
              onClick={handleLogout}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-red-500/30 bg-red-950/20 text-xs text-red-300"
            >
              <LogOut className="w-3.5 h-3.5" />
              Logout
            </button>
          </div>
        </header>

        {notice && (
          <div className="px-4 py-2.5 rounded border border-[#D4A853]/40 bg-[#D4A853]/10 text-xs text-[#E5B85C]">
            {notice}
          </div>
        )}

        {/* Firestore Cloud Persistence Bar */}
        <div
          className={`rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3 border ${
            firebaseUser?.email?.toLowerCase() === 'muyobakuyewana@gmail.com'
              ? 'border-emerald-500/35 bg-[#111722]'
              : 'border-amber-500/50 bg-amber-950/25'
          }`}
        >
          <div className="flex items-center gap-2.5 text-xs">
            <Cloud
              className={`w-4 h-4 shrink-0 ${
                firebaseUser?.email?.toLowerCase() === 'muyobakuyewana@gmail.com'
                  ? 'text-emerald-400'
                  : 'text-amber-300'
              }`}
            />
            {firebaseUser?.email?.toLowerCase() === 'muyobakuyewana@gmail.com' ? (
              <span className="text-emerald-300">
                Firestore Cloud Persistence Active (<span className="font-mono">{firebaseUser.email}</span>)
                {cloudSyncedAt ? ` · Last synced ${cloudSyncedAt}` : ''}
              </span>
            ) : (
              <span className="text-amber-100">
                <strong>Cloud Backup Required:</strong> Connect Admin Google (<span className="font-mono">muyobakuyewana@gmail.com</span>) so Master Key, MoMo numbers, and all trader accounts stay stored permanently in Firestore.
              </span>
            )}
          </div>
          <div className="flex items-center gap-2">
            {firebaseUser?.email?.toLowerCase() === 'muyobakuyewana@gmail.com' ? (
              <button
                type="button"
                disabled={cloudSyncing}
                onClick={() => void syncAdminWithFirestore()}
                className="px-3.5 py-1.5 rounded border border-emerald-500/40 bg-emerald-500/15 text-emerald-200 text-xs font-semibold hover:bg-emerald-500/25 disabled:opacity-50"
              >
                {cloudSyncing ? 'Syncing Firestore...' : 'Sync All Accounts Now'}
              </button>
            ) : (
              <button
                type="button"
                disabled={cloudSyncing}
                onClick={() => void handleConnectAdminGoogle()}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-[#D4A853] text-[#0B0F17] text-xs font-bold hover:bg-[#E0B866] disabled:opacity-50"
              >
                <Cloud className="w-3.5 h-3.5" />
                {cloudSyncing ? 'Connecting...' : 'Connect Google Cloud Sync'}
              </button>
            )}
          </div>
        </div>

        {/* 2 Big Quick-Action Shortcut Cards at Top of Admin Dashboard */}
        {dashboard && (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
            {/* Card 1: Master Feed Status + 1-Tap Jump */}
            <div className="border border-[#D4A853]/40 bg-[#111722] rounded-xl p-5 flex flex-col justify-between gap-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    MASTER FEED STATUS
                  </div>
                  <div className="mt-2 flex items-center gap-3">
                    <span
                      className={`inline-flex items-center gap-1.5 px-3 py-1 rounded-md text-sm font-mono font-bold border ${
                        dashboard.totals.tickerAllStatus === 'LIVE'
                          ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                          : dashboard.totals.tickerAllStatus === 'CONNECTING'
                            ? 'border-amber-500/40 bg-amber-500/15 text-amber-200'
                            : 'border-red-500/40 bg-red-950/35 text-red-300'
                      }`}
                    >
                      <Radio className="w-4 h-4" />
                      {dashboard.totals.tickerAllStatus}
                    </span>
                    <span className="font-mono text-lg sm:text-xl font-bold text-[#E5B85C]">
                      {dashboard.tickerAllConfig.latestGoldPrice !== null
                        ? `GOLD $${dashboard.tickerAllConfig.latestGoldPrice.toFixed(2)}`
                        : 'No GOLD price yet'}
                    </span>
                  </div>
                </div>
              </div>
              <button
                type="button"
                onClick={jumpToMasterFeed}
                className="w-full min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#D4A853] text-[#0B0F17] text-sm font-bold hover:bg-[#E0B866] transition-colors"
              >
                <span>Go To Master Feed</span>
                <ArrowRight className="w-4 h-4" />
              </button>
            </div>

            {/* Card 2: Test Account + 1-Tap Authorization & Impersonation */}
            <div className="border border-emerald-500/35 bg-[#111722] rounded-xl p-5 flex flex-col justify-between gap-4">
              <div>
                <div className="flex items-center justify-between gap-2">
                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    TEST ACCOUNT
                  </div>
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => void handleCreateOrAuthorizeTestAccount()}
                    className="inline-flex items-center gap-1 px-2.5 py-1 rounded border border-emerald-500/35 bg-emerald-950/30 text-emerald-200 text-[11px] font-semibold hover:bg-emerald-900/40 disabled:opacity-40"
                  >
                    <UserPlus className="w-3 h-3" />
                    {testAccount ? 'Provision Demo Test User' : 'Create Demo Test User'}
                  </button>
                </div>
                {testAccount ? (
                  <div className="mt-2 space-y-1.5">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-lg font-bold text-slate-50">
                        {testAccount.fullName} - {testAccount.planLabel}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded border text-[10px] font-mono font-semibold ${
                          testAccount.status === 'ACTIVE'
                            ? 'border-emerald-500/35 bg-emerald-500/15 text-emerald-300'
                            : testAccount.status === 'PENDING'
                              ? 'border-amber-500/35 bg-amber-500/15 text-amber-200'
                              : 'border-red-500/35 bg-red-500/15 text-red-300'
                        }`}
                      >
                        {testAccount.status}
                      </span>
                      <span
                        className={`px-2 py-0.5 rounded border text-[10px] font-mono font-semibold ${
                          testAccount.feedAccess
                            ? 'border-emerald-500/30 bg-emerald-950/30 text-emerald-300'
                            : 'border-red-500/30 bg-red-950/30 text-red-300'
                        }`}
                      >
                        {testAccount.feedAccess ? 'FEED ALLOWED' : 'FEED OFF'}
                      </span>
                    </div>
                    <div className="text-xs font-mono text-slate-400">
                      {testAccount.phone} · {testAccount.accountType} · {testAccount.brokerName} · Bal ${testAccount.balance.toFixed(2)}
                    </div>
                  </div>
                ) : (
                  <div className="mt-2 text-sm text-slate-400">
                    No test subscriber signed up yet. Click Create Demo Test User to provision one.
                  </div>
                )}
              </div>
              <div className="flex flex-wrap gap-2">
                {testAccount && (testAccount.status !== 'ACTIVE' || !testAccount.feedAccess) && (
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() =>
                      void handleUserAction(
                        testAccount.id,
                        testAccount.status === 'ACTIVE' ? 'RESUME_FEED' : 'APPROVE'
                      )
                    }
                    className="flex-1 min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#D4A853] text-[#0B0F17] text-sm font-bold hover:bg-[#E0B866] disabled:opacity-40 transition-colors"
                  >
                    <CheckCircle2 className="w-4 h-4" />
                    <span>
                      {testAccount.status === 'BLOCKED'
                        ? 'Unblock & Authorize'
                        : testAccount.status === 'ACTIVE'
                          ? 'Enable Test Feed'
                          : 'Authorize Test Account'}
                    </span>
                  </button>
                )}
                <button
                  type="button"
                  disabled={actionBusy || !testAccount}
                  onClick={() => testAccount && void handleLoginAsUser(testAccount.id)}
                  className="flex-1 min-h-[44px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-500 text-[#0B0F17] text-sm font-bold hover:bg-emerald-400 disabled:opacity-40 transition-colors"
                >
                  <UserCheck className="w-4 h-4" />
                  <span>Login As Test User</span>
                  <ArrowRight className="w-4 h-4" />
                </button>
              </div>
            </div>
          </div>
        )}

        {/* Totals Strip */}
        {dashboard && (
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-4 font-mono tabular-nums">
            <div className="border border-white/8 bg-[#111722] rounded-lg p-4">
              <div className="text-[11px] font-sans text-slate-400">Total Active Users</div>
              <div className="mt-1 text-2xl font-bold text-emerald-400">
                {dashboard.totals.totalActiveUsers}
              </div>
              <div className="text-[11px] text-slate-400 font-sans">
                {dashboard.totals.pendingUsers} pending
              </div>
            </div>
            <div className="border border-white/8 bg-[#111722] rounded-lg p-4">
              <div className="text-[11px] font-sans text-slate-400">Collected This Month</div>
              <div className="mt-1 text-xl font-bold text-[#E5B85C]">
                K{dashboard.totals.totalCollectedMonthKwacha}
              </div>
              <div className="text-[11px] text-slate-400">
                ${dashboard.totals.totalCollectedMonthUsd} USD
              </div>
            </div>
            <div className="border border-white/8 bg-[#111722] rounded-lg p-4">
              <div className="text-[11px] font-sans text-slate-400">Expiring This Week</div>
              <div className="mt-1 text-2xl font-bold text-amber-300">
                {dashboard.totals.expiringThisWeek}
              </div>
            </div>
            <div className="border border-white/8 bg-[#111722] rounded-lg p-4">
              <div className="text-[11px] font-sans text-slate-400">TickerAll Status</div>
              <div
                className={`mt-1 text-xl font-bold ${
                  dashboard.totals.tickerAllStatus === 'LIVE'
                    ? 'text-emerald-400'
                    : dashboard.totals.tickerAllStatus === 'CONNECTING'
                      ? 'text-amber-300'
                      : 'text-red-400'
                }`}
              >
                {dashboard.totals.tickerAllStatus}
              </div>
              <div className="text-[11px] text-slate-400">
                {dashboard.tickerAllConfig.latestGoldPrice !== null
                  ? `GOLD $${dashboard.tickerAllConfig.latestGoldPrice.toFixed(2)}`
                  : 'No price yet'}
              </div>
            </div>
            <div className="border border-white/8 bg-[#111722] rounded-lg p-4">
              <div className="text-[11px] font-sans text-slate-400">TickerAll Quota Used</div>
              <div className="mt-1 text-2xl font-bold text-slate-100">
                {dashboard.totals.tickerAllQuotaUsed.toLocaleString()}
              </div>
              <div className="text-[11px] text-slate-400 font-sans">1 Proxy Connection</div>
            </div>
            <div className="border border-white/8 bg-[#111722] rounded-lg p-4">
              <div className="text-[11px] font-sans text-slate-400">Active Feed Users</div>
              <div className="mt-1 text-2xl font-bold text-emerald-300">
                {dashboard.totals.activeFeedUsers}
              </div>
              <div className="text-[11px] text-slate-400 font-sans">
                of {dashboard.totals.totalUsers} signed up
              </div>
            </div>
          </div>
        )}

        {/* Master TickerAll Key & MoMo / Plan Settings */}
        {dashboard && (
          <form onSubmit={handleSaveAdminConfig} className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div
              ref={masterFeedRef}
              id="admin-master-feed-box"
              className={`rounded-lg p-5 space-y-4 transition-all duration-300 ${
                highlightMasterFeed
                  ? 'border-2 border-yellow-400 bg-yellow-400/15 ring-4 ring-yellow-400/60 shadow-lg shadow-yellow-400/20'
                  : 'border border-white/8 bg-[#111722]'
              }`}
            >
              <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-3">
                <div className="flex items-center gap-2">
                  <KeyRound className={`w-4 h-4 ${highlightMasterFeed ? 'text-yellow-300' : 'text-[#E5B85C]'}`} />
                  <h2 className="text-sm font-semibold text-slate-100">
                    Master TickerAll Proxy Feed (Admin Only)
                  </h2>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => void handleMasterFeedAction(true)}
                    className={`inline-flex items-center gap-1 px-3 py-1.5 rounded text-xs font-semibold transition-all ${
                      highlightMasterFeed
                        ? 'bg-yellow-400 text-[#0B0F17] ring-2 ring-yellow-200 font-bold'
                        : 'bg-[#D4A853] text-[#0B0F17] hover:bg-[#E0B866]'
                    }`}
                  >
                    <Play className="w-3 h-3" />
                    Connect Master Feed
                  </button>
                  <button
                    type="button"
                    disabled={actionBusy}
                    onClick={() => void handleMasterFeedAction(false)}
                    className="inline-flex items-center gap-1 px-3 py-1.5 rounded border border-red-500/30 bg-red-950/20 text-red-300 text-xs"
                  >
                    Disconnect
                  </button>
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs">
                <label className="block sm:col-span-2">
                  <span className="text-slate-400">
                    TickerAll Master API Key (Encrypted · Current:{' '}
                    <span className="font-mono text-[#E5B85C]">
                      {dashboard.tickerAllConfig.hasMasterKey
                        ? `••••${dashboard.tickerAllConfig.masterKeyLast4}`
                        : 'Not Set'}
                    </span>
                    )
                  </span>
                  <input
                    type="password"
                    placeholder="Paste new TickerAll API Key (never exposed to users)"
                    value={tickerAllApiKey}
                    onChange={(e) => setTickerAllApiKey(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-400">TickerAll Base URL</span>
                  <input
                    type="text"
                    value={baseUrl}
                    onChange={(e) => setBaseUrl(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-400">Master Feed MT5 Server</span>
                  <input
                    type="text"
                    placeholder="e.g. XMGlobal-MT5 3"
                    value={brokerServer}
                    onChange={(e) => setBrokerServer(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-400">Master Feed MT5 Login</span>
                  <input
                    type="text"
                    placeholder="Investor account number for price stream"
                    value={mt5AccountNumber}
                    onChange={(e) => setMt5AccountNumber(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-400">
                    Master Investor Password ({dashboard.tickerAllConfig.hasMasterPassword ? 'Saved' : 'Not Set'})
                  </span>
                  <input
                    type="password"
                    placeholder="Investor password for Master Feed"
                    value={mt5Password}
                    onChange={(e) => setMt5Password(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                  />
                </label>
              </div>
              <div className="text-[11px] font-mono">
                {dashboard.tickerAllConfig.desiredConnected ? (
                  <span className="text-emerald-300">
                    Persistent 24/7 Mode: ACTIVE — Master feed &amp; user connections remain live even when phones are off until Admin clicks Disconnect.
                  </span>
                ) : (
                  <span className="text-slate-400">
                    Persistent 24/7 Mode: OFF — Click Connect Master Feed to keep running 24/7 even when phones are off.
                  </span>
                )}
              </div>
              {dashboard.tickerAllConfig.lastError && (
                <p className="text-xs text-amber-300 font-mono">
                  Upstream status: {dashboard.tickerAllConfig.lastError}
                </p>
              )}
            </div>

            <div
              ref={settingsRef}
              id="admin-settings-box"
              className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-4"
            >
              <div className="flex items-center justify-between border-b border-white/8 pb-3">
                <div className="flex items-center gap-2">
                  <Activity className="w-4 h-4 text-[#E5B85C]" />
                  <h2 className="text-sm font-semibold text-slate-100">
                    MoMo Numbers &amp; Subscription Prices
                  </h2>
                </div>
                <button
                  type="submit"
                  disabled={actionBusy}
                  className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded bg-[#D4A853] text-[#0B0F17] text-xs font-semibold hover:bg-[#E0B866]"
                >
                  <Save className="w-3.5 h-3.5" />
                  Save Admin Settings
                </button>
              </div>

              <div className="grid grid-cols-2 gap-3 text-xs">
                <label className="block">
                  <span className="text-slate-400">Airtel MoMo Number</span>
                  <input
                    type="text"
                    value={airtelNumber}
                    onChange={(e) => setAirtelNumber(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-400">MTN MoMo Number</span>
                  <input
                    type="text"
                    value={mtnNumber}
                    onChange={(e) => setMtnNumber(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-400">MoMo Recipient Name</span>
                  <input
                    type="text"
                    value={recipientName}
                    onChange={(e) => setRecipientName(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-400">WhatsApp Renew Number</span>
                  <input
                    type="text"
                    value={whatsappRenewNumber}
                    onChange={(e) => setWhatsappRenewNumber(e.target.value)}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                  />
                </label>
              </div>

              <div className="grid grid-cols-3 gap-3 text-xs font-mono pt-1">
                <div className="p-2.5 rounded border border-white/8 bg-[#0B0F17] space-y-1.5">
                  <div className="font-sans text-slate-300 font-semibold">Weekly (7d)</div>
                  <input
                    type="number"
                    value={weeklyKwacha}
                    onChange={(e) => setWeeklyKwacha(Number(e.target.value))}
                    className="w-full px-2 py-1 rounded bg-[#111722] border border-white/10 text-slate-100"
                    placeholder="K"
                  />
                  <input
                    type="number"
                    value={weeklyUsd}
                    onChange={(e) => setWeeklyUsd(Number(e.target.value))}
                    className="w-full px-2 py-1 rounded bg-[#111722] border border-white/10 text-slate-100"
                    placeholder="$"
                  />
                </div>
                <div className="p-2.5 rounded border border-white/8 bg-[#0B0F17] space-y-1.5">
                  <div className="font-sans text-slate-300 font-semibold">Monthly (30d)</div>
                  <input
                    type="number"
                    value={monthlyKwacha}
                    onChange={(e) => setMonthlyKwacha(Number(e.target.value))}
                    className="w-full px-2 py-1 rounded bg-[#111722] border border-white/10 text-slate-100"
                  />
                  <input
                    type="number"
                    value={monthlyUsd}
                    onChange={(e) => setMonthlyUsd(Number(e.target.value))}
                    className="w-full px-2 py-1 rounded bg-[#111722] border border-white/10 text-slate-100"
                  />
                </div>
                <div className="p-2.5 rounded border border-white/8 bg-[#0B0F17] space-y-1.5">
                  <div className="font-sans text-slate-300 font-semibold">Quarterly (90d)</div>
                  <input
                    type="number"
                    value={quarterlyKwacha}
                    onChange={(e) => setQuarterlyKwacha(Number(e.target.value))}
                    className="w-full px-2 py-1 rounded bg-[#111722] border border-white/10 text-slate-100"
                  />
                  <input
                    type="number"
                    value={quarterlyUsd}
                    onChange={(e) => setQuarterlyUsd(Number(e.target.value))}
                    className="w-full px-2 py-1 rounded bg-[#111722] border border-white/10 text-slate-100"
                  />
                </div>
              </div>

              <label className="block text-xs pt-1 border-t border-white/8">
                <span className="text-slate-400">
                  Update /admin PIN / Password (Optional · min 4 chars)
                </span>
                <input
                  type="password"
                  placeholder="Leave blank to keep current Admin PIN / Password"
                  value={newAdminPassword}
                  onChange={(e) => setNewAdminPassword(e.target.value)}
                  className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                />
              </label>
            </div>

            {/* Dynamic Spread Filter Policy (All-Session MT5 Control) */}
            <div className="lg:col-span-2 border border-[#D4A853]/30 bg-[#111722] rounded-lg p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 pb-3">
                <div>
                  <h2 className="text-sm font-semibold text-[#E5B85C]">
                    Dynamic Spread Filter Policy (All-Session MT5)
                  </h2>
                  <p className="text-xs text-slate-400 mt-0.5">
                    Replaces fixed 45-point cap with live MT5 Bid/Ask classification, percentile thresholds, and cost-adjusted Net R:R enforcement. AI cannot override hard spread or quote-freshness blocks.
                  </p>
                </div>
                {dashboard.liveSpreadEvaluation && (
                  <div className="flex flex-wrap items-center gap-2 text-xs font-mono">
                    <span
                      className={`px-2 py-0.5 rounded border font-bold ${
                        !dashboard.liveSpreadEvaluation.dataAvailable ||
                        dashboard.liveSpreadEvaluation.classification === 'ABNORMAL' ||
                        dashboard.liveSpreadEvaluation.classification === 'EXCESSIVE'
                          ? 'border-red-500/45 bg-red-500/15 text-red-200'
                          : dashboard.liveSpreadEvaluation.classification === 'HIGH'
                            ? 'border-amber-500/45 bg-amber-500/15 text-amber-200'
                            : 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                      }`}
                    >
                      {dashboard.liveSpreadEvaluation.classification}
                    </span>
                    <span className="text-slate-300">
                      {dashboard.liveSpreadEvaluation.spreadPoints != null
                        ? `${dashboard.liveSpreadEvaluation.spreadPoints.toFixed(1)} pts`
                        : 'DATA UNAVAILABLE'}{' '}
                      ({dashboard.liveSpreadEvaluation.symbol} · {dashboard.liveSpreadEvaluation.digits}d)
                    </span>
                  </div>
                )}
              </div>

              <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3 text-xs">
                <label className="block">
                  <span className="text-slate-400">Max Acceptable Spread (Pts)</span>
                  <input
                    type="number"
                    min="10"
                    max="500"
                    value={maxSpreadPoints}
                    onChange={(e) => setMaxSpreadPoints(Number(e.target.value))}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-400">Filter Sensitivity</span>
                  <select
                    value={spreadSensitivity}
                    onChange={(e) => setSpreadSensitivity(e.target.value as SpreadSensitivity)}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                  >
                    <option value="CONSERVATIVE">CONSERVATIVE</option>
                    <option value="BALANCED">BALANCED</option>
                    <option value="AGGRESSIVE">AGGRESSIVE</option>
                  </select>
                </label>
                <label className="block">
                  <span className="text-slate-400">Min Net R:R After Costs</span>
                  <input
                    type="number"
                    step="0.1"
                    min="0.8"
                    max="5.0"
                    value={spreadMinNetRr}
                    onChange={(e) => setSpreadMinNetRr(Number(e.target.value))}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-400">Commission ($/Lot)</span>
                  <input
                    type="number"
                    step="0.5"
                    min="0"
                    max="50"
                    value={spreadCommissionPerLot}
                    onChange={(e) => setSpreadCommissionPerLot(Number(e.target.value))}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-400">Est. Slippage (Pts)</span>
                  <input
                    type="number"
                    min="0"
                    max="50"
                    value={spreadSlippagePoints}
                    onChange={(e) => setSpreadSlippagePoints(Number(e.target.value))}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-400">Max Quote Age (s)</span>
                  <input
                    type="number"
                    min="2"
                    max="120"
                    value={spreadMaxQuoteAgeSeconds}
                    onChange={(e) => setSpreadMaxQuoteAgeSeconds(Number(e.target.value))}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-400">XM Gold Symbol</span>
                  <input
                    type="text"
                    value={spreadDefaultSymbol}
                    onChange={(e) => setSpreadDefaultSymbol(e.target.value.toUpperCase())}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-400">Digits (2 or 3)</span>
                  <input
                    type="number"
                    min="1"
                    max="5"
                    value={spreadDefaultDigits}
                    onChange={(e) => {
                      const d = Math.max(1, Math.min(5, Number(e.target.value) || 2));
                      setSpreadDefaultDigits(d);
                      setSpreadDefaultPointSize(Number(Math.pow(10, -d).toFixed(d)));
                    }}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                  />
                </label>
                <label className="block">
                  <span className="text-slate-400">Point Size</span>
                  <input
                    type="number"
                    step="0.001"
                    min="0.0001"
                    max="1"
                    value={spreadDefaultPointSize}
                    onChange={(e) => setSpreadDefaultPointSize(Number(e.target.value))}
                    className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
                  />
                </label>
                <div className="flex items-end">
                  <label className="w-full flex items-center justify-between gap-2 px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-200 cursor-pointer">
                    <span>Allow HIGH Spread</span>
                    <input
                      type="checkbox"
                      checked={allowHighSpreadTrades}
                      onChange={(e) => setAllowHighSpreadTrades(e.target.checked)}
                      className="accent-[#D4A853]"
                    />
                  </label>
                </div>
              </div>

              <div className="flex justify-end pt-1">
                <button
                  type="submit"
                  disabled={actionBusy}
                  className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-[#D4A853] text-[#0B0F17] text-xs font-semibold hover:bg-[#E0B866] disabled:opacity-50"
                >
                  <Save className="w-3.5 h-3.5" />
                  Save Admin &amp; Spread Policy
                </button>
              </div>
            </div>
          </form>
        )}

        {/* Subscribers Table */}
        {dashboard && (
          <div
            ref={subscribersRef}
            id="admin-subscribers-section"
            className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 pb-3">
              <div className="flex items-center gap-2">
                <Users className="w-4 h-4 text-[#E5B85C]" />
                <h2 className="text-sm font-semibold text-slate-100">
                  Subscribers &amp; Test Accounts ({filteredUsers.length} / {dashboard.users.length})
                </h2>
              </div>
              <span className="text-xs text-slate-400">
                API keys masked to last 4 digits · Auto ON/OFF controlled by user only
              </span>
            </div>

            {/* Search & Filter Controls */}
            <div className="flex flex-wrap items-center justify-between gap-3">
              <div className="relative flex-1 min-w-[220px] max-w-md">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="search"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  placeholder="Search by Name / Phone"
                  aria-label="Search by Name / Phone"
                  className="w-full min-h-[42px] pl-9 pr-3 py-2 rounded-lg bg-[#0B0F17] border border-white/12 text-xs text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#D4A853]"
                />
              </div>

              <div className="flex flex-wrap items-center gap-1.5">
                {(
                  [
                    { key: 'ALL', label: 'All' },
                    { key: 'PENDING', label: 'Pending' },
                    { key: 'APPROVED', label: 'Approved' },
                    { key: 'TEST', label: 'Test Accounts' },
                  ] as const
                ).map((tab) => (
                  <button
                    key={tab.key}
                    type="button"
                    onClick={() => setUserFilter(tab.key)}
                    className={`min-h-[38px] px-3 py-1.5 rounded-lg border text-xs font-semibold transition-colors whitespace-nowrap ${
                      userFilter === tab.key
                        ? 'border-[#D4A853] bg-[#D4A853]/20 text-[#E5B85C]'
                        : 'border-white/10 bg-[#0B0F17] text-slate-400 hover:text-slate-100'
                    }`}
                  >
                    {tab.label}
                  </button>
                ))}
              </div>
            </div>

            {filteredUsers.length === 0 ? (
              <div className="py-10 text-center text-xs text-slate-400">
                No matching subscribers found.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-400 border-b border-white/8">
                      <th className="pb-2.5 pr-3 font-medium">Name &amp; Phone</th>
                      <th className="pb-2.5 pr-3 font-medium">Plan &amp; Amount</th>
                      <th className="pb-2.5 pr-3 font-medium">Payment Screenshot</th>
                      <th className="pb-2.5 pr-3 font-medium">Status</th>
                      <th className="pb-2.5 pr-3 font-medium">Expiry Date</th>
                      <th className="pb-2.5 pr-3 font-medium">Broker &amp; Setup Status</th>
                      <th className="pb-2.5 pr-3 font-medium">Auto</th>
                      <th className="pb-2.5 pr-3 font-medium">Feed Access</th>
                      <th className="pb-2.5 font-medium text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/6">
                    {filteredUsers.map((u) => (
                      <tr key={u.id} className="hover:bg-white/[0.02]">
                        <td className="py-3 pr-3">
                          <div className="font-semibold text-slate-100">{u.fullName}</div>
                          <div className="font-mono text-[11px] text-slate-400">{u.phone}</div>
                        </td>
                        <td className="py-3 pr-3 font-mono">
                          <div className="text-slate-100">{u.planLabel}</div>
                          <div className="text-[11px] text-[#E5B85C]">{u.amountLabel}</div>
                        </td>
                        <td className="py-3 pr-3 font-mono">
                          <div className="text-[11px] text-slate-300">
                            {u.paymentMethod} · {u.transactionId || 'No TxID'}
                          </div>
                          {u.screenshotDataUrl ? (
                            <button
                              type="button"
                              onClick={() =>
                                setPreviewScreenshot({
                                  name: u.fullName,
                                  url: u.screenshotDataUrl!,
                                  txId: u.transactionId,
                                })
                              }
                              className="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded border border-[#D4A853]/35 bg-[#D4A853]/10 text-[#E5B85C] text-[11px]"
                            >
                              <Eye className="w-3 h-3" />
                              View Proof
                            </button>
                          ) : (
                            <span className="text-[11px] text-slate-500">No image</span>
                          )}
                        </td>
                        <td className="py-3 pr-3">
                          <span
                            className={`px-2 py-0.5 rounded border text-[11px] font-semibold ${
                              u.status === 'ACTIVE'
                                ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                                : u.status === 'PENDING'
                                  ? 'border-amber-500/35 bg-amber-500/10 text-amber-300'
                                  : 'border-red-500/35 bg-red-500/10 text-red-300'
                            }`}
                          >
                            {u.status}
                          </span>
                        </td>
                        <td className="py-3 pr-3 font-mono text-slate-300 whitespace-nowrap">
                          {u.status === 'BLOCKED'
                            ? 'Blocked'
                            : u.status === 'EXPIRED'
                              ? u.expiresAt
                                ? `Expired (${u.expiresAt.slice(0, 10)})`
                                : 'Rejected / Expired'
                              : u.expiresAt
                                ? `${u.expiresAt.slice(0, 10)} (${u.daysLeft}d)`
                                : 'Not Approved'}
                        </td>
                        <td className="py-3 pr-3 font-mono">
                          <div className="flex flex-wrap items-center gap-1.5">
                            <span className="text-slate-200 font-sans font-medium">
                              {u.brokerName} ({u.accountType})
                            </span>
                            <span
                              className={`px-1.5 py-0.5 rounded border text-[10px] font-semibold ${
                                u.brokerSetupWrongAccount
                                  ? 'border-red-500/40 bg-red-950/30 text-red-300'
                                  : u.brokerSetupComplete
                                    ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                                    : 'border-amber-500/35 bg-amber-500/10 text-amber-300'
                              }`}
                            >
                              {u.brokerSetupWrongAccount
                                ? 'Wrong Type'
                                : u.brokerSetupComplete
                                  ? 'Complete'
                                  : 'Incomplete'}
                            </span>
                          </div>
                          <div className="text-[11px] text-slate-400 mt-0.5">
                            MT5 #{u.mt5Login} · Key:{' '}
                            {u.hasBrokerApiKey ? `••••${u.brokerApiKeyLast4}` : 'None'}
                          </div>
                        </td>
                        <td className="py-3 pr-3 font-mono">
                          <span
                            className={`px-1.5 py-0.5 rounded border text-[11px] ${
                              u.autoTradeEnabled
                                ? 'border-emerald-500/30 text-emerald-300'
                                : 'border-white/10 text-slate-400'
                            }`}
                          >
                            {u.autoTradeEnabled ? 'AUTO ON' : 'OFF'}
                          </span>
                        </td>
                        <td className="py-3 pr-3 font-mono">
                          <span
                            className={`text-[11px] font-semibold ${
                              u.feedAccess ? 'text-emerald-400' : 'text-red-400'
                            }`}
                          >
                            {u.feedAccess ? 'ALLOWED' : 'PAUSED / OFF'}
                          </span>
                        </td>
                        <td className="py-3 text-right whitespace-nowrap">
                          <div className="inline-flex flex-wrap justify-end gap-1">
                            <button
                              type="button"
                              disabled={actionBusy}
                              onClick={() => void handleLoginAsUser(u.id)}
                              className="inline-flex items-center gap-1 px-2.5 py-1 rounded bg-[#D4A853] text-[#0B0F17] text-[11px] font-bold hover:bg-[#E0B866] disabled:opacity-40"
                            >
                              <UserCheck className="w-3 h-3" />
                              Login As This User
                            </button>
                            <button
                              type="button"
                              disabled={actionBusy}
                              onClick={() => void handleUserAction(u.id, 'APPROVE')}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded bg-emerald-600/90 text-white text-[10px] font-semibold hover:bg-emerald-500 disabled:opacity-40"
                            >
                              <CheckCircle2 className="w-3 h-3" />
                              {u.status === 'BLOCKED' ? 'UNBLOCK' : 'APPROVE'}
                            </button>
                            <button
                              type="button"
                              disabled={actionBusy}
                              onClick={() => void handleUserAction(u.id, 'REJECT')}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-amber-500/30 bg-amber-950/30 text-amber-200 text-[10px] font-semibold disabled:opacity-40"
                            >
                              <XCircle className="w-3 h-3" />
                              REJECT
                            </button>
                            <button
                              type="button"
                              disabled={actionBusy || u.status === 'BLOCKED'}
                              title={
                                u.status === 'BLOCKED'
                                  ? 'Click UNBLOCK first before extending subscription days'
                                  : 'Add 7 days and activate subscription'
                              }
                              onClick={() => void handleUserAction(u.id, 'EXTEND_7_DAYS')}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-[#D4A853]/35 bg-[#D4A853]/10 text-[#E5B85C] text-[10px] font-semibold disabled:opacity-40"
                            >
                              <CalendarPlus className="w-3 h-3" />
                              EXTEND 7 DAYS
                            </button>
                            <button
                              type="button"
                              disabled={actionBusy || u.status === 'BLOCKED'}
                              onClick={() => void handleUserAction(u.id, 'BLOCK')}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-red-500/35 bg-red-950/30 text-red-300 text-[10px] font-semibold disabled:opacity-40"
                            >
                              <Ban className="w-3 h-3" />
                              BLOCK
                            </button>
                            {u.feedAccess ? (
                              <button
                                type="button"
                                disabled={actionBusy}
                                onClick={() => void handleUserAction(u.id, 'PAUSE_FEED')}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-white/15 bg-white/5 text-slate-200 text-[10px] font-semibold disabled:opacity-40"
                              >
                                <Pause className="w-3 h-3" />
                                PAUSE FEED
                              </button>
                            ) : (
                              <button
                                type="button"
                                disabled={actionBusy || u.status !== 'ACTIVE'}
                                title={
                                  u.status !== 'ACTIVE'
                                    ? `Approve or Extend 7 Days first while account is ${u.status}`
                                    : 'Resume Proxy Gold feed access'
                                }
                                onClick={() => void handleUserAction(u.id, 'RESUME_FEED')}
                                className="inline-flex items-center gap-1 px-2 py-1 rounded border border-emerald-500/35 bg-emerald-950/30 text-emerald-300 text-[10px] font-semibold disabled:opacity-40"
                              >
                                <Play className="w-3 h-3" />
                                RESUME FEED
                              </button>
                            )}
                            <button
                              type="button"
                              disabled={actionBusy}
                              onClick={() => {
                                setResetPinTarget({
                                  id: u.id,
                                  fullName: u.fullName,
                                  phone: u.phone,
                                });
                                setResetPinMode('GENERATE_CODE');
                                setSubscriberTempPin('');
                                setGeneratedResetResult(null);
                                setCopiedResetCode(false);
                              }}
                              className="inline-flex items-center gap-1 px-2 py-1 rounded border border-sky-500/35 bg-sky-950/30 text-sky-200 text-[10px] font-semibold hover:bg-sky-900/40"
                            >
                              <KeyRound className="w-3 h-3" />
                              RESET PIN
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}
      </div>
      </div>

      {/* Payment Screenshot Modal */}
      {previewScreenshot && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setPreviewScreenshot(null)}
        >
          <div
            className="max-w-lg w-full bg-[#111722] border border-white/15 rounded-lg p-4 space-y-3"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/8 pb-2">
              <div className="text-xs font-semibold text-slate-100">
                MoMo Screenshot · {previewScreenshot.name} ({previewScreenshot.txId})
              </div>
              <button
                type="button"
                onClick={() => setPreviewScreenshot(null)}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <img
              src={previewScreenshot.url}
              alt="Payment Screenshot"
              className="w-full max-h-[70vh] object-contain rounded border border-white/10 bg-[#0B0F17]"
            />
          </div>
        </div>
      )}

      {/* Subscriber PIN Reset Modal */}
      {resetPinTarget && (
        <div
          className="fixed inset-0 z-50 bg-black/80 flex items-center justify-center p-4"
          onClick={() => setResetPinTarget(null)}
        >
          <div
            className="max-w-md w-full bg-[#111722] border border-white/15 rounded-xl p-5 space-y-4"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-white/8 pb-3">
              <div>
                <h3 className="text-sm font-semibold text-[#E5B85C] flex items-center gap-1.5">
                  <KeyRound className="w-4 h-4" />
                  Reset Subscriber PIN
                </h3>
                <p className="text-[11px] text-slate-400 mt-0.5 font-mono">
                  {resetPinTarget.fullName} · {resetPinTarget.phone}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setResetPinTarget(null)}
                className="p-1 text-slate-400 hover:text-white"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => {
                  setResetPinMode('GENERATE_CODE');
                  setGeneratedResetResult(null);
                }}
                className={`py-2 px-3 rounded border text-xs font-semibold transition-colors ${
                  resetPinMode === 'GENERATE_CODE'
                    ? 'border-[#D4A853] bg-[#D4A853]/15 text-[#E5B85C]'
                    : 'border-white/10 bg-[#0B0F17] text-slate-400 hover:text-slate-200'
                }`}
              >
                6-Digit Reset Code
              </button>
              <button
                type="button"
                onClick={() => {
                  setResetPinMode('SET_PIN');
                  setGeneratedResetResult(null);
                }}
                className={`py-2 px-3 rounded border text-xs font-semibold transition-colors ${
                  resetPinMode === 'SET_PIN'
                    ? 'border-[#D4A853] bg-[#D4A853]/15 text-[#E5B85C]'
                    : 'border-white/10 bg-[#0B0F17] text-slate-400 hover:text-slate-200'
                }`}
              >
                Set Temporary PIN
              </button>
            </div>

            {generatedResetResult && resetPinMode === 'GENERATE_CODE' ? (
              <div className="p-4 rounded-lg border border-emerald-500/35 bg-emerald-950/20 space-y-2.5 text-center">
                <div className="text-[11px] text-emerald-200">
                  Share this one-time Reset Code with {generatedResetResult.fullName} (expires in 15 min):
                </div>
                <div className="text-2xl font-mono font-bold tracking-[0.25em] text-[#E5B85C]">
                  {generatedResetResult.code}
                </div>
                <button
                  type="button"
                  onClick={() => {
                    void navigator.clipboard.writeText(generatedResetResult.code);
                    setCopiedResetCode(true);
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-emerald-500/35 bg-emerald-500/15 text-emerald-200 text-xs font-semibold hover:bg-emerald-500/25"
                >
                  {copiedResetCode ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                  {copiedResetCode ? 'Copied Code' : 'Copy Reset Code'}
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubscriberResetPin} className="space-y-3">
                {resetPinMode === 'GENERATE_CODE' ? (
                  <p className="text-xs text-slate-300 leading-relaxed">
                    Generates a single-use 6-digit code valid for 15 minutes. The trader enters this code on the Login screen (&ldquo;Forgot PIN / Password?&rdquo;) to choose their own new PIN.
                  </p>
                ) : (
                  <label className="block text-xs">
                    <span className="text-slate-300">New Temporary PIN / Password (min 4 chars)</span>
                    <input
                      type="text"
                      required
                      minLength={4}
                      placeholder="e.g. 2468 or TempPin99"
                      value={subscriberTempPin}
                      onChange={(e) => setSubscriberTempPin(e.target.value)}
                      className="mt-1.5 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono focus:outline-none focus:border-[#D4A853]"
                    />
                  </label>
                )}

                <div className="flex justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={() => setResetPinTarget(null)}
                    className="px-3 py-2 rounded border border-white/12 text-xs text-slate-300 hover:text-white"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    disabled={actionBusy}
                    className="px-4 py-2 rounded bg-[#D4A853] text-[#0B0F17] text-xs font-bold hover:bg-[#E0B866] disabled:opacity-50"
                  >
                    {actionBusy
                      ? 'Processing...'
                      : resetPinMode === 'GENERATE_CODE'
                        ? 'Generate 6-Digit Code'
                        : 'Set New PIN Now'}
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
