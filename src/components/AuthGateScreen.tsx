import { useEffect, useState } from 'react';
import {
  ShieldCheck,
  Lock,
  Upload,
  CheckCircle2,
  Clock,
  AlertTriangle,
  MessageCircle,
  LogOut,
  RefreshCw,
  Cloud,
} from 'lucide-react';
import type { User as FirebaseUser } from 'firebase/auth';
import type {
  BrokerAccountSetup,
  BrokerPreset,
  PublicBusinessConfig,
  SubscriptionPlan,
  UserPublicProfile,
  UserSyncBundle,
} from '../types/connectivity';
import {
  BrokerAccountSetupChecklist,
  isSetupValidClient,
} from './BrokerAccountSetupChecklist';
import {
  auth,
  formatFirestoreErrorForUi,
  saveUserBundleToFirestore,
  signInWithGooglePopup,
  signOutFirebase,
  subscribeFirebaseAuth,
  syncRenewalToFirestore,
} from '../lib/firebase';

interface AuthGateScreenProps {
  loggedInUser: UserPublicProfile | null;
  publicConfig: PublicBusinessConfig | null;
  onAuthenticated: (user: UserPublicProfile) => Promise<void>;
  onRefreshSession: () => Promise<void>;
  onLogout: () => Promise<void>;
  onNavigateAdmin: () => void;
  isImpersonating?: boolean;
  onBackToAdmin?: () => void;
}

export function AuthGateScreen({
  loggedInUser,
  publicConfig,
  onAuthenticated,
  onRefreshSession,
  onLogout,
  onNavigateAdmin,
  isImpersonating = false,
  onBackToAdmin,
}: AuthGateScreenProps) {
  const [mode, setMode] = useState<'login' | 'signup'>('login');
  const [error, setError] = useState<string | null>(null);
  const [cloudNotice, setCloudNotice] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [firebaseUser, setFirebaseUser] = useState<FirebaseUser | null>(() => auth.currentUser);

  useEffect(() => {
    return subscribeFirebaseAuth((fbUser) => {
      setFirebaseUser(fbUser);
    });
  }, []);

  // Login & PIN reset state
  const [loginPhone, setLoginPhone] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  const [showResetPin, setShowResetPin] = useState(false);
  const [resetMethod, setResetMethod] = useState<'google' | 'code'>('google');
  const [resetPhone, setResetPhone] = useState('');
  const [resetCode, setResetCode] = useState('');
  const [resetNewPin, setResetNewPin] = useState('');
  const [resetConfirmPin, setResetConfirmPin] = useState('');

  // Signup state
  const [fullName, setFullName] = useState('');
  const [phone, setPhone] = useState('');
  const [password, setPassword] = useState('');
  const [brokerPreset, setBrokerPreset] = useState<BrokerPreset>('XM');
  const [customBrokerName, setCustomBrokerName] = useState('');
  const [brokerServer, setBrokerServer] = useState('');
  const [mt5Login, setMt5Login] = useState('');
  const [brokerApiKey, setBrokerApiKey] = useState('');
  const [accountType, setAccountType] = useState<'Demo' | 'Live'>('Demo');
  const [startingBalance, setStartingBalance] = useState('138.76');
  const [brokerSetup, setBrokerSetup] = useState<BrokerAccountSetup>({
    platformMt5: false,
    accountStandard: false,
    currencyUsd: false,
    leverageValid: false,
    hasWrongMt4OrCtrader: false,
    hasWrongCentOrEcn: false,
    hasWrongZmwOrEur: false,
    selectedBrokerPreset: 'XM',
    accountVariant: 'STANDARD',
    confirmedAt: null,
  });
  const [plan, setPlan] = useState<SubscriptionPlan>('weekly');
  const [paymentMethod, setPaymentMethod] = useState<'Airtel MoMo' | 'MTN MoMo'>('Airtel MoMo');
  const [transactionId, setTransactionId] = useState('');
  const [screenshotDataUrl, setScreenshotDataUrl] = useState<string | null>(null);
  const [screenshotName, setScreenshotName] = useState<string>('');

  // Renewal state for expired user
  const [renewPlan, setRenewPlan] = useState<SubscriptionPlan>(loggedInUser?.plan ?? 'weekly');
  const [renewMethod, setRenewMethod] = useState<'Airtel MoMo' | 'MTN MoMo'>('Airtel MoMo');
  const [renewTxId, setRenewTxId] = useState('');
  const [renewScreenshot, setRenewScreenshot] = useState<string | null>(null);

  const plans = publicConfig?.plans ?? {
    weekly: { label: 'Weekly', kwacha: 150, usd: 5, days: 7 },
    monthly: { label: 'Monthly', kwacha: 500, usd: 20, days: 30 },
    quarterly: { label: 'Quarterly', kwacha: 1200, usd: 45, days: 90 },
  };
  const momo = publicConfig?.momo ?? {
    airtelNumber: '+260 970 000 000',
    mtnNumber: '+260 960 000 000',
    recipientName: 'Gold AI Trader Admin',
    whatsappRenewNumber: '+260970000000',
  };

  const selectedPlanSpec = plans[plan];
  const selectedRenewSpec = plans[renewPlan];

  const handleFileRead = (
    file: File | undefined,
    setter: (val: string | null) => void,
    nameSetter?: (name: string) => void
  ) => {
    if (!file) return;
    if (file.size > 3_500_000) {
      setError('Screenshot image must be under 3.5 MB.');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      if (typeof reader.result === 'string') {
        setter(reader.result);
        nameSetter?.(file.name);
      }
    };
    reader.readAsDataURL(file);
  };

  const handleGoogleConnect = async () => {
    setError(null);
    setCloudNotice(null);
    setIsSubmitting(true);
    try {
      const { user: fbUser, idToken } = await signInWithGooglePopup();
      const res = await fetch('/api/auth/firebase-sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ idToken }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        needsSignup?: boolean;
        restoredFromCloud?: boolean;
        user?: UserPublicProfile;
        syncBundle?: UserSyncBundle;
      };
      if (!res.ok || !json.ok) {
        setError(json.error || 'Google cloud sync failed');
        return;
      }
      if (json.user) {
        if (json.syncBundle && !json.restoredFromCloud) {
          try {
            await saveUserBundleToFirestore(json.syncBundle, {
              asAdmin: fbUser.email?.toLowerCase() === 'muyobakuyewana@gmail.com',
            });
          } catch {
            // Firestore write logged by handleFirestoreError if non-blocking
          }
        }
        await onAuthenticated(json.user);
        return;
      }
      if (json.needsSignup) {
        setMode('signup');
        if (!fullName && fbUser.displayName) {
          setFullName(fbUser.displayName);
        }
        setCloudNotice(
          `Google account connected (${fbUser.email}). Complete signup below so your trader account stays saved in Firestore.`
        );
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to connect Google account');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: loginPhone, password: loginPassword }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        user?: UserPublicProfile;
        syncBundle?: UserSyncBundle;
      };
      if (!res.ok || !json.ok || !json.user) {
        if (auth.currentUser) {
          try {
            const idToken = await auth.currentUser.getIdToken();
            const syncRes = await fetch('/api/auth/firebase-sync', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ idToken }),
            });
            const syncJson = (await syncRes.json().catch(() => ({}))) as {
              ok?: boolean;
              user?: UserPublicProfile;
            };
            if (syncRes.ok && syncJson.ok && syncJson.user) {
              await onAuthenticated(syncJson.user);
              return;
            }
          } catch {
            // Fall through to normal error message
          }
        }
        setError(json.error || `Login failed (HTTP ${res.status})`);
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
      await onAuthenticated(json.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error during login');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleResetPinSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setCloudNotice(null);

    const trimmedNew = resetNewPin.trim();
    if (trimmedNew.length < 4 || trimmedNew.length > 128) {
      setError('New PIN / Password must be at least 4 characters.');
      return;
    }
    if (trimmedNew !== resetConfirmPin.trim()) {
      setError('New PIN / Password and confirmation do not match.');
      return;
    }

    setIsSubmitting(true);
    try {
      let firebaseIdToken: string | undefined;
      if (resetMethod === 'google') {
        const { idToken } = await signInWithGooglePopup();
        firebaseIdToken = idToken;
      }

      const res = await fetch('/api/auth/reset-pin', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          ...(resetMethod === 'google'
            ? { firebaseIdToken, phone: resetPhone.trim() || loginPhone.trim() }
            : { phone: resetPhone.trim(), resetCode: resetCode.trim() }),
          newPin: trimmedNew,
        }),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        user?: UserPublicProfile;
        syncBundle?: UserSyncBundle;
      };
      if (!res.ok || !json.ok || !json.user) {
        setError(json.error || 'Unable to reset PIN / Password.');
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
      setResetNewPin('');
      setResetConfirmPin('');
      setResetCode('');
      setShowResetPin(false);
      await onAuthenticated(json.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unable to reset PIN / Password.');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleSignup = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (
      brokerSetup.hasWrongMt4OrCtrader ||
      brokerSetup.hasWrongZmwOrEur
    ) {
      setError(
        'Unsupported Platform or Currency — Please use an MT5 account (Standard, Cent/Micro, or ECN/Raw) in USD or USC Cents.'
      );
      return;
    }
    if (!isSetupValidClient(brokerSetup)) {
      setError('Complete Broker Setup First: MT5 Platform + Account Type + USD/USC Currency + Leverage ≥ 1:200');
      return;
    }

    const effectiveBrokerName =
      brokerPreset === 'Other' ? customBrokerName.trim() || 'Other' : brokerPreset;

    setIsSubmitting(true);
    try {
      const firebaseIdToken = auth.currentUser
        ? await auth.currentUser.getIdToken().catch(() => undefined)
        : undefined;
      const res = await fetch('/api/auth/signup', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fullName,
          phone,
          password,
          brokerName: effectiveBrokerName,
          brokerServer,
          mt5Login,
          brokerApiKey,
          brokerSetup: { ...brokerSetup, selectedBrokerPreset: brokerPreset },
          accountType,
          startingBalance: Number(startingBalance) || 138.76,
          plan,
          paymentMethod,
          transactionId,
          screenshotDataUrl,
          firebaseIdToken,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        user?: UserPublicProfile;
        syncBundle?: UserSyncBundle;
      };
      if (!res.ok || !json.ok || !json.user) {
        setError(json.error || `Signup failed (HTTP ${res.status})`);
        return;
      }
      if (auth.currentUser && json.syncBundle) {
        try {
          await saveUserBundleToFirestore(json.syncBundle, {
            asAdmin:
              auth.currentUser.email?.toLowerCase() === 'muyobakuyewana@gmail.com',
          });
          setCloudNotice(
            `Account created and backed up permanently to Google Firestore (${auth.currentUser.email}).`
          );
        } catch (cloudErr) {
          console.error('Signup Firestore backup warning:', formatFirestoreErrorForUi(cloudErr));
        }
      }
      await onAuthenticated(json.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error during signup');
    } finally {
      setIsSubmitting(false);
    }
  };

  const handleRenewSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsSubmitting(true);
    try {
      const res = await fetch('/api/auth/renew', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          plan: renewPlan,
          paymentMethod: renewMethod,
          transactionId: renewTxId,
          screenshotDataUrl: renewScreenshot,
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        user?: UserPublicProfile;
        syncBundle?: UserSyncBundle;
      };
      if (!res.ok || !json.ok || !json.user) {
        setError(json.error || `Renewal submission failed (HTTP ${res.status})`);
        return;
      }
      if (auth.currentUser && json.syncBundle) {
        try {
          await syncRenewalToFirestore(json.syncBundle);
        } catch (cloudErr) {
          console.error('Renewal Firestore backup warning:', formatFirestoreErrorForUi(cloudErr));
        }
      }
      await onAuthenticated(json.user);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Network error submitting renewal');
    } finally {
      setIsSubmitting(false);
    }
  };

  const whatsappClean = (momo.whatsappRenewNumber || '').replace(/[^\d]/g, '');
  const whatsappHref = `https://wa.me/${whatsappClean}?text=${encodeURIComponent(
    `Hello Admin, I want to renew my Gold AI Trader subscription (${loggedInUser?.fullName ?? ''} · ${loggedInUser?.phone ?? ''}).`
  )}`;

  // Locked Subscription Gate for logged-in PENDING / EXPIRED / BLOCKED user
  if (loggedInUser && loggedInUser.status !== 'ACTIVE') {
    const isPending = loggedInUser.status === 'PENDING';
    const isExpired = loggedInUser.status === 'EXPIRED';
    const isBlocked = loggedInUser.status === 'BLOCKED';

    return (
      <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex items-center justify-center p-4">
        <div className="w-full max-w-xl border border-white/10 bg-[#111722] rounded-xl p-6 space-y-5">
          <div className="flex items-start justify-between gap-4 border-b border-white/8 pb-4">
            <div>
              <div className="font-display text-lg font-bold text-[#E5B85C]">
                Gold AI Trader
              </div>
              <p className="text-xs text-slate-400 mt-0.5">
                Trader: <span className="text-slate-200 font-medium">{loggedInUser.fullName}</span> ·{' '}
                <span className="font-mono">{loggedInUser.phone}</span>
              </p>
            </div>
            <button
              type="button"
              onClick={onLogout}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded border border-white/12 text-xs text-slate-300 hover:text-white"
            >
              <LogOut className="w-3.5 h-3.5" />
              Logout
            </button>
          </div>

          {isImpersonating && onBackToAdmin && (
            <div className="p-3 rounded-lg border border-[#D4A853]/40 bg-[#D4A853]/10 flex flex-wrap items-center justify-between gap-2 text-xs">
              <span className="text-[#E5B85C]">
                Admin Preview: this account is currently <strong>{loggedInUser.status}</strong>. Approve or extend it in Admin Console to unlock the trading portal.
              </span>
              <button
                type="button"
                onClick={onBackToAdmin}
                className="px-3 py-1.5 rounded bg-[#D4A853] text-[#0B0F17] font-bold hover:bg-[#E0B866]"
              >
                Return to /admin
              </button>
            </div>
          )}

          {isPending && (
            <div className="p-4 rounded-lg border border-amber-500/35 bg-amber-950/20 space-y-3">
              <div className="flex items-center gap-2 text-amber-200 font-semibold text-sm">
                <Clock className="w-4 h-4 text-amber-400" />
                STATUS: PENDING APPROVAL — No Proxy Feed Yet
              </div>
              <p className="text-xs text-slate-300 leading-relaxed">
                Your payment proof ({loggedInUser.planLabel} · {loggedInUser.amountLabel} via{' '}
                {loggedInUser.paymentMethod}
                {loggedInUser.transactionId ? ` · TxID: ${loggedInUser.transactionId}` : ''}) has been submitted.
                Once Admin approves your account, live Proxy GOLD feed and bot tools unlock immediately.
              </p>
              <div className="flex flex-wrap gap-2.5 pt-1">
                <button
                  type="button"
                  onClick={onRefreshSession}
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md bg-[#D4A853] text-[#0B0F17] text-xs font-semibold hover:bg-[#E0B866]"
                >
                  <RefreshCw className="w-3.5 h-3.5" />
                  Check Approval Status
                </button>
                <a
                  href={whatsappHref}
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-emerald-500/35 bg-emerald-500/10 text-emerald-200 text-xs font-medium hover:bg-emerald-500/20"
                >
                  <MessageCircle className="w-3.5 h-3.5" />
                  WhatsApp Admin
                </a>
                {!loggedInUser.firebaseLinked && (
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => void handleGoogleConnect()}
                    className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-sky-500/35 bg-sky-500/10 text-sky-200 text-xs font-medium hover:bg-sky-500/20 disabled:opacity-50"
                  >
                    <Cloud className="w-3.5 h-3.5" />
                    Save Account to Google Cloud
                  </button>
                )}
              </div>
              {loggedInUser.firebaseLinked && (
                <p className="text-[11px] text-emerald-300/90 font-mono">
                  Cloud Synced: {loggedInUser.firebaseEmail || firebaseUser?.email}
                </p>
              )}
            </div>
          )}

          {isBlocked && (
            <div className="p-4 rounded-lg border border-red-500/35 bg-red-950/20 space-y-3">
              <div className="flex items-center gap-2 text-red-200 font-semibold text-sm">
                <AlertTriangle className="w-4 h-4 text-red-400" />
                Account Blocked — Proxy Feed Disabled
              </div>
              <p className="text-xs text-slate-300">
                Your subscription access has been suspended by Admin. Contact support via WhatsApp if you believe this is an error.
              </p>
              <a
                href={whatsappHref}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-md border border-emerald-500/35 bg-emerald-500/10 text-emerald-200 text-xs font-medium hover:bg-emerald-500/20"
              >
                <MessageCircle className="w-3.5 h-3.5" />
                Contact Admin on WhatsApp
              </a>
            </div>
          )}

          {isExpired && (
            <div className="space-y-4">
              <div className="p-4 rounded-lg border border-red-500/35 bg-red-950/20 space-y-2">
                <div className="flex items-center gap-2 text-red-200 font-semibold text-sm">
                  <Lock className="w-4 h-4 text-red-400" />
                  Subscription Expired - Renew to Continue
                </div>
                <p className="text-xs text-slate-300">
                  Your plan has expired. Proxy GOLD feed and auto-trade execution are locked until you renew.
                </p>
                <div className="pt-1">
                  <a
                    href={whatsappHref}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1.5 px-4 py-2 rounded-md bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-500"
                  >
                    <MessageCircle className="w-3.5 h-3.5" />
                    WhatsApp Renew ({momo.whatsappRenewNumber})
                  </a>
                </div>
              </div>

              <form onSubmit={handleRenewSubmit} className="p-4 rounded-lg border border-white/10 bg-[#0B0F17] space-y-3">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-[#E5B85C]">
                  Or Submit MoMo Renewal Proof Now
                </h3>

                <div className="grid grid-cols-3 gap-2">
                  {(['weekly', 'monthly', 'quarterly'] as SubscriptionPlan[]).map((pKey) => {
                    const pSpec = plans[pKey];
                    return (
                      <button
                        key={pKey}
                        type="button"
                        onClick={() => setRenewPlan(pKey)}
                        className={`p-2.5 rounded border text-left text-xs transition-colors ${
                          renewPlan === pKey
                            ? 'border-[#D4A853] bg-[#D4A853]/12 text-slate-100'
                            : 'border-white/10 bg-[#111722] text-slate-400'
                        }`}
                      >
                        <div className="font-semibold">{pSpec.label}</div>
                        <div className="font-mono text-[#E5B85C] mt-0.5">
                          K{pSpec.kwacha} / ${pSpec.usd}
                        </div>
                        <div className="text-[10px] text-slate-400">{pSpec.days} days</div>
                      </button>
                    );
                  })}
                </div>

                <div className="p-3 rounded border border-white/8 bg-[#111722] text-xs space-y-1 font-mono">
                  <div className="text-slate-400 font-sans">Send Amount: <strong className="text-[#E5B85C]">K{selectedRenewSpec.kwacha} / ${selectedRenewSpec.usd}</strong> to {momo.recipientName}</div>
                  <div>Airtel MoMo: <span className="text-slate-100">{momo.airtelNumber}</span></div>
                  <div>MTN MoMo: <span className="text-slate-100">{momo.mtnNumber}</span></div>
                </div>

                <div className="grid grid-cols-2 gap-3">
                  <label className="block text-xs">
                    <span className="text-slate-400">Payment Network</span>
                    <select
                      value={renewMethod}
                      onChange={(e) => setRenewMethod(e.target.value as 'Airtel MoMo' | 'MTN MoMo')}
                      className="mt-1 w-full px-3 py-2 rounded bg-[#111722] border border-white/12 text-slate-100 text-xs"
                    >
                      <option value="Airtel MoMo">Airtel MoMo</option>
                      <option value="MTN MoMo">MTN MoMo</option>
                    </select>
                  </label>
                  <label className="block text-xs">
                    <span className="text-slate-400">MoMo Transaction ID</span>
                    <input
                      type="text"
                      placeholder="e.g. MP260418.1234"
                      value={renewTxId}
                      onChange={(e) => setRenewTxId(e.target.value)}
                      className="mt-1 w-full px-3 py-2 rounded bg-[#111722] border border-white/12 text-slate-100 text-xs font-mono"
                    />
                  </label>
                </div>

                <label className="block text-xs">
                  <span className="text-slate-400">Upload Payment Screenshot (Optional if TxID given)</span>
                  <input
                    type="file"
                    accept="image/*"
                    onChange={(e) => handleFileRead(e.target.files?.[0], setRenewScreenshot)}
                    className="mt-1 block w-full text-xs text-slate-300"
                  />
                </label>

                {error && <p className="text-xs text-red-400">{error}</p>}

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-2 rounded-md bg-[#D4A853] text-[#0B0F17] text-xs font-semibold hover:bg-[#E0B866] disabled:opacity-50"
                >
                  {isSubmitting ? 'Submitting Renewal...' : 'Submit Renewal Payment'}
                </button>
              </form>
            </div>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex flex-col justify-center py-8 px-4">
      <div className="w-full max-w-2xl mx-auto space-y-6">
        <div className="text-center space-y-1.5">
          <div className="inline-flex items-center gap-2 px-3 py-1 rounded border border-[#D4A853]/30 bg-[#D4A853]/10 text-[#E5B85C] text-xs font-medium">
            <ShieldCheck className="w-3.5 h-3.5" />
            GOLD / XAUUSD · EMA STOCHASTIC PRO
          </div>
          <h1 className="text-2xl sm:text-3xl font-display font-bold text-slate-50">
            Gold AI Trader
          </h1>
          <p className="text-xs text-slate-400">
            H1/M15/M5 EMA 9/21/50/200 · Stochastic (14,3,3) · SMC + Gemini AI · Asian &amp; London Lusaka · OANDA/TickerAll Feed
          </p>
        </div>

        <div className="border border-white/10 bg-[#111722] rounded-xl overflow-hidden">
          <div className="grid grid-cols-2 border-b border-white/8 bg-[#0E131D]">
            <button
              type="button"
              onClick={() => {
                setMode('login');
                setShowResetPin(false);
                setError(null);
              }}
              className={`py-3.5 text-xs font-semibold uppercase tracking-wider transition-colors ${
                mode === 'login'
                  ? 'text-[#E5B85C] border-b-2 border-[#D4A853] bg-[#111722]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Login
            </button>
            <button
              type="button"
              onClick={() => {
                setMode('signup');
                setShowResetPin(false);
                setError(null);
              }}
              className={`py-3.5 text-xs font-semibold uppercase tracking-wider transition-colors ${
                mode === 'signup'
                  ? 'text-[#E5B85C] border-b-2 border-[#D4A853] bg-[#111722]'
                  : 'text-slate-400 hover:text-slate-200'
              }`}
            >
              Sign Up + Subscribe
            </button>
          </div>

          <div className="p-6 space-y-4">
            <div className="p-3 rounded-lg border border-sky-500/25 bg-[#0B0F17] flex flex-wrap items-center justify-between gap-2.5">
              <div className="flex items-center gap-2 text-xs">
                <Cloud className="w-4 h-4 text-sky-400 shrink-0" />
                {firebaseUser ? (
                  <span className="text-emerald-300">
                    Cloud account linked: <strong className="font-mono">{firebaseUser.email}</strong>
                  </span>
                ) : (
                  <span className="text-slate-300">
                    Save &amp; restore your trader account permanently via Google Firestore
                  </span>
                )}
              </div>
              <div className="flex items-center gap-2">
                {firebaseUser ? (
                  <>
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => void handleGoogleConnect()}
                      className="px-3 py-1.5 rounded border border-emerald-500/35 bg-emerald-500/15 text-emerald-200 text-[11px] font-semibold hover:bg-emerald-500/25 disabled:opacity-50"
                    >
                      Restore / Sync Account
                    </button>
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => void signOutFirebase()}
                      className="px-2.5 py-1.5 rounded border border-white/12 text-slate-400 text-[11px] hover:text-white"
                    >
                      Switch
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    disabled={isSubmitting}
                    onClick={() => void handleGoogleConnect()}
                    className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded bg-sky-500/20 border border-sky-400/40 text-sky-200 text-xs font-semibold hover:bg-sky-500/30 disabled:opacity-50"
                  >
                    <Cloud className="w-3.5 h-3.5" />
                    Continue with Google
                  </button>
                )}
              </div>
            </div>

            {cloudNotice && (
              <div className="p-3 rounded border border-emerald-500/35 bg-emerald-950/25 text-xs text-emerald-300">
                {cloudNotice}
              </div>
            )}

            {error && (
              <div className="p-3 rounded border border-red-500/35 bg-red-950/25 text-xs text-red-300">
                {error}
              </div>
            )}

            {mode === 'login' ? (
              showResetPin ? (
                <form onSubmit={handleResetPinSubmit} className="space-y-4">
                  <div className="flex items-center justify-between border-b border-white/8 pb-2.5">
                    <div className="text-xs font-semibold text-[#E5B85C]">
                      Reset Account PIN / Password
                    </div>
                    <button
                      type="button"
                      onClick={() => {
                        setShowResetPin(false);
                        setError(null);
                      }}
                      className="text-[11px] text-slate-400 hover:text-slate-200"
                    >
                      Back to Login
                    </button>
                  </div>

                  <div className="grid grid-cols-2 gap-2">
                    <button
                      type="button"
                      onClick={() => {
                        setResetMethod('google');
                        setError(null);
                      }}
                      className={`py-2 px-3 rounded border text-xs font-semibold transition-colors ${
                        resetMethod === 'google'
                          ? 'border-[#D4A853] bg-[#D4A853]/15 text-[#E5B85C]'
                          : 'border-white/10 bg-[#0B0F17] text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Verify via Google Account
                    </button>
                    <button
                      type="button"
                      onClick={() => {
                        setResetMethod('code');
                        setError(null);
                      }}
                      className={`py-2 px-3 rounded border text-xs font-semibold transition-colors ${
                        resetMethod === 'code'
                          ? 'border-[#D4A853] bg-[#D4A853]/15 text-[#E5B85C]'
                          : 'border-white/10 bg-[#0B0F17] text-slate-400 hover:text-slate-200'
                      }`}
                    >
                      Use Admin 6-Digit Code
                    </button>
                  </div>

                  {resetMethod === 'code' && (
                    <>
                      <label className="block text-xs">
                        <span className="text-slate-300">Registered Phone / WhatsApp</span>
                        <input
                          type="text"
                          required
                          placeholder="+26097..."
                          value={resetPhone}
                          onChange={(e) => setResetPhone(e.target.value)}
                          className="mt-1.5 w-full px-3.5 py-2.5 rounded-md bg-[#0B0F17] border border-white/12 text-slate-100 text-xs font-mono focus:outline-none focus:border-[#D4A853]"
                        />
                      </label>
                      <label className="block text-xs">
                        <span className="text-slate-300">6-Digit Admin Reset Code</span>
                        <input
                          type="text"
                          required
                          maxLength={12}
                          placeholder="e.g. 482910"
                          value={resetCode}
                          onChange={(e) => setResetCode(e.target.value)}
                          className="mt-1.5 w-full px-3.5 py-2.5 rounded-md bg-[#0B0F17] border border-white/12 text-slate-100 text-xs font-mono tracking-widest focus:outline-none focus:border-[#D4A853]"
                        />
                      </label>
                    </>
                  )}

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block text-xs">
                      <span className="text-slate-300">New PIN / Password (min 4 chars)</span>
                      <input
                        type="password"
                        required
                        minLength={4}
                        placeholder="Enter new PIN or password"
                        value={resetNewPin}
                        onChange={(e) => setResetNewPin(e.target.value)}
                        className="mt-1.5 w-full px-3.5 py-2.5 rounded-md bg-[#0B0F17] border border-white/12 text-slate-100 text-xs focus:outline-none focus:border-[#D4A853]"
                      />
                    </label>
                    <label className="block text-xs">
                      <span className="text-slate-300">Confirm New PIN / Password</span>
                      <input
                        type="password"
                        required
                        minLength={4}
                        placeholder="Repeat new PIN or password"
                        value={resetConfirmPin}
                        onChange={(e) => setResetConfirmPin(e.target.value)}
                        className="mt-1.5 w-full px-3.5 py-2.5 rounded-md bg-[#0B0F17] border border-white/12 text-slate-100 text-xs focus:outline-none focus:border-[#D4A853]"
                      />
                    </label>
                  </div>

                  {resetMethod === 'google' && (
                    <p className="text-[11px] text-slate-400">
                      Sign in with the Google account linked to your trader profile to set your new PIN immediately.
                    </p>
                  )}

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full py-2.5 rounded-md bg-[#D4A853] text-[#0B0F17] text-xs font-bold hover:bg-[#E0B866] disabled:opacity-50 transition-colors"
                  >
                    {isSubmitting
                      ? 'Resetting PIN...'
                      : resetMethod === 'google'
                        ? 'Verify Google & Reset PIN'
                        : 'Reset PIN with 6-Digit Code'}
                  </button>
                </form>
              ) : (
                <form onSubmit={handleLogin} className="space-y-4">
                  <label className="block text-xs">
                    <span className="text-slate-300">Phone / WhatsApp Number</span>
                    <input
                      type="text"
                      required
                      placeholder="+26097..."
                      value={loginPhone}
                      onChange={(e) => setLoginPhone(e.target.value)}
                      className="mt-1.5 w-full px-3.5 py-2.5 rounded-md bg-[#0B0F17] border border-white/12 text-slate-100 text-xs font-mono focus:outline-none focus:border-[#D4A853]"
                    />
                  </label>

                  <label className="block text-xs">
                    <div className="flex items-center justify-between">
                      <span className="text-slate-300">Account PIN / Password</span>
                      <button
                        type="button"
                        onClick={() => {
                          setShowResetPin(true);
                          setResetPhone(loginPhone);
                          setError(null);
                        }}
                        className="text-[11px] text-[#E5B85C] hover:underline"
                      >
                        Forgot PIN / Password?
                      </button>
                    </div>
                    <input
                      type="password"
                      required
                      placeholder="Enter your app PIN or password"
                      value={loginPassword}
                      onChange={(e) => setLoginPassword(e.target.value)}
                      className="mt-1.5 w-full px-3.5 py-2.5 rounded-md bg-[#0B0F17] border border-white/12 text-slate-100 text-xs focus:outline-none focus:border-[#D4A853]"
                    />
                  </label>

                  <button
                    type="submit"
                    disabled={isSubmitting}
                    className="w-full py-2.5 rounded-md bg-[#D4A853] text-[#0B0F17] text-xs font-bold hover:bg-[#E0B866] disabled:opacity-50 transition-colors"
                  >
                    {isSubmitting ? 'Signing In...' : 'Login to Gold AI Trader'}
                  </button>
                </form>
              )
            ) : (
              <form onSubmit={handleSignup} className="space-y-5">
                {/* Google Cloud Backup Banner on Signup */}
                <div
                  className={`p-3 rounded-md border flex flex-wrap items-center justify-between gap-2.5 text-xs ${
                    firebaseUser
                      ? 'border-emerald-500/40 bg-emerald-950/20 text-emerald-200'
                      : 'border-sky-500/35 bg-sky-950/20 text-sky-100'
                  }`}
                >
                  <div className="flex items-center gap-2">
                    <Cloud className="w-4 h-4 shrink-0 text-sky-400" />
                    {firebaseUser ? (
                      <span>
                        Permanent Firestore backup ready for <strong className="font-mono">{firebaseUser.email}</strong>
                      </span>
                    ) : (
                      <span>
                        <strong>Permanent Cloud Storage:</strong> Link Google before submitting so your account never gets lost when your phone is off.
                      </span>
                    )}
                  </div>
                  {!firebaseUser && (
                    <button
                      type="button"
                      disabled={isSubmitting}
                      onClick={() => void handleGoogleConnect()}
                      className="px-3 py-1.5 rounded bg-sky-500/25 border border-sky-400/45 text-sky-100 text-[11px] font-semibold hover:bg-sky-500/35 disabled:opacity-50"
                    >
                      Link Google Cloud
                    </button>
                  )}
                </div>

                {/* Red Security Notice — Never Ask for Main Password */}
                <div className="p-3 rounded-md border border-red-500/45 bg-red-950/30 flex items-start gap-2.5 text-xs text-red-200">
                  <Lock className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
                  <span>
                    <strong>Use Investor / Read-Only Password ONLY. Never send Main Password.</strong> We never ask for your MT5 Main Password or withdraw your money.
                  </span>
                </div>

                {/* Account & Broker Details */}
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-3.5">
                  <label className="block text-xs">
                    <span className="text-slate-300">Full Name *</span>
                    <input
                      type="text"
                      required
                      placeholder="John Banda"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 text-xs focus:outline-none focus:border-[#D4A853]"
                    />
                  </label>
                  <label className="block text-xs">
                    <span className="text-slate-300">Phone / WhatsApp *</span>
                    <input
                      type="text"
                      required
                      placeholder="+26097..."
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 text-xs font-mono focus:outline-none focus:border-[#D4A853]"
                    />
                  </label>
                  <label className="block text-xs">
                    <span className="text-slate-300">Create App PIN / Password (min 4 chars) *</span>
                    <input
                      type="password"
                      required
                      minLength={4}
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 text-xs focus:outline-none focus:border-[#D4A853]"
                    />
                  </label>
                  <label className="block text-xs">
                    <span className="text-slate-300">Broker Name *</span>
                    <select
                      value={brokerPreset}
                      onChange={(e) => {
                        const val = e.target.value as BrokerPreset;
                        setBrokerPreset(val);
                        setBrokerSetup((prev) => ({
                          ...prev,
                          selectedBrokerPreset: val,
                          ...(val === 'Weltrade' && !prev.accountVariant
                            ? { accountVariant: 'CENT_USC' }
                            : {}),
                        }));
                      }}
                      className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 text-xs focus:outline-none focus:border-[#D4A853]"
                    >
                      <option value="XM">XM</option>
                      <option value="Exness">Exness</option>
                      <option value="Weltrade">Weltrade (Standard / Cent)</option>
                      <option value="Other">Other MT5 Broker</option>
                    </select>
                  </label>
                  {brokerPreset === 'Other' && (
                    <label className="block text-xs sm:col-span-2">
                      <span className="text-slate-300">Custom Broker Name *</span>
                      <input
                        type="text"
                        required
                        placeholder="e.g. HFM, IC Markets, Deriv, FBS"
                        value={customBrokerName}
                        onChange={(e) => setCustomBrokerName(e.target.value)}
                        className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 text-xs focus:outline-none focus:border-[#D4A853]"
                      />
                    </label>
                  )}
                  <label className="block text-xs">
                    <span className="text-slate-300">MT5 Login *</span>
                    <input
                      type="text"
                      required
                      placeholder="e.g. 50234811"
                      value={mt5Login}
                      onChange={(e) => setMt5Login(e.target.value)}
                      className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 text-xs font-mono focus:outline-none focus:border-[#D4A853]"
                    />
                  </label>
                  <label className="block text-xs">
                    <span className="text-slate-300">Broker Server (Optional)</span>
                    <input
                      type="text"
                      placeholder="e.g. XMGlobal-MT5 / Exness-MT5Real / Weltrade-Real"
                      value={brokerServer}
                      onChange={(e) => setBrokerServer(e.target.value)}
                      className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 text-xs font-mono focus:outline-none focus:border-[#D4A853]"
                    />
                  </label>
                  <label className="block text-xs">
                    <span className="text-slate-300">
                      Broker API Key / Investor Password (Optional)
                    </span>
                    <input
                      type="password"
                      placeholder="Investor / Read-Only Password ONLY"
                      value={brokerApiKey}
                      onChange={(e) => setBrokerApiKey(e.target.value)}
                      className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 text-xs font-mono focus:outline-none focus:border-[#D4A853]"
                    />
                    <span className="mt-1 block text-[10px] text-red-400 font-medium">
                      Use Investor / Read-Only Password ONLY. Never send Main Password.
                    </span>
                  </label>
                  <div className="grid grid-cols-2 gap-2">
                    <label className="block text-xs">
                      <span className="text-slate-300">Account Type</span>
                      <select
                        value={accountType}
                        onChange={(e) => setAccountType(e.target.value as 'Demo' | 'Live')}
                        className="mt-1 w-full px-2.5 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 text-xs"
                      >
                        <option value="Demo">Demo</option>
                        <option value="Live">Live</option>
                      </select>
                    </label>
                    <label className="block text-xs">
                      <span className="text-slate-300">
                        Balance ({brokerSetup.accountVariant === 'CENT_USC' ? 'USC' : '$'})
                      </span>
                      <input
                        type="number"
                        step="0.01"
                        min="1"
                        value={startingBalance}
                        onChange={(e) => setStartingBalance(e.target.value)}
                        className="mt-1 w-full px-2.5 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 text-xs font-mono"
                      />
                    </label>
                  </div>
                </div>

                {/* Mandatory Broker Account Setup Step */}
                <BrokerAccountSetupChecklist
                  setup={brokerSetup}
                  onChange={setBrokerSetup}
                />

                {/* Subscription Plan Selection */}
                <div className="space-y-2 border-t border-white/8 pt-4">
                  <div className="text-xs font-semibold text-slate-200">
                    Select Subscription Plan
                  </div>
                  <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5">
                    {(['weekly', 'monthly', 'quarterly'] as SubscriptionPlan[]).map((pKey) => {
                      const spec = plans[pKey];
                      const active = plan === pKey;
                      return (
                        <button
                          key={pKey}
                          type="button"
                          onClick={() => setPlan(pKey)}
                          className={`p-3 rounded-md border text-left transition-colors ${
                            active
                              ? 'border-[#D4A853] bg-[#D4A853]/12'
                              : 'border-white/10 bg-[#0B0F17] hover:border-white/25'
                          }`}
                        >
                          <div className="flex items-center justify-between">
                            <span className="text-xs font-bold text-slate-100">{spec.label}</span>
                            {active && <CheckCircle2 className="w-3.5 h-3.5 text-[#E5B85C]" />}
                          </div>
                          <div className="mt-1 font-mono text-sm font-bold text-[#E5B85C]">
                            K{spec.kwacha} / ${spec.usd}
                          </div>
                          <div className="text-[11px] text-slate-400">{spec.days} days access</div>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Manual MoMo Payment Instructions */}
                <div className="p-4 rounded-md border border-[#D4A853]/30 bg-[#0B0F17] space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs font-semibold text-[#E5B85C]">
                      Manual Mobile Money (MoMo) Payment
                    </span>
                    <span className="text-xs font-mono font-bold text-slate-100">
                      Amount Due: K{selectedPlanSpec.kwacha} / ${selectedPlanSpec.usd}
                    </span>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-xs font-mono bg-[#111722] p-3 rounded border border-white/8">
                    <div>
                      <span className="text-slate-400 font-sans">Airtel MoMo: </span>
                      <span className="text-slate-100 font-semibold">{momo.airtelNumber}</span>
                    </div>
                    <div>
                      <span className="text-slate-400 font-sans">MTN MoMo: </span>
                      <span className="text-slate-100 font-semibold">{momo.mtnNumber}</span>
                    </div>
                    <div className="sm:col-span-2 text-slate-400 font-sans">
                      Recipient: <span className="text-slate-200">{momo.recipientName}</span>
                    </div>
                  </div>

                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                    <label className="block text-xs">
                      <span className="text-slate-400">Payment Method</span>
                      <select
                        value={paymentMethod}
                        onChange={(e) =>
                          setPaymentMethod(e.target.value as 'Airtel MoMo' | 'MTN MoMo')
                        }
                        className="mt-1 w-full px-3 py-2 rounded bg-[#111722] border border-white/12 text-slate-100 text-xs"
                      >
                        <option value="Airtel MoMo">Airtel MoMo</option>
                        <option value="MTN MoMo">MTN MoMo</option>
                      </select>
                    </label>
                    <label className="block text-xs">
                      <span className="text-slate-400">MoMo Transaction ID *</span>
                      <input
                        type="text"
                        placeholder="e.g. MP260418.9981"
                        value={transactionId}
                        onChange={(e) => setTransactionId(e.target.value)}
                        className="mt-1 w-full px-3 py-2 rounded bg-[#111722] border border-white/12 text-slate-100 text-xs font-mono"
                      />
                    </label>
                  </div>

                  <div className="flex flex-wrap items-center justify-between gap-3">
                    <label className="inline-flex items-center gap-2 px-3 py-2 rounded border border-white/12 bg-[#111722] text-xs text-slate-200 cursor-pointer hover:border-[#D4A853]/50">
                      <Upload className="w-3.5 h-3.5 text-[#E5B85C]" />
                      <span>{screenshotName ? `Uploaded: ${screenshotName}` : 'Upload Payment Screenshot'}</span>
                      <input
                        type="file"
                        accept="image/*"
                        onChange={(e) =>
                          handleFileRead(
                            e.target.files?.[0],
                            setScreenshotDataUrl,
                            setScreenshotName
                          )
                        }
                        className="hidden"
                      />
                    </label>
                    {screenshotDataUrl && (
                      <span className="text-[11px] text-emerald-400 font-mono">
                        Screenshot attached
                      </span>
                    )}
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={isSubmitting}
                  className="w-full py-2.5 rounded-md bg-[#D4A853] text-[#0B0F17] text-xs font-bold hover:bg-[#E0B866] disabled:opacity-50 transition-colors"
                >
                  {isSubmitting
                    ? 'Creating Account...'
                    : 'Submit Signup & MoMo Proof (Pending Approval)'}
                </button>
              </form>
            )}
          </div>
        </div>

        <div className="text-center">
          <a
            href="/admin"
            onClick={(e) => {
              e.preventDefault();
              onNavigateAdmin();
            }}
            className="text-xs text-slate-500 hover:text-[#E5B85C] transition-colors"
          >
            Admin Dashboard (/admin)
          </a>
        </div>
      </div>
    </div>
  );
}
