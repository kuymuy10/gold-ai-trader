import { useEffect, useState } from 'react';
import {
  ArrowLeft,
  CheckCircle2,
  KeyRound,
  MessageSquareText,
  Play,
  Plug,
  PlugZap,
  Radio,
  RefreshCw,
  Save,
  ShieldAlert,
  Square,
  TrendingDown,
  TrendingUp,
  WifiOff,
} from 'lucide-react';
import type {
  ConnectionSnapshot,
  SignalSourceMode,
  TelegramChannelMessage,
  TelegramConnectionStatus,
  TelegramListenerPublicState,
} from '../types/connectivity';

interface TelegramListenerViewProps {
  snapshot: ConnectionSnapshot;
  onSnapshotUpdated: (next: ConnectionSnapshot) => void;
  onSwitchSignalSource?: (
    source: SignalSourceMode
  ) => Promise<{ ok: boolean; error?: string }>;
  onNavigateBot?: () => void;
}

function getDisplayStatus(status: TelegramConnectionStatus): {
  label: string;
  subLabel: string | null;
  toneClass: string;
  dotClass: string;
} {
  if (status === 'LISTENING') {
    return {
      label: 'Listening',
      subLabel: 'Live channel stream active',
      toneClass: 'border-emerald-500/40 bg-emerald-500/12 text-emerald-300',
      dotClass: 'bg-emerald-400 animate-pulse',
    };
  }
  if (status === 'CONNECTED') {
    return {
      label: 'Connected',
      subLabel: 'User session authorized · Ready to listen',
      toneClass: 'border-sky-500/40 bg-sky-500/12 text-sky-200',
      dotClass: 'bg-sky-400',
    };
  }
  if (status === 'AWAITING_CODE') {
    return {
      label: 'Disconnected',
      subLabel: 'Awaiting Telegram OTP verification code',
      toneClass: 'border-amber-500/40 bg-amber-500/12 text-amber-200',
      dotClass: 'bg-amber-400 animate-pulse',
    };
  }
  if (status === 'AWAITING_2FA') {
    return {
      label: 'Disconnected',
      subLabel: 'Awaiting Telegram 2FA cloud password',
      toneClass: 'border-amber-500/40 bg-amber-500/12 text-amber-200',
      dotClass: 'bg-amber-400 animate-pulse',
    };
  }
  if (status === 'CONNECTING') {
    return {
      label: 'Disconnected',
      subLabel: 'Connecting to Telegram MTProto...',
      toneClass: 'border-amber-500/40 bg-amber-500/12 text-amber-200',
      dotClass: 'bg-amber-400 animate-pulse',
    };
  }
  return {
    label: 'Disconnected',
    subLabel: null,
    toneClass: 'border-red-500/35 bg-red-950/30 text-red-300',
    dotClass: 'bg-red-400',
  };
}

function formatPriceValue(val: number | null | undefined): string {
  if (val === null || val === undefined || !Number.isFinite(val)) return '—';
  return String(val);
}

export function TelegramListenerView({
  snapshot,
  onSnapshotUpdated,
  onSwitchSignalSource,
  onNavigateBot,
}: TelegramListenerViewProps) {
  const tg: TelegramListenerPublicState | undefined = snapshot.bot?.telegram;
  const serverStatus: TelegramConnectionStatus = tg?.status ?? 'DISCONNECTED';
  const activeSignalSource: SignalSourceMode = tg?.signalSource ?? 'BOTH';

  const [apiId, setApiId] = useState(tg?.apiId ?? '');
  const [apiHash, setApiHash] = useState('');
  const [phoneNumber, setPhoneNumber] = useState(tg?.phoneNumber ?? '');
  const [channelTarget, setChannelTarget] = useState(tg?.channelTarget ?? '');
  const [autoExecuteSignals, setAutoExecuteSignals] = useState(
    tg?.autoExecuteSignals ?? true
  );
  const [formDirty, setFormDirty] = useState(false);

  const [verificationCode, setVerificationCode] = useState('');
  const [twoFaPassword, setTwoFaPassword] = useState('');

  const [busyAction, setBusyAction] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<{
    type: 'success' | 'error';
    text: string;
  } | null>(null);

  useEffect(() => {
    if (!tg || formDirty) return;
    setApiId(tg.apiId || '');
    setPhoneNumber(tg.phoneNumber || '');
    setChannelTarget(tg.channelTarget || '');
    setAutoExecuteSignals(Boolean(tg.autoExecuteSignals));
  }, [
    tg?.apiId,
    tg?.phoneNumber,
    tg?.channelTarget,
    tg?.autoExecuteSignals,
    formDirty,
    tg,
  ]);

  const callTelegramApi = async (
    endpoint: string,
    payload?: Record<string, unknown>,
    actionName?: string
  ) => {
    setBusyAction(actionName || endpoint);
    setFeedback(null);
    try {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload || {}),
      });
      const json = (await res.json()) as {
        ok?: boolean;
        error?: string;
        needsCode?: boolean;
        needs2fa?: boolean;
        snapshot?: ConnectionSnapshot;
        state?: TelegramListenerPublicState;
      };
      if (json.snapshot) {
        onSnapshotUpdated(json.snapshot);
      }
      if (!res.ok || !json.ok) {
        setFeedback({
          type: 'error',
          text: json.error || `Telegram request failed (HTTP ${res.status})`,
        });
        return { ok: false, json };
      }
      return { ok: true, json };
    } catch (err) {
      setFeedback({
        type: 'error',
        text: err instanceof Error ? err.message : 'Network error communicating with Telegram listener',
      });
      return { ok: false, json: null };
    } finally {
      setBusyAction(null);
    }
  };

  const handleSaveConfig = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    const res = await callTelegramApi(
      '/api/telegram/config',
      {
        apiId: apiId.trim(),
        ...(apiHash.trim() ? { apiHash: apiHash.trim() } : {}),
        phoneNumber: phoneNumber.trim(),
        channelTarget: channelTarget.trim(),
        autoExecuteSignals,
      },
      'save'
    );
    if (res.ok) {
      setFormDirty(false);
      setApiHash('');
      setFeedback({
        type: 'success',
        text: 'Telegram User API credentials & channel saved securely.',
      });
    }
  };

  const handleConnect = async () => {
    const res = await callTelegramApi(
      '/api/telegram/connect',
      {
        apiId: apiId.trim(),
        ...(apiHash.trim() ? { apiHash: apiHash.trim() } : {}),
        phoneNumber: phoneNumber.trim(),
        channelTarget: channelTarget.trim(),
        autoExecuteSignals,
      },
      'connect'
    );
    if (res.ok) {
      setFormDirty(false);
      setApiHash('');
      if (res.json?.needsCode) {
        setFeedback({
          type: 'success',
          text: res.json.state?.isCodeViaApp
            ? 'Verification code sent to your Telegram app. Enter the code below.'
            : 'Verification code sent via SMS. Enter the code below.',
        });
      } else {
        setFeedback({
          type: 'success',
          text: 'Telegram User API connected and authorized.',
        });
      }
    }
  };

  const handleVerify = async (e: React.FormEvent) => {
    e.preventDefault();
    const res = await callTelegramApi(
      '/api/telegram/verify',
      {
        code: verificationCode.trim(),
        password: twoFaPassword.trim(),
      },
      'verify'
    );
    if (res.ok) {
      if (res.json?.needs2fa) {
        setFeedback({
          type: 'success',
          text: 'Code accepted. Enter your Telegram 2FA cloud password to complete login.',
        });
      } else {
        setVerificationCode('');
        setTwoFaPassword('');
        setFeedback({
          type: 'success',
          text: 'Telegram User API verified and connected! Click Start Listening to stream signals.',
        });
      }
    }
  };

  const handleStartListening = async () => {
    const res = await callTelegramApi(
      '/api/telegram/start',
      {
        channelTarget: channelTarget.trim(),
        autoExecuteSignals,
      },
      'start'
    );
    if (res.ok) {
      setFormDirty(false);
      setFeedback({
        type: 'success',
        text: `Listening live on ${res.json?.state?.resolvedChannelTitle || channelTarget.trim()}.`,
      });
    }
  };

  const handleStopListening = async () => {
    const res = await callTelegramApi('/api/telegram/stop', {}, 'stop');
    if (res.ok) {
      setFeedback({
        type: 'success',
        text: 'Stopped listening to channel messages (Telegram session stays connected).',
      });
    }
  };

  const handleDisconnect = async (clearSession = false) => {
    const res = await callTelegramApi(
      '/api/telegram/disconnect',
      { clearSession },
      'disconnect'
    );
    if (res.ok) {
      setVerificationCode('');
      setTwoFaPassword('');
      setFeedback({
        type: 'success',
        text: clearSession
          ? 'Telegram disconnected and saved session cleared.'
          : 'Telegram User API disconnected.',
      });
    }
  };

  const handleSelectSignalSource = async (nextSource: SignalSourceMode) => {
    setFeedback(null);
    setBusyAction('source');
    try {
      const res = onSwitchSignalSource
        ? await onSwitchSignalSource(nextSource)
        : await callTelegramApi('/api/telegram/config', { signalSource: nextSource }, 'source');
      if (res.ok) {
        const label =
          nextSource === 'TELEGRAM'
            ? 'Telegram Signals Only (built-in Gold EMA auto-entries paused)'
            : nextSource === 'STRATEGY'
              ? 'Built-in EMA Strategy Only (Telegram messages logged without auto-trading)'
              : 'Both Built-in EMA Strategy + Telegram Signals';
        setFeedback({ type: 'success', text: `Switched signal source to ${label}.` });
      } else if ('error' in res && res.error) {
        setFeedback({ type: 'error', text: res.error });
      }
    } finally {
      setBusyAction(null);
    }
  };

  const statusMeta = getDisplayStatus(serverStatus);
  const messages: TelegramChannelMessage[] = tg?.messages ?? [];
  const signalCount = messages.filter((m) => m.parsed.isSignal).length;
  const executedCount = messages.filter(
    (m) => m.parsed.executionStatus === 'EXECUTED'
  ).length;
  const activeBanner =
    feedback ?? (tg?.lastError ? { type: 'error' as const, text: tg.lastError } : null);

  return (
    <div className="space-y-5 overflow-x-hidden">
      {/* Header Status Banner */}
      <section className="rounded-xl border border-white/10 bg-[#111722] p-4 sm:p-5">
        <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between">
          <div className="space-y-1 min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Radio className="w-4 h-4 text-[#E5B85C] shrink-0" />
              <h1 className="font-display text-base sm:text-lg font-bold text-slate-100">
                Telegram User API Signal Listener
              </h1>
              <span
                className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md border text-xs font-mono font-semibold ${statusMeta.toneClass}`}
              >
                <span className={`w-2 h-2 rounded-full ${statusMeta.dotClass}`} />
                {statusMeta.label}
              </span>
            </div>
            <p className="text-xs text-slate-400">
              Reads live messages from any Telegram channel or group your personal user account belongs to (no Bot admin access required) and routes valid setups to your Auto-Trading module.
            </p>
            {statusMeta.subLabel && (
              <p className="text-[11px] font-mono text-slate-300">
                {statusMeta.subLabel}
                {tg?.resolvedChannelTitle ? ` · Channel: ${tg.resolvedChannelTitle}` : ''}
              </p>
            )}
          </div>

          <div className="grid grid-cols-3 gap-2 sm:flex sm:items-center sm:gap-3 text-center sm:text-left shrink-0">
            <div className="px-3 py-2 rounded-lg border border-white/8 bg-[#0B0F17]">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">
                Messages
              </div>
              <div className="text-sm font-mono font-bold text-slate-100">
                {messages.length}
              </div>
            </div>
            <div className="px-3 py-2 rounded-lg border border-white/8 bg-[#0B0F17]">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">
                Signals
              </div>
              <div className="text-sm font-mono font-bold text-[#E5B85C]">
                {signalCount}
              </div>
            </div>
            <div className="px-3 py-2 rounded-lg border border-white/8 bg-[#0B0F17]">
              <div className="text-[10px] uppercase tracking-wider text-slate-400">
                Traded
              </div>
              <div className="text-sm font-mono font-bold text-emerald-300">
                {executedCount}
              </div>
            </div>
          </div>
        </div>

        {/* Primary Action Buttons (Touch-friendly on mobile) */}
        <div className="mt-4 pt-4 border-t border-white/8 grid grid-cols-1 sm:grid-cols-2 lg:flex lg:flex-wrap gap-2.5">
          <button
            type="button"
            disabled={busyAction !== null}
            onClick={() => void handleConnect()}
            className="min-h-[42px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-[#D4A853] text-[#0B0F17] text-xs font-bold hover:bg-[#E0B866] disabled:opacity-50 transition-colors"
          >
            {busyAction === 'connect' ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <PlugZap className="w-4 h-4" />
            )}
            Connect Telegram
          </button>

          <button
            type="button"
            disabled={busyAction !== null || serverStatus === 'LISTENING'}
            onClick={() => void handleStartListening()}
            className="min-h-[42px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-emerald-500/20 border border-emerald-500/45 text-emerald-200 text-xs font-bold hover:bg-emerald-500/30 disabled:opacity-45 transition-colors"
          >
            {busyAction === 'start' ? (
              <RefreshCw className="w-4 h-4 animate-spin" />
            ) : (
              <Play className="w-4 h-4" />
            )}
            Start Listening
          </button>

          <button
            type="button"
            disabled={busyAction !== null || serverStatus !== 'LISTENING'}
            onClick={() => void handleStopListening()}
            className="min-h-[42px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg bg-amber-500/15 border border-amber-500/40 text-amber-200 text-xs font-bold hover:bg-amber-500/25 disabled:opacity-45 transition-colors"
          >
            <Square className="w-4 h-4" />
            Stop Listening
          </button>

          {serverStatus !== 'DISCONNECTED' && (
            <button
              type="button"
              disabled={busyAction !== null}
              onClick={() => void handleDisconnect(false)}
              className="min-h-[42px] inline-flex items-center justify-center gap-2 px-4 py-2.5 rounded-lg border border-white/15 bg-[#0B0F17] text-slate-300 text-xs font-semibold hover:text-white hover:border-white/25 disabled:opacity-45 transition-colors"
            >
              <WifiOff className="w-4 h-4" />
              Disconnect
            </button>
          )}
        </div>

        {activeBanner && (
          <div
            className={`mt-4 p-3 rounded-lg border text-xs flex items-start gap-2 ${
              activeBanner.type === 'success'
                ? 'border-emerald-500/35 bg-emerald-950/25 text-emerald-200'
                : 'border-red-500/35 bg-red-950/25 text-red-200'
            }`}
          >
            {activeBanner.type === 'success' ? (
              <CheckCircle2 className="w-4 h-4 shrink-0 mt-0.5" />
            ) : (
              <ShieldAlert className="w-4 h-4 shrink-0 mt-0.5" />
            )}
            <span className="break-words">{activeBanner.text}</span>
          </div>
        )}
      </section>

      {/* How to Switch to Telegram Signals + Active Signal Source Switcher */}
      <section className="rounded-xl border border-white/10 bg-[#111722] p-4 sm:p-5 space-y-4">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between border-b border-white/8 pb-3">
          <div>
            <h2 className="text-sm font-semibold text-slate-100">
              How to Switch to Telegram Signals
            </h2>
            <p className="text-xs text-slate-400">
              Follow these four steps to connect your Telegram account and switch auto-trading to channel signals.
            </p>
          </div>
          {onNavigateBot && (
            <button
              type="button"
              onClick={onNavigateBot}
              className="min-h-[40px] inline-flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-lg border border-white/15 bg-[#0B0F17] text-xs font-semibold text-slate-200 hover:text-white hover:border-white/25 whitespace-nowrap shrink-0"
            >
              <ArrowLeft className="w-3.5 h-3.5" />
              Back to Session Bot
            </button>
          )}
        </div>

        {/* Signal Source Switcher */}
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 py-1">
          <div className="space-y-0.5">
            <span className="text-xs font-semibold text-slate-200 block">
              Active Auto-Trade Signal Source
            </span>
            <span className="text-[11px] text-slate-400 block">
              {activeSignalSource === 'TELEGRAM'
                ? 'Only parsed Telegram channel signals trigger auto-trades (built-in EMA auto-entries paused).'
                : activeSignalSource === 'STRATEGY'
                  ? 'Only the built-in EMA STOCHASTIC PRO strategy triggers auto-trades (Telegram messages are saved only).'
                  : 'Both Telegram channel signals and the built-in EMA STOCHASTIC PRO strategy can auto-trade.'}
            </span>
          </div>

          <div className="grid grid-cols-3 sm:inline-flex items-center gap-1.5 p-1 rounded-lg border border-white/10 bg-[#0B0F17] shrink-0">
            {(
              [
                { id: 'TELEGRAM', label: 'Telegram Only' },
                { id: 'BOTH', label: 'Both' },
                { id: 'STRATEGY', label: 'Built-in EMA' },
              ] as Array<{ id: SignalSourceMode; label: string }>
            ).map((opt) => {
              const active = activeSignalSource === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => void handleSelectSignalSource(opt.id)}
                  className={`min-h-[38px] px-3 py-1.5 rounded-md text-xs font-semibold whitespace-nowrap shrink-0 transition-colors disabled:opacity-50 ${
                    active
                      ? 'bg-[#D4A853] text-[#0B0F17]'
                      : 'text-slate-300 hover:text-white'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* 4-Step Guide */}
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 pt-1">
          <div className="rounded-lg border border-white/8 bg-[#0B0F17] p-3.5 space-y-1.5">
            <div className="text-xs font-mono font-semibold text-[#E5B85C] tabular-nums">
              01. Create API Keys
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Open <span className="font-mono text-slate-100">my.telegram.org</span>, sign in with your Telegram phone number, open <strong className="text-slate-100">API development tools</strong>, and copy your <span className="font-mono text-slate-100">API_ID</span> and <span className="font-mono text-slate-100">API_HASH</span>.
            </p>
          </div>

          <div className="rounded-lg border border-white/8 bg-[#0B0F17] p-3.5 space-y-1.5">
            <div className="text-xs font-mono font-semibold text-[#E5B85C] tabular-nums">
              02. Add Phone &amp; Channel
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Enter your <span className="font-mono text-slate-100">API_ID</span>, <span className="font-mono text-slate-100">API_HASH</span>, <span className="font-mono text-slate-100">PHONE NUMBER</span> (with country code), and <span className="font-mono text-slate-100">CHANNEL LINK / ID</span> (<span className="font-mono">@name</span>, invite link, or <span className="font-mono">-100...</span>), then tap <strong className="text-slate-100">Save Settings</strong>.
            </p>
          </div>

          <div className="rounded-lg border border-white/8 bg-[#0B0F17] p-3.5 space-y-1.5">
            <div className="text-xs font-mono font-semibold text-[#E5B85C] tabular-nums">
              03. Connect &amp; Listen
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Tap <strong className="text-slate-100">Connect Telegram</strong>, enter the 5-digit code from your Telegram app (and 2FA password if enabled), then tap <strong className="text-slate-100">Start Listening</strong> until status shows <strong className="text-emerald-300">Listening</strong>.
            </p>
          </div>

          <div className="rounded-lg border border-white/8 bg-[#0B0F17] p-3.5 space-y-1.5">
            <div className="text-xs font-mono font-semibold text-[#E5B85C] tabular-nums">
              04. Switch Auto-Trading
            </div>
            <p className="text-xs text-slate-300 leading-relaxed">
              Select <strong className="text-slate-100">Telegram Only</strong> (or <strong className="text-slate-100">Both</strong>) above, keep <strong className="text-slate-100">Auto-Trade Parsed Signals</strong> checked, and make sure Bot State is <strong className="text-slate-100">RUNNING</strong> with <strong className="text-slate-100">Auto-Trade ON</strong>.
            </p>
          </div>
        </div>
      </section>

      {/* Interactive OTP / 2FA Verification Box */}
      {(serverStatus === 'AWAITING_CODE' || serverStatus === 'AWAITING_2FA') && (
        <section className="rounded-xl border border-amber-500/40 bg-amber-950/20 p-4 sm:p-5 space-y-3">
          <div className="flex items-center gap-2 text-amber-200 text-sm font-semibold">
            <KeyRound className="w-4 h-4" />
            <span>
              {serverStatus === 'AWAITING_2FA'
                ? 'Enter Telegram 2FA Cloud Password'
                : 'Enter Telegram Login Verification Code'}
            </span>
          </div>
          <p className="text-xs text-slate-300">
            {serverStatus === 'AWAITING_2FA'
              ? 'Your Telegram account has Two-Step Verification enabled. Enter your 2FA password to authorize the session.'
              : 'Check your Telegram app (or SMS) for the 5-digit login code and enter it below.'}
          </p>
          <form
            onSubmit={handleVerify}
            className="grid grid-cols-1 sm:grid-cols-3 gap-3 items-end"
          >
            {serverStatus === 'AWAITING_CODE' && (
              <label className="block text-xs">
                <span className="text-slate-300">Telegram OTP Code</span>
                <input
                  type="text"
                  inputMode="numeric"
                  required
                  placeholder="12345"
                  value={verificationCode}
                  onChange={(e) => setVerificationCode(e.target.value)}
                  className="mt-1.5 w-full min-h-[42px] px-3 py-2 rounded-lg bg-[#0B0F17] border border-white/15 text-slate-100 text-sm font-mono focus:outline-none focus:border-[#D4A853]"
                />
              </label>
            )}
            <label className="block text-xs">
              <span className="text-slate-300">
                2FA Password {serverStatus === 'AWAITING_CODE' ? '(if enabled)' : '(Required)'}
              </span>
              <input
                type="password"
                required={serverStatus === 'AWAITING_2FA'}
                placeholder="Telegram 2FA password"
                value={twoFaPassword}
                onChange={(e) => setTwoFaPassword(e.target.value)}
                className="mt-1.5 w-full min-h-[42px] px-3 py-2 rounded-lg bg-[#0B0F17] border border-white/15 text-slate-100 text-sm focus:outline-none focus:border-[#D4A853]"
              />
            </label>
            <button
              type="submit"
              disabled={busyAction !== null}
              className="min-h-[42px] px-4 py-2.5 rounded-lg bg-[#D4A853] text-[#0B0F17] text-xs font-bold hover:bg-[#E0B866] disabled:opacity-50"
            >
              {busyAction === 'verify' ? 'Verifying...' : 'Submit Verification'}
            </button>
          </form>
        </section>
      )}

      {/* Main Responsive Grid: Settings (left) + Live Messages & Signals (right) */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* Settings Form */}
        <section className="lg:col-span-5 rounded-xl border border-white/10 bg-[#111722] p-4 sm:p-5 space-y-4">
          <div className="flex items-center justify-between border-b border-white/8 pb-3">
            <div className="flex items-center gap-2">
              <Plug className="w-4 h-4 text-[#E5B85C]" />
              <h2 className="text-sm font-semibold text-slate-100">
                Telegram User API Settings
              </h2>
            </div>
            {tg?.hasSession && (
              <span className="px-2 py-0.5 rounded bg-emerald-500/15 border border-emerald-500/35 text-[10px] font-mono text-emerald-300">
                Session Saved
              </span>
            )}
          </div>

          <form onSubmit={handleSaveConfig} className="space-y-3.5">
            <label className="block text-xs">
              <span className="text-slate-300 font-medium">API_ID</span>
              <input
                type="text"
                inputMode="numeric"
                placeholder="e.g. 24198765 (from my.telegram.org)"
                value={apiId}
                onChange={(e) => {
                  setApiId(e.target.value);
                  setFormDirty(true);
                }}
                className="mt-1.5 w-full min-h-[42px] px-3 py-2 rounded-lg bg-[#0B0F17] border border-white/12 text-slate-100 text-xs font-mono focus:outline-none focus:border-[#D4A853]"
              />
            </label>

            <label className="block text-xs">
              <div className="flex items-center justify-between">
                <span className="text-slate-300 font-medium">API_HASH</span>
                {tg?.hasApiHash && (
                  <span className="text-[10px] font-mono text-emerald-300">
                    Saved (••••{tg.apiHashLast4})
                  </span>
                )}
              </div>
              <input
                type="password"
                placeholder={
                  tg?.hasApiHash
                    ? 'Leave blank to keep saved API_HASH'
                    : 'Paste 32-char API_HASH from my.telegram.org'
                }
                value={apiHash}
                onChange={(e) => {
                  setApiHash(e.target.value);
                  setFormDirty(true);
                }}
                className="mt-1.5 w-full min-h-[42px] px-3 py-2 rounded-lg bg-[#0B0F17] border border-white/12 text-slate-100 text-xs font-mono focus:outline-none focus:border-[#D4A853]"
              />
            </label>

            <label className="block text-xs">
              <span className="text-slate-300 font-medium">PHONE NUMBER</span>
              <input
                type="tel"
                placeholder="e.g. +260971234567"
                value={phoneNumber}
                onChange={(e) => {
                  setPhoneNumber(e.target.value);
                  setFormDirty(true);
                }}
                className="mt-1.5 w-full min-h-[42px] px-3 py-2 rounded-lg bg-[#0B0F17] border border-white/12 text-slate-100 text-xs font-mono focus:outline-none focus:border-[#D4A853]"
              />
            </label>

            <label className="block text-xs">
              <span className="text-slate-300 font-medium">
                CHANNEL LINK / CHANNEL ID
              </span>
              <input
                type="text"
                placeholder="e.g. @ChannelName, https://t.me/..., or -1001234567890"
                value={channelTarget}
                onChange={(e) => {
                  setChannelTarget(e.target.value);
                  setFormDirty(true);
                }}
                className="mt-1.5 w-full min-h-[42px] px-3 py-2 rounded-lg bg-[#0B0F17] border border-white/12 text-slate-100 text-xs font-mono focus:outline-none focus:border-[#D4A853]"
              />
              <span className="mt-1 block text-[11px] text-slate-500">
                Your Telegram user account must already be a member of this channel.
              </span>
            </label>

            <label className="flex items-start gap-2.5 p-3 rounded-lg border border-white/8 bg-[#0B0F17] cursor-pointer">
              <input
                type="checkbox"
                checked={autoExecuteSignals}
                onChange={(e) => {
                  setAutoExecuteSignals(e.target.checked);
                  setFormDirty(true);
                }}
                className="mt-0.5 rounded border-white/25 bg-[#111722] text-[#D4A853]"
              />
              <span className="text-xs leading-relaxed text-slate-300">
                <strong className="text-slate-100 block">
                  Auto-Trade Parsed Signals
                </strong>
                Forward valid parsed setups automatically to your existing Auto-Trading module (Gemini AI, spread checks, risk guard &amp; MT5 execution). Normal chat messages are never traded.
              </span>
            </label>

            <div className="flex flex-wrap gap-2 pt-1">
              <button
                type="submit"
                disabled={busyAction !== null}
                className="flex-1 min-h-[42px] inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg border border-[#D4A853]/45 bg-[#D4A853]/15 text-[#E5B85C] text-xs font-bold hover:bg-[#D4A853]/25 disabled:opacity-50"
              >
                <Save className="w-3.5 h-3.5" />
                Save Settings
              </button>
              {tg?.hasSession && (
                <button
                  type="button"
                  disabled={busyAction !== null}
                  onClick={() => void handleDisconnect(true)}
                  className="min-h-[42px] px-3 py-2 rounded-lg border border-red-500/30 text-red-300 text-xs hover:bg-red-950/30 disabled:opacity-50"
                >
                  Reset Session
                </button>
              )}
            </div>
          </form>

          {/* Railway Deployment Env Vars Box */}
          <div className="pt-3 border-t border-white/8 space-y-2">
            <h3 className="text-xs font-semibold text-slate-200">
              Railway Environment Variables
            </h3>
            <p className="text-[11px] text-slate-400">
              Add these variables in your Railway Service &rarr; Variables tab (keep secrets server-side only):
            </p>
            <div className="rounded-lg border border-white/8 bg-[#0B0F17] p-3 font-mono text-[11px] text-slate-300 space-y-1 overflow-x-auto">
              <div><span className="text-[#E5B85C]">TELEGRAM_API_ID</span>=your_api_id</div>
              <div><span className="text-[#E5B85C]">TELEGRAM_API_HASH</span>=your_api_hash</div>
              <div><span className="text-[#E5B85C]">TELEGRAM_PHONE_NUMBER</span>=+260...</div>
              <div><span className="text-[#E5B85C]">TELEGRAM_CHANNEL</span>=@channel_or_-100id</div>
              <div><span className="text-[#E5B85C]">TELEGRAM_SESSION_STRING</span>=optional_saved_session</div>
              <div><span className="text-slate-400">KEY_ENCRYPTION_SECRET</span>=32_char_random_secret</div>
              <div><span className="text-slate-400">PORT</span>=3000 (auto-injected by Railway)</div>
            </div>
          </div>
        </section>

        {/* Live Channel Message & Parsed Signal Feed */}
        <section className="lg:col-span-7 rounded-xl border border-white/10 bg-[#111722] p-4 sm:p-5 flex flex-col min-h-[420px]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-3">
            <div className="flex items-center gap-2">
              <MessageSquareText className="w-4 h-4 text-[#E5B85C]" />
              <h2 className="text-sm font-semibold text-slate-100">
                Live Channel Feed &amp; Signal Parser
              </h2>
            </div>
            <span className="text-[11px] font-mono text-slate-400">
              {tg?.lastMessageAt
                ? `Last msg: ${new Date(tg.lastMessageAt).toLocaleTimeString()}`
                : 'Waiting for channel messages'}
            </span>
          </div>

          {messages.length === 0 ? (
            <div className="flex-1 flex flex-col items-center justify-center text-center py-12 px-4">
              <MessageSquareText className="w-8 h-8 text-slate-600 mb-3" />
              <p className="text-sm font-medium text-slate-300">
                No channel messages received yet
              </p>
              <p className="mt-1 text-xs text-slate-500 max-w-md">
                Enter your Telegram API_ID, API_HASH, Phone Number, and Channel Link/ID, click{' '}
                <strong className="text-slate-300">Connect Telegram</strong>, then click{' '}
                <strong className="text-slate-300">Start Listening</strong>. New messages will appear live here and valid signals will be parsed automatically.
              </p>
            </div>
          ) : (
            <div className="mt-4 space-y-3 max-h-[680px] overflow-y-auto pr-1">
              {messages.map((msg) => {
                const p = msg.parsed;
                const isSig = p.isSignal;
                const isBuy = p.direction === 'BUY';

                return (
                  <article
                    key={msg.id}
                    className={`rounded-lg border p-3.5 space-y-2.5 ${
                      isSig
                        ? 'border-[#D4A853]/35 bg-[#0E1420]'
                        : 'border-white/8 bg-[#0B0F17]'
                    }`}
                  >
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="flex flex-wrap items-center gap-2 min-w-0">
                        {isSig ? (
                          <span
                            className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[11px] font-mono font-bold border ${
                              isBuy
                                ? 'border-emerald-500/40 bg-emerald-500/15 text-emerald-300'
                                : 'border-red-500/40 bg-red-500/15 text-red-300'
                            }`}
                          >
                            {isBuy ? (
                              <TrendingUp className="w-3 h-3" />
                            ) : (
                              <TrendingDown className="w-3 h-3" />
                            )}
                            SIGNAL · {p.pair} {p.direction}
                          </span>
                        ) : (
                          <span className="px-2 py-0.5 rounded text-[11px] font-mono border border-white/12 bg-white/5 text-slate-300">
                            Normal Message · Not Traded
                          </span>
                        )}
                        <span className="text-[11px] text-slate-400 truncate max-w-[180px]">
                          {msg.channelTitle}
                        </span>
                      </div>

                      <span className="text-[11px] font-mono text-slate-500 shrink-0">
                        {msg.lusakaTime} CAT
                      </span>
                    </div>

                    <p className="text-xs text-slate-200 whitespace-pre-wrap break-words leading-relaxed bg-black/20 rounded p-2.5 border border-white/5">
                      {msg.text}
                    </p>

                    {isSig && (
                      <div className="space-y-2">
                        <div className="grid grid-cols-2 sm:grid-cols-5 gap-2 text-xs font-mono">
                          <div className="rounded bg-[#0B0F17] border border-white/8 px-2.5 py-1.5">
                            <span className="block text-[10px] text-slate-500">ENTRY</span>
                            <span className="text-slate-100 font-semibold">
                              {p.entry !== null ? formatPriceValue(p.entry) : 'MARKET'}
                            </span>
                          </div>
                          <div className="rounded bg-[#0B0F17] border border-red-500/20 px-2.5 py-1.5">
                            <span className="block text-[10px] text-red-400">SL</span>
                            <span className="text-red-200 font-semibold">
                              {formatPriceValue(p.sl)}
                            </span>
                          </div>
                          <div className="rounded bg-[#0B0F17] border border-emerald-500/20 px-2.5 py-1.5">
                            <span className="block text-[10px] text-emerald-400">TP1</span>
                            <span className="text-emerald-200 font-semibold">
                              {formatPriceValue(p.tp1)}
                            </span>
                          </div>
                          <div className="rounded bg-[#0B0F17] border border-emerald-500/20 px-2.5 py-1.5">
                            <span className="block text-[10px] text-emerald-400">TP2</span>
                            <span className="text-emerald-200 font-semibold">
                              {formatPriceValue(p.tp2)}
                            </span>
                          </div>
                          <div className="rounded bg-[#0B0F17] border border-emerald-500/20 px-2.5 py-1.5 col-span-2 sm:col-span-1">
                            <span className="block text-[10px] text-emerald-400">TP3</span>
                            <span className="text-emerald-200 font-semibold">
                              {formatPriceValue(p.tp3)}
                            </span>
                          </div>
                        </div>

                        {p.executionNote && (
                          <div
                            className={`text-[11px] font-mono px-2.5 py-1.5 rounded border break-words ${
                              p.executionStatus === 'EXECUTED'
                                ? 'border-emerald-500/35 bg-emerald-950/25 text-emerald-200'
                                : p.executionStatus === 'BLOCKED'
                                  ? 'border-red-500/35 bg-red-950/25 text-red-200'
                                  : 'border-amber-500/30 bg-amber-950/20 text-amber-200'
                            }`}
                          >
                            Auto-Trading: {p.executionStatus} — {p.executionNote}
                          </div>
                        )}
                      </div>
                    )}
                  </article>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
