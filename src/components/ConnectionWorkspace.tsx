import { useState, useEffect } from 'react';
import { Play, Square, Activity, Save, RotateCcw, RefreshCw } from 'lucide-react';
import type {
  AdapterId,
  AuthHeaderMode,
  BrokerType,
  ConnectionConfig,
  ConnectionSnapshot,
  TransportMode,
} from '../types/connectivity';
import { LivePriceChart } from './LivePriceChart';
import {
  buildMaskedSessionPayload,
  loadBrokerProfile,
  saveBrokerProfile,
  validateBrokerProfile,
} from '../utils/brokerProfileStorage';

interface ConnectionWorkspaceProps {
  snapshot: ConnectionSnapshot;
  adapters: Record<
    AdapterId,
    {
      connectionName: string;
      baseUrl: string;
      endpointPath: string;
      symbol: string;
      authHeaderMode: AuthHeaderMode;
      transport: TransportMode;
      sourceLabel: string;
    }
  >;
  isProbing: boolean;
  isConnecting: boolean;
  isSaving: boolean;
  validationError: string | null;
  fieldErrors: { server: boolean; account: boolean };
  onClearFieldError: (field: 'server' | 'account') => void;
  onSaveConfig: (
    next: Partial<ConnectionConfig> & { mt5Password?: string }
  ) => Promise<void>;
  onRunProbe: (
    override?: Partial<ConnectionConfig> & { mt5Password?: string }
  ) => Promise<void>;
  onConnect: (
    override?: Partial<ConnectionConfig> & { mt5Password?: string }
  ) => Promise<void>;
  onDisconnect: () => Promise<void>;
  onRefreshAccount: () => Promise<void>;
}

const ADAPTER_OPTIONS: Array<{ id: AdapterId; label: string; kind: string }> = [
  { id: 'tickerall-ws', label: 'TickerAll Session + WS', kind: 'POST /v1/sessions + WS' },
  { id: 'bullion-kraken', label: 'Kraken Bullion', kind: 'Live Public Spot' },
  { id: 'bullion-coinbase', label: 'Coinbase PAXG', kind: 'Live Public Spot' },
  { id: 'comex-futures', label: 'COMEX GC=F', kind: 'Futures Feed' },
  { id: 'spot-gold-api', label: 'Gold-API XAU', kind: 'Spot Reference' },
];

export function ConnectionWorkspace({
  snapshot,
  adapters,
  isProbing,
  isConnecting,
  isSaving,
  validationError,
  fieldErrors,
  onClearFieldError,
  onSaveConfig,
  onRunProbe,
  onConnect,
  onDisconnect,
  onRefreshAccount,
}: ConnectionWorkspaceProps) {
  const [draft, setDraft] = useState<ConnectionConfig>(() => {
    const stored = loadBrokerProfile();
    return {
      ...snapshot.config,
      brokerType: stored.brokerType || snapshot.config.brokerType || 'mt5',
      brokerServer: stored.brokerServer || snapshot.config.brokerServer || '',
      mt5AccountNumber: stored.mt5AccountNumber || snapshot.config.mt5AccountNumber || '',
    };
  });
  const [mt5Password, setMt5Password] = useState<string>(() => loadBrokerProfile().mt5Password);
  const [dirty, setDirty] = useState(false);
  const [isRefreshingAccount, setIsRefreshingAccount] = useState(false);

  useEffect(() => {
    if (!dirty) {
      const stored = loadBrokerProfile();
      setDraft({
        ...snapshot.config,
        brokerType: stored.brokerType || snapshot.config.brokerType || 'mt5',
        brokerServer: stored.brokerServer || snapshot.config.brokerServer || '',
        mt5AccountNumber: stored.mt5AccountNumber || snapshot.config.mt5AccountNumber || '',
      });
      if (stored.mt5Password && !mt5Password) {
        setMt5Password(stored.mt5Password);
      }
    }
  }, [snapshot.config, dirty]);

  const handleSelectAdapter = (adapterId: AdapterId) => {
    const preset = adapters[adapterId];
    if (!preset) return;
    setDraft((prev) => ({
      ...prev,
      adapterId,
      connectionName: preset.connectionName,
      baseUrl: preset.baseUrl,
      endpointPath: preset.endpointPath,
      symbol: preset.symbol,
      authHeaderMode: preset.authHeaderMode,
    }));
    setDirty(true);
  };

  const buildPayloadWithSecret = () => {
    const stored = loadBrokerProfile();
    const effectiveBrokerType = draft.brokerType || stored.brokerType || 'mt5';
    const effectiveServer = draft.brokerServer || stored.brokerServer || '';
    const effectiveAccount = draft.mt5AccountNumber || stored.mt5AccountNumber || '';
    const effectivePassword = mt5Password || stored.mt5Password || '';

    saveBrokerProfile({
      brokerType: effectiveBrokerType,
      brokerServer: effectiveServer,
      mt5AccountNumber: effectiveAccount,
      mt5Password: effectivePassword,
    });

    return {
      ...draft,
      brokerType: effectiveBrokerType,
      brokerServer: effectiveServer,
      mt5AccountNumber: effectiveAccount,
      mt5Password: effectivePassword,
    };
  };

  const handleApplyAndProbe = async () => {
    const payload = buildPayloadWithSecret();
    if (payload.adapterId === 'tickerall-ws') {
      const check = validateBrokerProfile({
        brokerServer: payload.brokerServer,
        mt5AccountNumber: payload.mt5AccountNumber,
      });
      if (!check.valid) {
        await onRunProbe(payload);
        return;
      }
    }
    await onSaveConfig(payload);
    setDirty(false);
    await onRunProbe(payload);
  };

  const handleSaveOnly = async (e: React.FormEvent) => {
    e.preventDefault();
    const payload = buildPayloadWithSecret();
    await onSaveConfig(payload);
    setDirty(false);
  };

  const handleResetDraft = () => {
    const stored = loadBrokerProfile();
    setDraft({
      ...snapshot.config,
      brokerType: stored.brokerType || snapshot.config.brokerType || 'mt5',
      brokerServer: stored.brokerServer || snapshot.config.brokerServer || '',
      mt5AccountNumber: stored.mt5AccountNumber || snapshot.config.mt5AccountNumber || '',
    });
    setMt5Password(stored.mt5Password);
    setDirty(false);
  };

  const resolvedUrlPreview = (() => {
    const base = draft.baseUrl.replace(/\/+$/, '');
    const pathPart = draft.endpointPath.startsWith('/')
      ? draft.endpointPath
      : `/${draft.endpointPath}`;
    return `${base}${pathPart.replace(/\{symbol\}/g, draft.symbol)}`;
  })();

  // Price display uses primary tick if available, otherwise fallback Kraken/Gold-API tick
  const displayTick = snapshot.latestTick ?? snapshot.fallbackTick;
  const isFallbackDisplay = snapshot.isFallbackPriceActive;
  const isTickerAllSelected = draft.adapterId === 'tickerall-ws';
  const isStreaming =
    snapshot.status === 'connected' ||
    snapshot.status === 'connecting' ||
    snapshot.status === 'degraded';

  const connectedLabel = snapshot.sessionInfo.tickConfirmed
    ? 'Connected · Tick Confirmed'
    : snapshot.sessionInfo.subscribedConfirmed
      ? 'Connected · Subscribed'
      : 'Connected · Tick Confirmed';

  const statusMeta: Record<
    ConnectionSnapshot['status'],
    { label: string; colorClass: string }
  > = {
    disconnected: { label: 'Disconnected', colorClass: 'text-slate-400' },
    connecting: { label: 'Handshaking · Awaiting Tick', colorClass: 'text-amber-400' },
    connected: { label: connectedLabel, colorClass: 'text-emerald-400' },
    degraded: { label: 'Degraded · Retrying', colorClass: 'text-amber-400' },
    error: { label: 'Disconnected · Probe Failed', colorClass: 'text-red-400' },
  };

  const handleManualAccountRefresh = async () => {
    setIsRefreshingAccount(true);
    try {
      await onRefreshAccount();
    } finally {
      setIsRefreshingAccount(false);
    }
  };

  const formatMoney = (val: number | null | undefined, currency: string) => {
    if (val === null || val === undefined || !Number.isFinite(val)) return '—';
    const prefix = currency === 'USD' ? '$' : `${currency} `;
    return `${prefix}${val.toLocaleString(undefined, {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })}`;
  };

  const acct = snapshot.accountInfo;
  const acctBroker = acct?.broker || draft.brokerType || 'mt5';
  const acctServer = acct?.server || draft.brokerServer || '—';
  const acctNumber = acct?.accountNumber || draft.mt5AccountNumber || '—';
  const acctCurrency = acct?.currency || 'USD';
  const hasMarginData =
    (acct?.margin !== null && acct?.margin !== undefined) ||
    (acct?.freeMargin !== null && acct?.freeMargin !== undefined);
  const isAccountConnected = snapshot.status === 'connected';

  const extractSessionIdentifiers = (
    raw: unknown,
    fallbackSessionId: string | null,
    fallbackAccountId: string | null
  ): { sessionId: string; token: string; accountId: string } => {
    const pickStr = (obj: Record<string, unknown> | null, keys: string[]): string | null => {
      if (!obj) return null;
      for (const k of keys) {
        const val = obj[k];
        if (typeof val === 'string' && val.trim().length > 0) return val;
        if (typeof val === 'number' && Number.isFinite(val)) return String(val);
      }
      return null;
    };

    const rec =
      raw && typeof raw === 'object' && !Array.isArray(raw)
        ? (raw as Record<string, unknown>)
        : null;
    const dataRec =
      rec?.data && typeof rec.data === 'object' && !Array.isArray(rec.data)
        ? (rec.data as Record<string, unknown>)
        : null;
    const sessionRec =
      rec?.session && typeof rec.session === 'object' && !Array.isArray(rec.session)
        ? (rec.session as Record<string, unknown>)
        : null;
    const accountRec =
      rec?.account && typeof rec.account === 'object' && !Array.isArray(rec.account)
        ? (rec.account as Record<string, unknown>)
        : null;
    const resultRec =
      rec?.result && typeof rec.result === 'object' && !Array.isArray(rec.result)
        ? (rec.result as Record<string, unknown>)
        : null;
    const dataSessionRec =
      dataRec?.session && typeof dataRec.session === 'object' && !Array.isArray(dataRec.session)
        ? (dataRec.session as Record<string, unknown>)
        : null;

    const accountId =
      pickStr(rec, ['accountId', 'account_id']) ||
      pickStr(dataRec, ['accountId', 'account_id']) ||
      pickStr(sessionRec, ['accountId', 'account_id']) ||
      pickStr(accountRec, ['accountId', 'account_id', 'id']) ||
      pickStr(resultRec, ['accountId', 'account_id']) ||
      fallbackAccountId ||
      '—';

    const sessionId =
      pickStr(rec, ['sessionId', 'session_id', 'id']) ||
      pickStr(dataRec, ['sessionId', 'session_id', 'id']) ||
      pickStr(sessionRec, ['sessionId', 'session_id', 'id']) ||
      pickStr(dataSessionRec, ['sessionId', 'session_id', 'id']) ||
      pickStr(resultRec, ['sessionId', 'session_id', 'id']) ||
      fallbackSessionId ||
      (accountId !== '—' ? accountId : '—');

    const token =
      pickStr(rec, ['token', 'access_token', 'accessToken', 'jwt', 'authToken']) ||
      pickStr(dataRec, ['token', 'access_token', 'accessToken', 'jwt', 'authToken']) ||
      pickStr(sessionRec, ['token', 'access_token', 'accessToken', 'jwt', 'authToken']) ||
      pickStr(resultRec, ['token', 'access_token', 'accessToken', 'jwt', 'authToken']) ||
      '—';

    return { sessionId, token, accountId };
  };

  const sessionFields = extractSessionIdentifiers(
    snapshot.sessionInfo.rawSessionResponse,
    snapshot.sessionInfo.sessionId,
    snapshot.sessionInfo.accountId
  );

  const resolvedAccountId =
    acct?.accountId ||
    snapshot.sessionInfo.accountId ||
    (sessionFields.accountId !== '—' ? sessionFields.accountId : null);
  const resolvedSessionId =
    snapshot.sessionInfo.sessionId ||
    (sessionFields.sessionId !== '—' ? sessionFields.sessionId : null) ||
    resolvedAccountId;

  const balanceAttempts =
    acct?.attempts && acct.attempts.length > 0
      ? acct.attempts
      : [
          {
            method: 'GET' as const,
            endpoint: `/v1/accounts/${resolvedAccountId || '{accountId}'}`,
            httpStatus: null,
            statusLabel: 'Pending (5s WS fallback)',
            worked: false,
          },
          {
            method: 'GET' as const,
            endpoint: `/v1/sessions/${resolvedSessionId || '{sessionId}'}/balance`,
            httpStatus: null,
            statusLabel: 'Pending',
            worked: false,
          },
          {
            method: 'POST' as const,
            endpoint: `/v1/sessions/${resolvedSessionId || '{sessionId}'}/account-info`,
            httpStatus: null,
            statusLabel: 'Pending',
            worked: false,
          },
        ];

  const outgoingSessionPreview = buildMaskedSessionPayload({
    brokerType: draft.brokerType || 'mt5',
    brokerServer: draft.brokerServer || '',
    mt5AccountNumber: draft.mt5AccountNumber || '',
    mt5Password,
  });
  const outgoingValidation = validateBrokerProfile({
    brokerServer: draft.brokerServer || '',
    mt5AccountNumber: draft.mt5AccountNumber || '',
  });
  const activeErrorMessage = validationError || snapshot.lastError;
  const quietMarketNotice = !snapshot.sessionInfo.tickConfirmed
    ? snapshot.sessionInfo.quietMarketNotice
    : null;

  return (
    <div className="space-y-6">
      {/* Account Balance Card — above Reference Quote */}
      <section
        aria-label="Account Balance"
        className="border border-white/8 bg-[#111722] rounded-lg overflow-hidden"
      >
        <div className="px-4 py-3 border-b border-white/8 flex flex-wrap items-center justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3 text-xs">
            <h2 className="text-sm font-semibold text-slate-100">
              Account Balance
            </h2>
            <span className="text-slate-600" aria-hidden="true">·</span>
            <span className="text-slate-400">
              Connection:{' '}
              <span
                className={
                  isAccountConnected
                    ? 'font-medium text-emerald-400'
                    : 'font-medium text-slate-300'
                }
              >
                {isAccountConnected ? 'Connected' : 'Not Connected'}
              </span>
            </span>
            {acct?.lastUpdatedAt && (
              <>
                <span className="text-slate-600" aria-hidden="true">·</span>
                <span className="font-mono tabular-nums text-slate-400">
                  Updated{' '}
                  {new Date(acct.lastUpdatedAt).toLocaleTimeString([], {
                    hour12: false,
                  })}
                </span>
              </>
            )}
          </div>

          <button
            type="button"
            onClick={handleManualAccountRefresh}
            disabled={isRefreshingAccount}
            className="inline-flex items-center gap-1.5 px-2.5 py-1 text-xs font-medium rounded border border-white/12 bg-[#0E131D] text-slate-300 hover:text-white hover:bg-white/5 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
          >
            <RefreshCw
              className={`w-3 h-3 ${isRefreshingAccount ? 'animate-spin' : ''}`}
            />
            {isRefreshingAccount ? 'Refreshing...' : 'Refresh'}
          </button>
        </div>

        {acct?.statusMessage && (
          <div className="px-4 py-2 bg-amber-950/20 border-b border-amber-500/20 text-xs text-amber-200">
            {acct.statusMessage}
          </div>
        )}

        <div
          className={`grid grid-cols-2 sm:grid-cols-3 ${
            hasMarginData ? 'xl:grid-cols-7' : 'xl:grid-cols-6'
          } divide-y sm:divide-y-0 sm:divide-x divide-white/8`}
        >
          <div className="p-4">
            <p className="text-xs text-slate-400">AccountId</p>
            <p
              className="mt-1 text-xs font-semibold font-mono text-[#D4A853] truncate"
              title={resolvedAccountId || '—'}
            >
              {resolvedAccountId || '—'}
            </p>
          </div>

          <div className="p-4">
            <p className="text-xs text-slate-400">Broker</p>
            <p className="mt-1 text-sm font-semibold font-mono text-slate-100">
              {acctBroker}
            </p>
          </div>

          <div className="p-4">
            <p className="text-xs text-slate-400">Server</p>
            <p
              className="mt-1 text-sm font-semibold font-mono text-slate-100 truncate"
              title={acctServer}
            >
              {acctServer}
            </p>
          </div>

          <div className="p-4">
            <p className="text-xs text-slate-400">Account Number</p>
            <p className="mt-1 text-sm font-semibold font-mono tabular-nums text-slate-100">
              {acctNumber}
            </p>
          </div>

          <div className="p-4">
            <p className="text-xs text-slate-400">Balance</p>
            <p className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-50">
              {formatMoney(acct?.balance, acctCurrency)}
            </p>
          </div>

          <div className="p-4">
            <p className="text-xs text-slate-400">Equity</p>
            <p className="mt-1 text-lg font-semibold font-mono tabular-nums text-slate-50">
              {formatMoney(acct?.equity, acctCurrency)}
            </p>
          </div>

          {hasMarginData && (
            <div className="p-4">
              <p className="text-xs text-slate-400">Margin / Free Margin</p>
              <p className="mt-1 text-sm font-semibold font-mono tabular-nums text-slate-100">
                {formatMoney(acct?.margin, acctCurrency)} /{' '}
                {formatMoney(acct?.freeMargin, acctCurrency)}
              </p>
            </div>
          )}
        </div>

        {/* Ordered Balance Endpoint Attempts & HTTP Status */}
        <div className="px-4 py-2.5 border-t border-white/8 bg-[#0E131D] flex flex-wrap items-center gap-x-5 gap-y-2 text-xs">
          <span className="text-slate-400 font-medium">Balance Endpoint Probes:</span>
          {balanceAttempts.map((attempt, idx) => (
            <div key={`${attempt.method}-${attempt.endpoint}-${idx}`} className="flex items-center gap-1.5 font-mono">
              <span className="text-slate-400">
                {idx + 1}. {attempt.method} {attempt.endpoint}
              </span>
              <span className="text-slate-600">→</span>
              <span
                className={
                  attempt.worked
                    ? 'text-emerald-400 font-semibold'
                    : attempt.httpStatus && attempt.httpStatus >= 400
                      ? 'text-red-400'
                      : attempt.httpStatus && attempt.httpStatus >= 200
                        ? 'text-amber-300'
                        : 'text-slate-400'
                }
              >
                {attempt.statusLabel}
              </span>
            </div>
          ))}
        </div>
      </section>

      {/* 4-Column Metric Strip — single surface with hairline dividers */}
      <section
        aria-label="Live Feed Telemetry"
        className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 border border-white/8 bg-[#111722] rounded-lg divide-y sm:divide-y-0 sm:divide-x divide-white/8"
      >
        <div className="p-4">
          <p className="text-xs text-slate-400">
            Reference Quote · {displayTick ? displayTick.symbol : draft.symbol}
          </p>
          <p className="mt-1.5 text-2xl font-semibold font-mono tabular-nums text-slate-50">
            {displayTick
              ? `$${displayTick.last.toLocaleString(undefined, {
                  minimumFractionDigits: 2,
                  maximumFractionDigits: 2,
                })}`
              : '—'}
          </p>
          <p className="mt-1 text-xs text-slate-400 font-mono tabular-nums">
            {displayTick
              ? isFallbackDisplay
                ? `Fallback Price · ${displayTick.sourceLabel}`
                : displayTick.adapterId === 'tickerall-ws'
                  ? 'TickerAll Live'
                  : displayTick.change24hPct !== null
                    ? `24h ${displayTick.change24hPct >= 0 ? '+' : ''}${displayTick.change24hPct.toFixed(2)}% · ${displayTick.sourceLabel}`
                    : displayTick.sourceLabel
              : 'Awaiting fallback or primary quote'}
          </p>
        </div>

        <div className="p-4">
          <p className="text-xs text-slate-400">Bid / Ask & Spread</p>
          <p className="mt-1.5 text-2xl font-semibold font-mono tabular-nums text-slate-50">
            {displayTick
              ? `${displayTick.bid.toFixed(2)} / ${displayTick.ask.toFixed(2)}`
              : '—'}
          </p>
          <p className="mt-1 text-xs text-slate-400 font-mono tabular-nums">
            {displayTick
              ? `Spread $${displayTick.spread.toFixed(2)} (${displayTick.spreadBps.toFixed(1)} bps)${isFallbackDisplay ? ' · Fallback' : ''}`
              : 'Normalized orderbook top'}
          </p>
        </div>

        <div className="p-4">
          <p className="text-xs text-slate-400">
            {isTickerAllSelected ? 'WebSocket & Session' : 'Round-Trip Latency'}
          </p>
          <p className="mt-1.5 text-2xl font-semibold font-mono tabular-nums text-slate-50">
            {snapshot.latestTick
              ? `${snapshot.latestTick.latencyMs.toFixed(1)} ms`
              : displayTick
                ? `${displayTick.latencyMs.toFixed(1)} ms`
                : '—'}
          </p>
          <p className="mt-1 text-xs text-slate-400 font-mono tabular-nums">
            {isTickerAllSelected
              ? `WS ${snapshot.sessionInfo.wsReadyState} · Tick ${snapshot.sessionInfo.tickConfirmed ? 'Confirmed' : snapshot.sessionInfo.subscribedConfirmed ? 'Subscribed' : 'Unconfirmed'}`
              : snapshot.avgLatencyMs !== null
                ? `Rolling avg ${snapshot.avgLatencyMs.toFixed(1)} ms · HTTP ${snapshot.latestTick?.httpStatus ?? '—'}`
                : `Timeout ceiling ${draft.timeoutMs} ms`}
          </p>
        </div>

        <div className="p-4">
          <p className="text-xs text-slate-400">Connection State</p>
          <p className={`mt-1.5 text-lg font-semibold ${statusMeta[snapshot.status].colorClass}`}>
            {statusMeta[snapshot.status].label}
          </p>
          <p className="mt-2 text-xs text-slate-400 font-mono tabular-nums">
            {snapshot.packetsReceived} primary ticks · {snapshot.failedProbes} errors
          </p>
        </div>
      </section>

      {/* Yellow Quiet-Market Banner (NOT red error) if 30s passes after subscribed without a tick */}
      {quietMarketNotice && !activeErrorMessage && (
        <div
          role="status"
          className="border border-amber-500/40 bg-amber-950/25 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="text-xs text-amber-200">
            <span className="font-semibold text-amber-300">Status: </span>
            <span className="font-mono">{quietMarketNotice}</span>
          </div>
          {isFallbackDisplay && displayTick && (
            <span className="text-xs text-slate-300">
              Showing {displayTick.sourceLabel} bid/ask until next live tick arrives.
            </span>
          )}
        </div>
      )}

      {/* Error Banner when validation fails or primary handshake / WS control frame reports error */}
      {activeErrorMessage && (
        <div
          role="alert"
          className="border border-red-500/40 bg-red-950/30 rounded-lg px-4 py-3 flex flex-wrap items-center justify-between gap-3"
        >
          <div className="text-xs text-red-300">
            <span className="font-semibold text-red-400">TickerAll Error: </span>
            <span className="font-mono text-red-200 break-all">{activeErrorMessage}</span>
          </div>
          <span className="text-xs text-amber-300">
            {isFallbackDisplay && displayTick
              ? `Displaying real bid/ask from ${displayTick.sourceLabel} until TickerAll WebSocket delivers a tick.`
              : 'Verify Broker Server, MT5 Account Number, and TICKERALL_API_KEY.'}
          </span>
        </div>
      )}

      {/* Always-Visible Outgoing Session Payload, Raw Session Response & Raw WS Frames — Above Endpoint & Transport */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
        <div className="space-y-6">
          <section
            aria-label="Outgoing Session Payload"
            className="border border-white/8 bg-[#111722] rounded-lg overflow-hidden"
          >
            <div className="px-4 py-3 border-b border-white/8 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-100">
                  Outgoing Session Payload
                </h2>
                <p className="text-xs text-slate-400">
                  Exact JSON sent to POST /v1/sessions from your 4 saved Connection Profile fields.
                </p>
              </div>
              <span
                className={`text-xs font-mono ${
                  outgoingValidation.valid ? 'text-emerald-400' : 'text-red-400'
                }`}
              >
                {outgoingValidation.valid ? 'Ready' : 'Incomplete'}
              </span>
            </div>

            <pre className="p-4 text-xs font-mono text-slate-200 bg-[#0B0F17] whitespace-pre-wrap break-all">
              {JSON.stringify(outgoingSessionPreview, null, 2)}
            </pre>
          </section>

          <section
            aria-label="Raw Session Response"
            className="border border-white/8 bg-[#111722] rounded-lg overflow-hidden"
          >
            <div className="px-4 py-3 border-b border-white/8 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-100">
                  Raw Session Response
                </h2>
                <p className="text-xs text-slate-400">
                  Full JSON returned by POST /v1/sessions (always visible).
                </p>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-400">
                {snapshot.sessionInfo.rawSessionResponseAt
                  ? new Date(snapshot.sessionInfo.rawSessionResponseAt).toLocaleTimeString([], {
                      hour12: false,
                    })
                  : 'Awaiting POST /v1/sessions'}
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 border-b border-white/8 bg-[#0E131D] divide-y sm:divide-y-0 sm:divide-x divide-white/8 text-xs">
              <div className="px-3 py-2">
                <span className="block text-[11px] text-slate-400">sessionId</span>
                <span className="font-mono text-slate-100 break-all">{sessionFields.sessionId}</span>
              </div>
              <div className="px-3 py-2">
                <span className="block text-[11px] text-slate-400">token</span>
                <span className="font-mono text-slate-100 break-all">{sessionFields.token}</span>
              </div>
              <div className="px-3 py-2">
                <span className="block text-[11px] text-slate-400">accountId</span>
                <span className="font-mono text-slate-100 break-all">{sessionFields.accountId}</span>
              </div>
            </div>

            {snapshot.sessionInfo.rawSessionResponse !== null &&
            snapshot.sessionInfo.rawSessionResponse !== undefined ? (
              <pre className="p-4 text-xs font-mono text-slate-200 bg-[#0B0F17] whitespace-pre-wrap break-all">
                {JSON.stringify(snapshot.sessionInfo.rawSessionResponse, null, 2)}
              </pre>
            ) : (
              <div className="px-4 py-5 text-xs text-slate-400 bg-[#0B0F17]">
                Run Test Handshake or Connect Stream to capture the full POST /v1/sessions JSON response.
              </div>
            )}
          </section>
        </div>

        <div className="space-y-6">
          <section
            aria-label="Raw WS Frames"
            className="border border-white/8 bg-[#111722] rounded-lg overflow-hidden"
          >
            <div className="px-4 py-3 border-b border-white/8 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-100">
                  Raw WS Frames
                </h2>
                <p className="text-xs text-slate-400">
                  Every frame received ({snapshot.sessionInfo.wsReadyState}), last 5 shown without filtering. Non-JSON frames appear as [NON-JSON].
                </p>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-400">
                {snapshot.sessionInfo.rawWsFrames.length} / 5 (last 5)
              </span>
            </div>

            {snapshot.sessionInfo.rawWsFrames.length === 0 ? (
              <div className="px-4 py-5 text-xs text-slate-400 font-mono bg-[#0B0F17]">
                WebSocket {snapshot.sessionInfo.wsReadyState} · Waiting for frames...
              </div>
            ) : (
              <div className="divide-y divide-white/8">
                {snapshot.sessionInfo.rawWsFrames.map((frame, idx) => (
                  <div key={`ws-frame-${frame.index}-${frame.receivedAt}-${idx}`} className="p-3 bg-[#0B0F17]">
                    <div className="flex items-center justify-between text-[11px] font-mono text-slate-400 mb-1">
                      <span>
                        Frame #{frame.index}
                        {frame.payload.startsWith('[NON-JSON]:') ? ' · NON-JSON' : ''}
                      </span>
                      <span>
                        {new Date(frame.receivedAt).toLocaleTimeString([], {
                          hour12: false,
                        })}
                      </span>
                    </div>
                    <pre className="text-xs font-mono text-slate-200 whitespace-pre-wrap break-all">
                      {frame.payload}
                    </pre>
                  </div>
                ))}
              </div>
            )}
          </section>

          <section
            aria-label="Tick Debug"
            className="border border-white/8 bg-[#111722] rounded-lg overflow-hidden"
          >
            <div className="px-4 py-3 border-b border-white/8 flex items-center justify-between gap-4">
              <div>
                <h2 className="text-sm font-semibold text-slate-100">
                  Tick Debug
                </h2>
                <p className="text-xs text-slate-400">
                  Symbol subscription results, rejected list, and live tick frame counters.
                </p>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-400">
                {snapshot.sessionInfo.totalTickFrames ?? snapshot.packetsReceived} ticks
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-white/8 bg-[#0B0F17] text-xs">
              <div className="p-3.5">
                <span className="block text-[11px] text-slate-400 mb-1">
                  Subscribed Symbols
                </span>
                <p className="font-mono text-slate-100 break-words">
                  {snapshot.sessionInfo.subscribedSymbols &&
                  snapshot.sessionInfo.subscribedSymbols.length > 0
                    ? snapshot.sessionInfo.subscribedSymbols.join(', ')
                    : '—'}
                </p>
              </div>

              <div className="p-3.5">
                <span className="block text-[11px] text-slate-400 mb-1">
                  Rejected Symbols
                </span>
                <p
                  className={`font-mono break-words ${
                    snapshot.sessionInfo.rejectedSymbols &&
                    snapshot.sessionInfo.rejectedSymbols.length > 0
                      ? 'text-amber-300'
                      : 'text-emerald-400'
                  }`}
                >
                  {snapshot.sessionInfo.rejectedSymbols &&
                  snapshot.sessionInfo.rejectedSymbols.length > 0
                    ? snapshot.sessionInfo.rejectedSymbols.join(', ')
                    : 'None (0 rejected)'}
                </p>
              </div>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 divide-y sm:divide-y-0 sm:divide-x divide-white/8 border-t border-white/8 bg-[#0E131D] text-xs">
              <div className="p-3.5">
                <span className="block text-[11px] text-slate-400 mb-1">
                  Last Tick Time
                </span>
                <p className="font-mono tabular-nums text-slate-100">
                  {snapshot.sessionInfo.lastTickAt
                    ? new Date(snapshot.sessionInfo.lastTickAt).toLocaleTimeString([], {
                        hour12: false,
                      })
                    : '—'}
                </p>
              </div>

              <div className="p-3.5">
                <span className="block text-[11px] text-slate-400 mb-1">
                  Total Tick Frames Received
                </span>
                <p className="font-mono tabular-nums text-slate-100">
                  {snapshot.sessionInfo.totalTickFrames ?? snapshot.packetsReceived}
                </p>
              </div>
            </div>
          </section>
        </div>
      </div>

      {/* Primary Two-Column Split */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: Adapter & Transport Configuration */}
        <section className="lg:col-span-5 border border-white/8 bg-[#111722] rounded-lg p-5">
          <div className="flex items-center justify-between gap-4 pb-4 border-b border-white/8">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Endpoint & Transport
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                {isTickerAllSelected
                  ? 'Starts a session via POST /v1/sessions and streams live ticks over WebSocket.'
                  : 'Server-side proxy injects credentials without exposing keys to the client.'}
              </p>
            </div>
            {dirty && (
              <button
                type="button"
                onClick={handleResetDraft}
                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 text-xs text-slate-300 hover:text-white border border-white/10 rounded-md transition-colors whitespace-nowrap shrink-0"
              >
                <RotateCcw className="w-3.5 h-3.5" />
                Reset
              </button>
            )}
          </div>

          {/* Adapter Selector */}
          <div className="mt-4">
            <label className="block text-xs font-medium text-slate-300 mb-2">
              Market Data Adapter
            </label>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
              {ADAPTER_OPTIONS.map((opt) => {
                const active = draft.adapterId === opt.id;
                return (
                  <button
                    key={opt.id}
                    type="button"
                    onClick={() => handleSelectAdapter(opt.id)}
                    className={`text-left px-3 py-2.5 rounded-md border transition-colors ${
                      active
                        ? 'border-[#D4A853] bg-[#D4A853]/10 text-slate-50'
                        : 'border-white/8 bg-[#0E131D] text-slate-300 hover:border-white/20'
                    }`}
                  >
                    <div className="text-xs font-semibold truncate">{opt.label}</div>
                    <div className="text-[11px] text-slate-400 mt-0.5 truncate">
                      {opt.kind}
                    </div>
                  </button>
                );
              })}
            </div>
          </div>

          <form onSubmit={handleSaveOnly} className="mt-5 space-y-4">
            <div>
              <label
                htmlFor="conn-name"
                className="block text-xs font-medium text-slate-300 mb-1.5"
              >
                Connection Profile Name
              </label>
              <input
                id="conn-name"
                type="text"
                value={draft.connectionName}
                onChange={(e) => {
                  setDraft({ ...draft, connectionName: e.target.value });
                  setDirty(true);
                }}
                className="w-full px-3 py-2 text-sm bg-[#0B0F17] border border-white/10 rounded-md text-slate-100 focus:outline-none focus:border-[#D4A853]"
              />
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div className="sm:col-span-2">
                <label
                  htmlFor="base-url"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Base URL
                </label>
                <input
                  id="base-url"
                  type="url"
                  required
                  value={draft.baseUrl}
                  onChange={(e) => {
                    setDraft({ ...draft, baseUrl: e.target.value });
                    setDirty(true);
                  }}
                  className="w-full px-3 py-2 text-xs font-mono bg-[#0B0F17] border border-white/10 rounded-md text-slate-100 focus:outline-none focus:border-[#D4A853]"
                />
              </div>

              <div>
                <label
                  htmlFor="symbol-input"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Ticker Symbol
                </label>
                <input
                  id="symbol-input"
                  type="text"
                  required
                  value={draft.symbol}
                  onChange={(e) => {
                    setDraft({ ...draft, symbol: e.target.value });
                    setDirty(true);
                  }}
                  className="w-full px-3 py-2 text-xs font-mono bg-[#0B0F17] border border-white/10 rounded-md text-slate-100 focus:outline-none focus:border-[#D4A853]"
                />
              </div>
            </div>

            <div>
              <label
                htmlFor="endpoint-path"
                className="block text-xs font-medium text-slate-300 mb-1.5"
              >
                {isTickerAllSelected ? 'Session Handshake Path (POST)' : 'Endpoint Path (GET)'}
              </label>
              <input
                id="endpoint-path"
                type="text"
                required
                value={draft.endpointPath}
                onChange={(e) => {
                  setDraft({ ...draft, endpointPath: e.target.value });
                  setDirty(true);
                }}
                className="w-full px-3 py-2 text-xs font-mono bg-[#0B0F17] border border-white/10 rounded-md text-slate-100 focus:outline-none focus:border-[#D4A853]"
              />
              <p className="mt-1.5 text-[11px] font-mono text-slate-400 truncate" title={resolvedUrlPreview}>
                {isTickerAllSelected ? 'POST ' : 'GET '}
                {resolvedUrlPreview}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
              <div>
                <label
                  htmlFor="auth-mode"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Auth Injection
                </label>
                <select
                  id="auth-mode"
                  value={draft.authHeaderMode}
                  onChange={(e) => {
                    setDraft({
                      ...draft,
                      authHeaderMode: e.target.value as AuthHeaderMode,
                    });
                    setDirty(true);
                  }}
                  className="w-full px-3 py-2 text-xs bg-[#0B0F17] border border-white/10 rounded-md text-slate-100 focus:outline-none focus:border-[#D4A853]"
                >
                  <option value="bearer">Bearer Header</option>
                  <option value="x-api-key">X-API-Key Header</option>
                  <option value="query-param">Query ?apikey=</option>
                  <option value="none">Unauthenticated</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="poll-interval"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  {isTickerAllSelected ? 'Fallback Poll' : 'Stream Cadence'}
                </label>
                <select
                  id="poll-interval"
                  value={draft.pollIntervalMs}
                  onChange={(e) => {
                    setDraft({
                      ...draft,
                      pollIntervalMs: Number(e.target.value),
                    });
                    setDirty(true);
                  }}
                  className="w-full px-3 py-2 text-xs font-mono bg-[#0B0F17] border border-white/10 rounded-md text-slate-100 focus:outline-none focus:border-[#D4A853]"
                >
                  <option value={1000}>1000 ms (1 Hz)</option>
                  <option value={2000}>2000 ms (0.5 Hz)</option>
                  <option value={5000}>5000 ms (0.2 Hz)</option>
                  <option value={10000}>10000 ms</option>
                </select>
              </div>

              <div>
                <label
                  htmlFor="timeout-ms"
                  className="block text-xs font-medium text-slate-300 mb-1.5"
                >
                  Timeout (ms)
                </label>
                <input
                  id="timeout-ms"
                  type="number"
                  min={1000}
                  max={20000}
                  step={500}
                  value={draft.timeoutMs}
                  onChange={(e) => {
                    setDraft({
                      ...draft,
                      timeoutMs: Number(e.target.value) || 6000,
                    });
                    setDirty(true);
                  }}
                  className="w-full px-3 py-2 text-xs font-mono tabular-nums bg-[#0B0F17] border border-white/10 rounded-md text-slate-100 focus:outline-none focus:border-[#D4A853]"
                />
              </div>
            </div>

            {/* Broker Session Credentials (POST /v1/sessions) */}
            <div className="pt-3 border-t border-white/8 space-y-3">
              <div className="flex items-center justify-between gap-2">
                <span className="text-xs font-medium text-slate-200">
                  Broker Session Credentials
                </span>
                <span className="text-[11px] text-slate-400">
                  Saved in localStorage
                </span>
              </div>

              {validationError && (
                <p className="text-xs font-medium text-red-400" role="alert">
                  {validationError}
                </p>
              )}

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="broker-type"
                    className="block text-xs font-medium text-slate-300 mb-1.5"
                  >
                    Broker Type
                  </label>
                  <select
                    id="broker-type"
                    value={draft.brokerType || 'mt5'}
                    onChange={(e) => {
                      const nextBroker = e.target.value as BrokerType;
                      saveBrokerProfile({ brokerType: nextBroker });
                      setDraft({
                        ...draft,
                        brokerType: nextBroker,
                      });
                      setDirty(true);
                    }}
                    className="w-full px-3 py-2 text-xs font-mono bg-[#0B0F17] border border-white/10 rounded-md text-slate-100 focus:outline-none focus:border-[#D4A853]"
                  >
                    <option value="mt5">mt5</option>
                    <option value="mt4">mt4</option>
                    <option value="ctrader">ctrader</option>
                    <option value="dxtrade">dxtrade</option>
                  </select>
                </div>

                <div>
                  <label
                    htmlFor="broker-server"
                    className="block text-xs font-medium text-slate-300 mb-1.5"
                  >
                    Broker Server
                  </label>
                  <input
                    id="broker-server"
                    type="text"
                    placeholder="XMGlobal-MT5 2"
                    value={draft.brokerServer || ''}
                    onChange={(e) => {
                      const nextServer = e.target.value;
                      saveBrokerProfile({ brokerServer: nextServer });
                      if (nextServer.trim()) onClearFieldError('server');
                      setDraft({ ...draft, brokerServer: nextServer });
                      setDirty(true);
                    }}
                    className={`w-full px-3 py-2 text-xs font-mono rounded-md text-slate-100 placeholder:text-slate-500 focus:outline-none ${
                      fieldErrors.server
                        ? 'bg-red-950/20 border border-red-500 ring-1 ring-red-500/40 focus:border-red-400'
                        : 'bg-[#0B0F17] border border-white/10 focus:border-[#D4A853]'
                    }`}
                  />
                </div>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label
                    htmlFor="mt5-account"
                    className="block text-xs font-medium text-slate-300 mb-1.5"
                  >
                    MT5 Account Number
                  </label>
                  <input
                    id="mt5-account"
                    type="number"
                    placeholder="e.g. 50123456"
                    value={draft.mt5AccountNumber || ''}
                    onChange={(e) => {
                      const nextAccount = e.target.value;
                      saveBrokerProfile({ mt5AccountNumber: nextAccount });
                      const acctNum = Number(nextAccount.trim());
                      if (nextAccount.trim() && Number.isFinite(acctNum) && acctNum > 0) {
                        onClearFieldError('account');
                      }
                      setDraft({ ...draft, mt5AccountNumber: nextAccount });
                      setDirty(true);
                    }}
                    className={`w-full px-3 py-2 text-xs font-mono tabular-nums rounded-md text-slate-100 placeholder:text-slate-500 focus:outline-none ${
                      fieldErrors.account
                        ? 'bg-red-950/20 border border-red-500 ring-1 ring-red-500/40 focus:border-red-400'
                        : 'bg-[#0B0F17] border border-white/10 focus:border-[#D4A853]'
                    }`}
                  />
                </div>

                <div>
                  <label
                    htmlFor="mt5-password"
                    className="block text-xs font-medium text-slate-300 mb-1.5"
                  >
                    MT5 Password
                  </label>
                  <input
                    id="mt5-password"
                    type="password"
                    autoComplete="new-password"
                    placeholder={
                      snapshot.config.hasBrokerPassword
                        ? '•••••••• (stored)'
                        : 'Enter MT5 password'
                    }
                    value={mt5Password}
                    onChange={(e) => {
                      const nextPwd = e.target.value;
                      saveBrokerProfile({ mt5Password: nextPwd });
                      setMt5Password(nextPwd);
                      setDirty(true);
                    }}
                    className="w-full px-3 py-2 text-xs font-mono bg-[#0B0F17] border border-white/10 rounded-md text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#D4A853]"
                  />
                </div>
              </div>
            </div>

            {/* Session & Environment Binding Status */}
            <div className="pt-3 border-t border-white/8 space-y-2 text-xs">
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">Server Env Secret (TICKERALL_API_KEY)</span>
                <span
                  className={
                    snapshot.envStatus.hasTickerAllApiKey
                      ? 'font-mono text-emerald-400'
                      : 'font-mono text-amber-400'
                  }
                >
                  {snapshot.envStatus.hasTickerAllApiKey
                    ? 'Bound in Environment'
                    : 'Not Set · Session Unauth'}
                </span>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="text-slate-400">MT5 Password Secret</span>
                <span
                  className={
                    snapshot.config.hasBrokerPassword || mt5Password.length > 0
                      ? 'font-mono text-emerald-400'
                      : 'font-mono text-slate-400'
                  }
                >
                  {snapshot.config.hasBrokerPassword
                    ? 'Stored as Server Secret'
                    : mt5Password.length > 0
                      ? 'Ready to Bind on Submit'
                      : 'Not Configured'}
                </span>
              </div>
              {isTickerAllSelected && (
                <div className="flex items-center justify-between gap-3">
                  <span className="text-slate-400">Fallback Price Display</span>
                  <span className="font-mono text-slate-300">
                    {isFallbackDisplay && displayTick
                      ? `${displayTick.sourceLabel} (Active)`
                      : snapshot.sessionInfo.tickConfirmed
                        ? 'Standby (TickerAll Live)'
                        : 'Kraken Bullion / Gold-API'}
                  </span>
                </div>
              )}
            </div>

            <div className="pt-2 flex flex-wrap items-center gap-2.5">
              <button
                type="submit"
                disabled={isSaving || !dirty}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md border border-white/15 bg-[#0E131D] text-slate-200 hover:bg-white/5 disabled:opacity-40 transition-colors whitespace-nowrap shrink-0"
              >
                <Save className="w-3.5 h-3.5" />
                {isSaving ? 'Saving...' : 'Save Profile'}
              </button>

              <button
                type="button"
                onClick={handleApplyAndProbe}
                disabled={isProbing}
                className="inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-medium rounded-md border border-[#D4A853]/40 bg-[#D4A853]/10 text-[#E5B85C] hover:bg-[#D4A853]/20 disabled:opacity-50 transition-colors whitespace-nowrap shrink-0"
              >
                <Activity className="w-3.5 h-3.5" />
                {isProbing ? 'Probing...' : 'Test Handshake'}
              </button>

              {isStreaming ? (
                <button
                  type="button"
                  onClick={onDisconnect}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md bg-red-600/90 text-white hover:bg-red-500 transition-colors whitespace-nowrap shrink-0 ml-auto"
                >
                  <Square className="w-3.5 h-3.5" />
                  Disconnect
                </button>
              ) : (
                <button
                  type="button"
                  onClick={async () => {
                    if (snapshot.bot?.isWeekend) return;
                    const payload = buildPayloadWithSecret();
                    if (payload.adapterId === 'tickerall-ws') {
                      const check = validateBrokerProfile({
                        brokerServer: payload.brokerServer,
                        mt5AccountNumber: payload.mt5AccountNumber,
                      });
                      if (!check.valid) {
                        await onConnect(payload);
                        return;
                      }
                    }
                    if (dirty) {
                      await onSaveConfig(payload);
                      setDirty(false);
                    }
                    await onConnect(payload);
                  }}
                  disabled={isConnecting || Boolean(snapshot.bot?.isWeekend)}
                  className="inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold rounded-md bg-[#D4A853] text-[#0B0F17] hover:bg-[#E0B866] disabled:opacity-40 disabled:cursor-not-allowed transition-colors whitespace-nowrap shrink-0 ml-auto"
                >
                  <Play className="w-3.5 h-3.5" />
                  {snapshot.bot?.isWeekend
                    ? 'Connect Closed (Weekend)'
                    : isConnecting
                      ? 'Connecting...'
                      : 'Connect Stream'}
                </button>
              )}
            </div>
          </form>
        </section>

        {/* Right: Live Price Telemetry & Normalized Tick Ledger */}
        <section className="lg:col-span-7 space-y-6">
          <LivePriceChart
            ticks={snapshot.recentTicks}
            symbol={displayTick?.symbol || draft.symbol}
            onRunProbe={handleApplyAndProbe}
            isProbing={isProbing}
          />

          <div className="border border-white/8 bg-[#111722] rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-white/8 flex items-center justify-between gap-4">
              <div>
                <h3 className="text-sm font-semibold text-slate-100">
                  {isFallbackDisplay
                    ? 'Fallback Market Feed (Price Display Only)'
                    : 'Normalized Tick Stream'}
                </h3>
                <p className="text-xs text-slate-400">
                  {isFallbackDisplay
                    ? 'Showing live Bid/Ask from Kraken Bullion / Gold-API until TickerAll WebSocket confirms a live tick.'
                    : 'Incoming upstream responses mapped to Gold Master unified quote packets.'}
                </p>
              </div>
              <span className="text-xs font-mono tabular-nums text-slate-400">
                Showing {Math.min(snapshot.recentTicks.length, 12)} ticks
              </span>
            </div>

            {snapshot.recentTicks.length === 0 ? (
              <div className="px-4 py-10 text-center text-xs text-slate-400">
                Waiting for first verified response packet from {draft.connectionName}.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-left border-collapse">
                  <thead>
                    <tr className="border-b border-white/8 text-[11px] font-medium text-slate-400 bg-[#0E131D]">
                      <th className="py-2.5 px-3 font-mono">Seq</th>
                      <th className="py-2.5 px-3">Time</th>
                      <th className="py-2.5 px-3">Source</th>
                      <th className="py-2.5 px-3 text-right">Bid</th>
                      <th className="py-2.5 px-3 text-right">Ask</th>
                      <th className="py-2.5 px-3 text-right">Spread</th>
                      <th className="py-2.5 px-3 text-right">Latency</th>
                      <th className="py-2.5 px-3 text-right">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/6 text-xs font-mono tabular-nums">
                    {snapshot.recentTicks.slice(0, 12).map((tick, idx) => (
                      <tr
                        key={`tick-row-${tick.seq}-${tick.receivedAt}-${idx}`}
                        className="h-[38px] hover:bg-white/[0.03] transition-colors"
                      >
                        <td className="px-3 text-slate-400">#{tick.seq}</td>
                        <td className="px-3 text-slate-300">
                          {new Date(tick.receivedAt).toLocaleTimeString([], {
                            hour12: false,
                          })}
                        </td>
                        <td className="px-3 font-sans text-slate-200">
                          {tick.isFallback ? `Fallback · ${tick.sourceLabel}` : tick.symbol}
                        </td>
                        <td className="px-3 text-right text-slate-200">
                          {tick.bid.toFixed(2)}
                        </td>
                        <td className="px-3 text-right text-slate-200">
                          {tick.ask.toFixed(2)}
                        </td>
                        <td className="px-3 text-right text-slate-400">
                          {tick.spread.toFixed(2)}
                        </td>
                        <td className="px-3 text-right text-emerald-400">
                          {tick.latencyMs.toFixed(1)} ms
                        </td>
                        <td className="px-3 text-right text-slate-400">
                          {tick.httpStatus}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}
