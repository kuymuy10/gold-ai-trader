import { useEffect, useState } from 'react';
import { Lock, CheckCircle2, Radio, Unplug, Save, AlertTriangle, RefreshCw, ShieldCheck } from 'lucide-react';
import type {
  BrokerAccountSetup,
  BrokerPreset,
  ConnectionSnapshot,
  UserPublicProfile,
} from '../types/connectivity';
import {
  BrokerAccountSetupChecklist,
  isSetupValidClient,
} from './BrokerAccountSetupChecklist';

interface BrokerConnectionViewProps {
  user: UserPublicProfile;
  snapshot: ConnectionSnapshot;
  onUserUpdated: (user: UserPublicProfile, snapshot: ConnectionSnapshot) => void;
}

function resolveBrokerPreset(name: string, saved?: BrokerPreset): BrokerPreset {
  if (saved === 'XM' || saved === 'Exness' || saved === 'Weltrade' || saved === 'Other') {
    return saved;
  }
  const lower = (name || '').toLowerCase();
  if (lower.includes('weltrade')) return 'Weltrade';
  if (lower.includes('exness')) return 'Exness';
  if (lower.includes('xm')) return 'XM';
  return 'Other';
}

export function BrokerConnectionView({
  user,
  snapshot,
  onUserUpdated,
}: BrokerConnectionViewProps) {
  const initialPreset = resolveBrokerPreset(
    user.brokerName,
    user.brokerSetup?.selectedBrokerPreset
  );
  const [brokerPreset, setBrokerPreset] = useState<BrokerPreset>(initialPreset);
  const [customBrokerName, setCustomBrokerName] = useState(
    initialPreset === 'Other' ? user.brokerName : ''
  );
  const [brokerServer, setBrokerServer] = useState(user.brokerServer);
  const [mt5Login, setMt5Login] = useState(user.mt5Login);
  const [accountType, setAccountType] = useState<'Demo' | 'Live'>(user.accountType);
  const [brokerApiKey, setBrokerApiKey] = useState('');
  const [brokerBridgeUrl, setBrokerBridgeUrl] = useState(user.brokerBridgeUrl);
  const [balance, setBalance] = useState(user.balance.toFixed(2));
  const [brokerSetup, setBrokerSetup] = useState<BrokerAccountSetup>(
    user.brokerSetup ?? {
      platformMt5: false,
      accountStandard: false,
      currencyUsd: false,
      leverageValid: false,
      hasWrongMt4OrCtrader: false,
      hasWrongCentOrEcn: false,
      hasWrongZmwOrEur: false,
      selectedBrokerPreset: initialPreset,
      accountVariant: 'STANDARD',
      confirmedAt: null,
    }
  );
  const [saving, setSaving] = useState(false);
  const [syncingBalance, setSyncingBalance] = useState(false);
  const [formDirty, setFormDirty] = useState(false);
  const [notice, setNotice] = useState<{ text: string; isError?: boolean } | null>(null);

  useEffect(() => {
    setBalance(user.balance.toFixed(2));
  }, [user.balance]);

  useEffect(() => {
    setFormDirty(false);
  }, [user.id]);

  useEffect(() => {
    if (formDirty) return;
    const nextPreset = resolveBrokerPreset(
      user.brokerName,
      user.brokerSetup?.selectedBrokerPreset
    );
    setBrokerPreset(nextPreset);
    setCustomBrokerName(nextPreset === 'Other' ? user.brokerName : '');
    setBrokerServer(user.brokerServer);
    setMt5Login(user.mt5Login);
    setAccountType(user.accountType);
    setBrokerBridgeUrl(user.brokerBridgeUrl);
    if (user.brokerSetup) {
      setBrokerSetup(user.brokerSetup);
    }
  }, [
    formDirty,
    user.id,
    user.brokerName,
    user.brokerServer,
    user.mt5Login,
    user.accountType,
    user.brokerBridgeUrl,
    user.brokerSetup,
  ]);

  const feedInfo = snapshot.bot?.feedInfo;
  const autoLot = snapshot.bot?.autoLotInfo;
  const symbolSpec = snapshot.bot?.symbolSpec;
  const isUscUnit =
    symbolSpec?.currency === 'USC' || brokerSetup.accountVariant === 'CENT_USC';
  const formatBalanceVal = (val: number) =>
    isUscUnit ? `${val.toFixed(2)} USC` : `$${val.toFixed(2)}`;
  const setupValid = isSetupValidClient(brokerSetup);
  const hasWrongAccount = Boolean(
    brokerSetup.hasWrongMt4OrCtrader || brokerSetup.hasWrongZmwOrEur
  );

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    setSaving(true);
    setNotice(null);

    const effectiveBrokerName =
      brokerPreset === 'Other'
        ? customBrokerName.trim() || 'Other'
        : brokerPreset;

    const trimmedBalance = balance.trim();
    const parsedBalance = trimmedBalance !== '' ? Number(trimmedBalance) : null;
    if (
      parsedBalance !== null &&
      (!Number.isFinite(parsedBalance) || parsedBalance < 0)
    ) {
      setNotice({
        text: 'Account balance must be a valid non-negative number.',
        isError: true,
      });
      setSaving(false);
      return;
    }

    try {
      const res = await fetch('/api/user/broker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          brokerName: effectiveBrokerName,
          brokerServer,
          mt5Login,
          accountType,
          brokerBridgeUrl,
          brokerSetup: { ...brokerSetup, selectedBrokerPreset: brokerPreset },
          ...(parsedBalance !== null ? { balance: parsedBalance } : {}),
          ...(brokerApiKey.trim() ? { brokerApiKey: brokerApiKey.trim() } : {}),
        }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        user?: UserPublicProfile;
        snapshot?: ConnectionSnapshot;
      };
      if (res.ok && json.ok && json.user && json.snapshot) {
        setFormDirty(false);
        setBrokerApiKey('');
        if (json.user.brokerSetupWrongAccount) {
          setNotice({
            text: 'Unsupported Platform or Currency — Select MT5 (Standard, Cent/Micro, or ECN/Raw) in USD or USC Cents.',
            isError: true,
          });
        } else if (!json.user.brokerSetupComplete) {
          setNotice({
            text: 'Saved. Complete Broker Setup First (MT5 + Account Type + USD/USC + Leverage) to unlock AUTO TRADE.',
            isError: true,
          });
        } else if (json.user.accountType === 'Live' && !brokerBridgeUrl.trim()) {
          setNotice({
            text: `Live ${json.user.brokerName} account verified & authorized. Add your Broker Bridge Webhook URL above to dispatch live automatic MT5 orders.`,
          });
        } else {
          setNotice({
            text: `Broker connection (${json.user.brokerName} · ${json.user.accountType}) verified. AUTO TRADE is unlocked.`,
          });
        }
        onUserUpdated(json.user, json.snapshot);
      } else {
        setNotice({
          text: json.error || `Failed to update broker (HTTP ${res.status})`,
          isError: true,
        });
      }
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Network error updating broker connection',
        isError: true,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleDisconnectBroker = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const res = await fetch('/api/user/broker', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ disconnect: true }),
      });
      const json = (await res.json().catch(() => ({}))) as {
        ok?: boolean;
        error?: string;
        user?: UserPublicProfile;
        snapshot?: ConnectionSnapshot;
      };
      if (res.ok && json.ok && json.user && json.snapshot) {
        setFormDirty(false);
        setNotice({ text: 'Broker disconnected. Auto Trade has been locked OFF.' });
        onUserUpdated(json.user, json.snapshot);
      } else {
        setNotice({
          text: json.error || `Failed to disconnect broker (HTTP ${res.status})`,
          isError: true,
        });
      }
    } catch (err) {
      setNotice({
        text: err instanceof Error ? err.message : 'Network error disconnecting broker',
        isError: true,
      });
    } finally {
      setSaving(false);
    }
  };

  const handleSyncBrokerBalance = async () => {
    setSyncingBalance(true);
    setNotice(null);
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
      if (json.user && json.snapshot) {
        setBalance(json.user.balance.toFixed(2));
        onUserUpdated(json.user, json.snapshot);
      }
      if (json.ok) {
        setNotice({
          text:
            json.message ||
            `Broker balance synced: ${formatBalanceVal(json.user?.balance ?? user.balance)}`,
        });
      } else {
        setNotice({
          text: json.error || json.message || 'Unable to sync broker balance',
          isError: true,
        });
      }
    } catch {
      setNotice({ text: 'Network error syncing broker balance', isError: true });
    } finally {
      setSyncingBalance(false);
    }
  };

  return (
    <div className="space-y-6">
      {/* Proxy Feed + Live Broker Balance Readout */}
      <div className="border border-white/8 bg-[#111722] rounded-lg p-5 flex flex-wrap items-center justify-between gap-4">
        <div className="space-y-1">
          <div className="flex items-center gap-2 text-sm font-semibold text-slate-100">
            <Radio
              className={`w-4 h-4 ${
                feedInfo?.isLive ? 'text-emerald-400' : 'text-red-400'
              }`}
            />
            Shared Proxy GOLD Feed:{' '}
            <span className={feedInfo?.isLive ? 'text-emerald-300' : 'text-red-300'}>
              {feedInfo?.label ?? 'Feed Offline ●'}
            </span>
          </div>
          <p className="text-xs text-slate-400">
            {feedInfo?.isLive
              ? 'Managed GOLD master stream is live. Supports XM, Exness, Weltrade Cent, and any MT5 broker.'
              : 'Feed Offline - Contact Admin. Proxy stream is controlled centrally by Admin.'}
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-4">
          <div className="text-right font-mono text-xs tabular-nums">
            <div className="text-slate-400">
              Account Balance:{' '}
              <span className="text-emerald-300 font-bold">{formatBalanceVal(user.balance)}</span> · Equity:{' '}
              <span className="text-slate-100 font-semibold">{formatBalanceVal(user.equity)}</span>
            </div>
            <div className="text-[11px] text-slate-400 mt-0.5">
              {user.balanceSyncSource
                ? `Auto-Sync: ${user.balanceSyncSource}`
                : 'Auto-updates on TP1 / Close / Bridge'}
              {autoLot ? ` · Lot ${autoLot.effectiveLot.toFixed(2)}` : ''}
              {symbolSpec ? ` · ${symbolSpec.contractSize} ${isUscUnit ? 'cent-oz' : 'oz'}/lot` : ''}
            </div>
          </div>

          <button
            type="button"
            disabled={syncingBalance || saving}
            onClick={() => void handleSyncBrokerBalance()}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded border border-[#D4A853]/40 bg-[#D4A853]/12 text-[#E5B85C] text-xs font-semibold hover:bg-[#D4A853]/20 disabled:opacity-50"
          >
            <RefreshCw className={`w-3.5 h-3.5 ${syncingBalance ? 'animate-spin' : ''}`} />
            {syncingBalance ? 'Syncing...' : 'Sync Broker Balance'}
          </button>
        </div>
      </div>

      {/* User's Own Broker Form + Mandatory Broker Account Setup */}
      <form onSubmit={handleSave} className="border border-white/8 bg-[#111722] rounded-lg p-5 space-y-5">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/8 pb-4">
          <div>
            <h2 className="text-base font-display font-bold text-slate-50">
              MT5 Broker Connection &amp; Account Setup (Isolated Per User)
            </h2>
            <p className="text-xs text-slate-400 mt-0.5">
              Works on Demo &amp; Live MT5 accounts across XM, Exness, Weltrade (including Cent/Micro), and any MT5 broker.
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs font-medium ${
                hasWrongAccount
                  ? 'border-red-500/45 bg-red-950/30 text-red-300'
                  : setupValid
                    ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                    : 'border-amber-500/35 bg-amber-500/10 text-amber-300'
              }`}
            >
              {setupValid ? <CheckCircle2 className="w-3.5 h-3.5" /> : <AlertTriangle className="w-3.5 h-3.5" />}
              Broker Setup: {hasWrongAccount ? 'Unsupported' : setupValid ? 'Complete' : 'Incomplete'}
            </span>
            <span
              className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-xs font-medium ${
                user.brokerConnected
                  ? accountType === 'Live'
                    ? 'border-[#D4A853]/50 bg-[#D4A853]/15 text-[#E5B85C]'
                    : 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                  : 'border-amber-500/35 bg-amber-500/10 text-amber-300'
              }`}
            >
              <CheckCircle2 className="w-3.5 h-3.5" />
              {user.brokerConnected ? `Broker Connected (${user.accountType})` : 'Broker Disconnected'}
            </span>
          </div>
        </div>

        {/* Red Warning: Never Ask for Main Password */}
        <div className="p-3 rounded-md border border-red-500/45 bg-red-950/30 flex items-start gap-2.5 text-xs text-red-200">
          <Lock className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>
            <strong>Use Investor / Read-Only Password ONLY. Never send Main Password.</strong> We never ask for your MT5 Main Password or withdraw your money.
          </span>
        </div>

        {accountType === 'Live' && (
          <div className="p-3 rounded-md border border-[#D4A853]/40 bg-[#D4A853]/10 flex items-start gap-2.5 text-xs text-[#E5B85C]">
            <ShieldCheck className="w-4 h-4 shrink-0 mt-0.5" />
            <span>
              <strong>Live Account Execution Mode:</strong> Saving a Live MT5 account automatically authorizes Live execution rules. Enter your <strong>Broker Bridge Webhook URL</strong> below so automatic signals dispatch directly to your live {brokerPreset === 'Other' ? customBrokerName || 'MT5' : brokerPreset} MT5 EA/bridge.
            </span>
          </div>
        )}

        {notice && (
          <div
            className={`p-3 rounded border text-xs ${
              notice.isError
                ? 'border-red-500/45 bg-red-950/35 text-red-200 font-semibold'
                : 'border-[#D4A853]/35 bg-[#D4A853]/10 text-[#E5B85C]'
            }`}
          >
            {notice.text}
          </div>
        )}

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4 text-xs">
          <label className="block">
            <span className="text-slate-400">Broker Name *</span>
            <select
              value={brokerPreset}
              onChange={(e) => {
                const val = e.target.value as BrokerPreset;
                setFormDirty(true);
                setBrokerPreset(val);
                setBrokerSetup((prev) => ({
                  ...prev,
                  selectedBrokerPreset: val,
                  ...(val === 'Weltrade' && !prev.accountVariant
                    ? { accountVariant: 'CENT_USC' }
                    : {}),
                }));
              }}
              className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100"
            >
              <option value="XM">XM</option>
              <option value="Exness">Exness</option>
              <option value="Weltrade">Weltrade (Standard / Cent)</option>
              <option value="Other">Other MT5 Broker</option>
            </select>
          </label>
          {brokerPreset === 'Other' && (
            <label className="block">
              <span className="text-slate-400">Custom Broker Name *</span>
              <input
                type="text"
                required
                placeholder="e.g. HFM, IC Markets, Deriv, FBS"
                value={customBrokerName}
                onChange={(e) => {
                  setFormDirty(true);
                  setCustomBrokerName(e.target.value);
                }}
                className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100"
              />
            </label>
          )}
          <label className="block">
            <span className="text-slate-400">Broker Server</span>
            <input
              type="text"
              placeholder={
                brokerPreset === 'Weltrade'
                  ? 'Weltrade-Real / Weltrade-Demo'
                  : brokerPreset === 'Exness'
                    ? 'Exness-MT5Real / Exness-MT5Trial'
                    : brokerPreset === 'XM'
                      ? 'XMGlobal-MT5 / XMGlobal-MT5 9'
                      : 'Your MT5 Server Name'
              }
              value={brokerServer}
              onChange={(e) => {
                setFormDirty(true);
                setBrokerServer(e.target.value);
              }}
              className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
            />
          </label>
          <label className="block">
            <span className="text-slate-400">MT5 Login *</span>
            <input
              type="text"
              required
              value={mt5Login}
              onChange={(e) => {
                setFormDirty(true);
                setMt5Login(e.target.value);
              }}
              className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
            />
          </label>
          <label className="block">
            <span className="text-slate-400">Account Environment</span>
            <select
              value={accountType}
              onChange={(e) => {
                setFormDirty(true);
                setAccountType(e.target.value as 'Demo' | 'Live');
              }}
              className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100"
            >
              <option value="Demo">Demo</option>
              <option value="Live">Live (Real Account)</option>
            </select>
          </label>
          <label className="block">
            <span className="text-slate-400">
              Account Balance ({isUscUnit ? 'USC Cents' : '$ USD'})
            </span>
            <input
              type="number"
              step="0.01"
              min="0"
              value={balance}
              onChange={(e) => setBalance(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
            />
          </label>
          <label className="block">
            <span className="text-slate-400">
              Broker API Key / Investor Password ({user.hasBrokerApiKey ? `Saved: ••••${user.brokerApiKeyLast4}` : 'Optional'})
            </span>
            <input
              type="password"
              placeholder={user.hasBrokerApiKey ? `••••${user.brokerApiKeyLast4} (leave blank to keep)` : 'Investor / Read-Only Password ONLY'}
              value={brokerApiKey}
              onChange={(e) => setBrokerApiKey(e.target.value)}
              className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
            />
          </label>
          <label className="block sm:col-span-2 lg:col-span-3">
            <span className="text-slate-400">
              Broker Bridge Webhook URL ({accountType === 'Live' ? 'Required for Live MT5 Auto-Orders' : 'Optional — routes orders to your MT5 EA/bridge'})
            </span>
            <input
              type="url"
              placeholder="https://your-mt5-bridge.example.com/orders"
              value={brokerBridgeUrl}
              onChange={(e) => {
                setFormDirty(true);
                setBrokerBridgeUrl(e.target.value);
              }}
              className="mt-1 w-full px-3 py-2 rounded bg-[#0B0F17] border border-white/12 text-slate-100 font-mono"
            />
          </label>
        </div>

        {/* Broker Account Setup Check */}
        <BrokerAccountSetupChecklist
          setup={brokerSetup}
          onChange={(next) => {
            setFormDirty(true);
            setBrokerSetup(next);
          }}
        />

        <div className="flex flex-wrap items-center justify-end gap-3 pt-3 border-t border-white/8">
          {user.brokerConnected && (
            <button
              type="button"
              disabled={saving}
              onClick={handleDisconnectBroker}
              className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded border border-red-500/30 bg-red-950/20 text-red-300 text-xs"
            >
              <Unplug className="w-3.5 h-3.5" />
              Disconnect Broker
            </button>
          )}
          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-1.5 px-4 py-2 rounded bg-[#D4A853] text-[#0B0F17] text-xs font-semibold hover:bg-[#E0B866]"
          >
            <Save className="w-3.5 h-3.5" />
            {saving ? 'Saving...' : 'Save Broker & Setup'}
          </button>
        </div>
      </form>
    </div>
  );
}
