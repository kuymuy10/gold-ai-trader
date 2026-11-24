import { initializeApp, getApps, getApp } from 'firebase/app';
import {
  getAuth,
  GoogleAuthProvider,
  signInWithPopup,
  signOut,
  onAuthStateChanged,
  type User as FirebaseUser,
} from 'firebase/auth';
import {
  getFirestore,
  doc,
  getDoc,
  getDocFromServer,
  getDocs,
  setDoc,
  updateDoc,
  deleteDoc,
  collection,
  writeBatch,
  serverTimestamp,
  type Timestamp,
} from 'firebase/firestore';
import firebaseConfig from '../../firebase-applet-config.json';
import type {
  BrokerAccountSetup,
  DaySessionLevels,
  EmaStochasticProConfig,
  MasterConfigSyncBundle,
  MoMoConfig,
  PlanPricing,
  StrategySettings,
  TradeLogEntry,
  UserSyncBundle,
} from '../types/connectivity';

const app = getApps().length ? getApp() : initializeApp(firebaseConfig);
export const db = getFirestore(app, firebaseConfig.firestoreDatabaseId);
export const auth = getAuth(app);

const googleProvider = new GoogleAuthProvider();
googleProvider.setCustomParameters({ prompt: 'select_account' });

export enum OperationType {
  CREATE = 'create',
  UPDATE = 'update',
  DELETE = 'delete',
  LIST = 'list',
  GET = 'get',
  WRITE = 'write',
}

export interface FirestoreErrorInfo {
  error: string;
  operationType: OperationType;
  path: string | null;
  authInfo: {
    userId?: string | null;
    email?: string | null;
    emailVerified?: boolean | null;
    isAnonymous?: boolean | null;
    tenantId?: string | null;
    providerInfo?: {
      providerId?: string | null;
      email?: string | null;
    }[];
  };
}

export function handleFirestoreError(
  error: unknown,
  operationType: OperationType,
  path: string | null
): never {
  const errInfo: FirestoreErrorInfo = {
    error: error instanceof Error ? error.message : String(error),
    authInfo: {
      userId: auth.currentUser?.uid,
      email: auth.currentUser?.email,
      emailVerified: auth.currentUser?.emailVerified,
      isAnonymous: auth.currentUser?.isAnonymous,
      tenantId: auth.currentUser?.tenantId,
      providerInfo:
        auth.currentUser?.providerData?.map((provider) => ({
          providerId: provider.providerId,
          email: provider.email,
        })) || [],
    },
    operationType,
    path,
  };
  console.error('Firestore Error: ', JSON.stringify(errInfo));
  throw new Error(JSON.stringify(errInfo));
}

async function testConnection() {
  try {
    await getDocFromServer(doc(db, 'test', 'connection'));
  } catch (error) {
    if (error instanceof Error && error.message.includes('the client is offline')) {
      console.error('Please check your Firebase configuration.');
    }
  }
}

void testConnection();

export function subscribeFirebaseAuth(cb: (user: FirebaseUser | null) => void) {
  return onAuthStateChanged(auth, cb);
}

export async function signInWithGooglePopup(): Promise<{
  user: FirebaseUser;
  idToken: string;
}> {
  const cred = await signInWithPopup(auth, googleProvider);
  const idToken = await cred.user.getIdToken(true);
  return { user: cred.user, idToken };
}

export async function signOutFirebase(): Promise<void> {
  await signOut(auth);
}

export function formatFirestoreErrorForUi(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  try {
    const parsed = JSON.parse(raw) as { error?: string; path?: string; operationType?: string };
    if (parsed?.error) {
      return `${parsed.error}${parsed.path ? ` (${parsed.operationType || 'write'} ${parsed.path})` : ''}`;
    }
  } catch {
    // Plain error string
  }
  return raw;
}

function clampStr(val: unknown, maxLen: number, fallback = ''): string {
  const s = typeof val === 'string' && val.length > 0 ? val : fallback;
  return s.slice(0, maxLen);
}

function minLenStr(val: unknown, minLen: number, maxLen: number, fallback: string): string {
  const s = typeof val === 'string' ? val.trim() : '';
  if (s.length >= minLen) {
    return s.slice(0, maxLen);
  }
  return fallback.slice(0, maxLen);
}

function finiteNum(val: unknown, fallback = 0, min?: number): number {
  const n = typeof val === 'number' ? val : Number(val);
  const safe = Number.isFinite(n) ? n : fallback;
  return typeof min === 'number' ? Math.max(min, safe) : safe;
}

function safeId(val: unknown, fallback: string): string {
  const raw = typeof val === 'string' ? val : fallback;
  const cleaned = raw.replace(/[^a-zA-Z0-9_\-]/g, '-').slice(0, 128);
  return cleaned || fallback;
}

function sanitizeBrokerSetup(setup: BrokerAccountSetup): BrokerAccountSetup {
  const accountVariant =
    setup?.accountVariant === 'CENT_USD' ||
    setup?.accountVariant === 'CENT_USC' ||
    setup?.accountVariant === 'ECN_RAW'
      ? setup.accountVariant
      : 'STANDARD';
  return {
    platformMt5: Boolean(setup?.platformMt5),
    accountStandard: Boolean(setup?.accountStandard),
    currencyUsd: Boolean(setup?.currencyUsd),
    leverageValid: Boolean(setup?.leverageValid),
    hasWrongMt4OrCtrader: Boolean(setup?.hasWrongMt4OrCtrader),
    hasWrongCentOrEcn: false,
    hasWrongZmwOrEur: Boolean(setup?.hasWrongZmwOrEur),
    selectedBrokerPreset:
      setup?.selectedBrokerPreset === 'Exness' ||
      setup?.selectedBrokerPreset === 'Weltrade' ||
      setup?.selectedBrokerPreset === 'XM' ||
      setup?.selectedBrokerPreset === 'Other'
        ? setup.selectedBrokerPreset
        : 'XM',
    accountVariant,
    confirmedAt: setup?.confirmedAt ? clampStr(setup.confirmedAt, 64) : null,
  };
}

function sanitizeEmaProConfig(ema?: Partial<EmaStochasticProConfig>): EmaStochasticProConfig {
  const tradingMode =
    ema?.tradingMode === 'AUTOMATIC_TRADING' || ema?.tradingMode === 'BOTH'
      ? ema.tradingMode
      : 'SIGNALS_ONLY';
  const tradingRunState =
    ema?.tradingRunState === 'RUNNING' ||
    ema?.tradingRunState === 'PAUSED' ||
    ema?.tradingRunState === 'EMERGENCY_STOP'
      ? ema.tradingRunState
      : 'STOPPED';

  return {
    emaFast: finiteNum(ema?.emaFast, 9, 1),
    emaMid: finiteNum(ema?.emaMid, 21, 1),
    emaIntermediate: finiteNum(ema?.emaIntermediate, 50, 1),
    emaMajor: finiteNum(ema?.emaMajor, 200, 1),
    stochK: finiteNum(ema?.stochK, 14, 1),
    stochD: finiteNum(ema?.stochD, 3, 1),
    stochSlowing: finiteNum(ema?.stochSlowing, 3, 1),
    stochOverbought: Math.min(100, finiteNum(ema?.stochOverbought, 80, 50)),
    stochOversold: Math.min(50, finiteNum(ema?.stochOversold, 20, 0)),
    stochMidpoint: Math.min(80, finiteNum(ema?.stochMidpoint, 50, 20)),
    atrPeriod: finiteNum(ema?.atrPeriod, 14, 1),
    atrSlMultiplier: finiteNum(ema?.atrSlMultiplier, 1.5, 0.1),
    smcLookbackBars: finiteNum(ema?.smcLookbackBars, 80, 10),
    swingStrength: finiteNum(ema?.swingStrength, 2, 1),
    m1RefinementEnabled: Boolean(ema?.m1RefinementEnabled),
    aiConfidenceThreshold: Math.min(100, finiteNum(ema?.aiConfidenceThreshold, 75, 1)),
    maxRiskPercent: Math.min(10, finiteNum(ema?.maxRiskPercent, 1.0, 0.1)),
    maxSimultaneousPositions: Math.min(20, finiteNum(ema?.maxSimultaneousPositions, 2, 1)),
    maxTradesPerSession: Math.min(30, finiteNum(ema?.maxTradesPerSession, 5, 1)),
    minRewardRisk: finiteNum(ema?.minRewardRisk, 2.0, 0.5),
    tp1Rr: finiteNum(ema?.tp1Rr, 1.0, 0.5),
    tp2Rr: finiteNum(ema?.tp2Rr, 2.0, 0.5),
    tp3Rr: finiteNum(ema?.tp3Rr, 3.0, 0.5),
    partialProfitEnabled: ema?.partialProfitEnabled !== false,
    moveSlToTp1OnTp1: ema?.moveSlToTp1OnTp1 !== false,
    moveSlToTp2OnTp2: ema?.moveSlToTp2OnTp2 !== false,
    maxSpreadPips: finiteNum(ema?.maxSpreadPips, 80, 1),
    spreadSensitivity:
      ema?.spreadSensitivity === 'CONSERVATIVE' || ema?.spreadSensitivity === 'AGGRESSIVE'
        ? ema.spreadSensitivity
        : 'BALANCED',
    allowHighSpreadTrades: Boolean(ema?.allowHighSpreadTrades),
    minNetRewardRisk: finiteNum(ema?.minNetRewardRisk, 1.6, 0.5),
    commissionPerLot: finiteNum(ema?.commissionPerLot, 0, 0),
    estimatedSlippagePoints: finiteNum(ema?.estimatedSlippagePoints, 5, 0),
    maxQuoteAgeSeconds: finiteNum(ema?.maxQuoteAgeSeconds, 15, 1),
    signalExpiryMinutes: finiteNum(ema?.signalExpiryMinutes, 15, 1),
    maxEntryDeviationPips: finiteNum(ema?.maxEntryDeviationPips, 15, 1),
    xauusdSymbol: minLenStr(ema?.xauusdSymbol, 1, 24, 'GOLD'),
    demoOnlyMode: ema?.demoOnlyMode === undefined ? true : Boolean(ema.demoOnlyMode),
    liveTradingAuthorized: Boolean(ema?.liveTradingAuthorized),
    allowBuy: ema?.allowBuy !== false,
    allowSell: ema?.allowSell !== false,
    tradingMode,
    tradingRunState,
    settingsVersion: finiteNum(ema?.settingsVersion, 1, 0),
  };
}

function sanitizeStrategySettings(settings: StrategySettings): StrategySettings {
  const newsEvents = Array.isArray(settings?.newsEvents)
    ? settings.newsEvents
        .filter((ev): ev is NonNullable<typeof ev> => Boolean(ev && typeof ev === 'object'))
        .slice(0, 30)
        .map((ev) => ({
          id: minLenStr(ev.id, 1, 64, `news-${Math.random().toString(36).slice(2, 6)}`),
          title: clampStr(ev.title, 120, 'USD News Event'),
          timeLusaka: minLenStr(ev.timeLusaka, 1, 16, '15:30'),
          impact: ev.impact === 'MEDIUM' ? ('MEDIUM' as const) : ('HIGH' as const),
          enabled: Boolean(ev.enabled),
        }))
    : [];

  return {
    strategyMode: 'EMA_STOCHASTIC_PRO',
    asianStart: minLenStr(settings?.asianStart, 1, 16, '03:00'),
    asianEnd: minLenStr(settings?.asianEnd, 1, 16, '11:00'),
    londonStart: minLenStr(settings?.londonStart, 1, 16, '11:00'),
    londonEnd: minLenStr(settings?.londonEnd, 1, 16, '19:00'),
    slPips: finiteNum(settings?.slPips, 15, 1),
    maxSlPips: finiteNum(settings?.maxSlPips, 25, 1),
    newsClearanceMins: finiteNum(settings?.newsClearanceMins, 60, 0),
    maxTradesPerDay: finiteNum(settings?.maxTradesPerDay, 10, 1),
    maxConsecutiveLosses: finiteNum(settings?.maxConsecutiveLosses, 3, 1),
    riskPercent: finiteNum(settings?.riskPercent, 0.5, 0.1),
    defaultLotSize: finiteNum(settings?.defaultLotSize, 0.01, 0.01),
    autoLogSignals: Boolean(settings?.autoLogSignals),
    aiApproverEnabled: settings?.aiApproverEnabled !== false,
    maxAutoLotCap: finiteNum(settings?.maxAutoLotCap, 0.5, 0.01),
    dailyGuardPct: finiteNum(settings?.dailyGuardPct, 5.0, 0.1),
    newsEvents,
    emaPro: sanitizeEmaProConfig(settings?.emaPro),
  };
}

function sanitizeLevels(levels: DaySessionLevels): DaySessionLevels {
  const optNum = (v: unknown): number | null =>
    typeof v === 'number' && Number.isFinite(v) ? v : null;
  return {
    dateLusaka: minLenStr(levels?.dateLusaka, 1, 16, new Date().toISOString().slice(0, 10)),
    pdh: optNum(levels?.pdh),
    pdl: optNum(levels?.pdl),
    prevDayDate: levels?.prevDayDate ? clampStr(levels.prevDayDate, 16) : null,
    asianHigh: optNum(levels?.asianHigh),
    asianLow: optNum(levels?.asianLow),
    londonHigh: optNum(levels?.londonHigh),
    londonLow: optNum(levels?.londonLow),
    asianTradesToday: finiteNum(levels?.asianTradesToday, 0, 0),
    londonTradesToday: finiteNum(levels?.londonTradesToday, 0, 0),
    totalTradesToday: finiteNum(levels?.totalTradesToday, 0, 0),
    consecutiveLossesToday: finiteNum(levels?.consecutiveLossesToday, 0, 0),
    manualOverride: Boolean(levels?.manualOverride),
  };
}

function sanitizeTradeForFirestore(
  ownerId: string,
  tr: TradeLogEntry
): Record<string, unknown> {
  const tradeId = safeId(tr.id, `trd-${Date.now()}`);
  const out: Record<string, unknown> = {
    ownerId,
    id: tradeId,
    dateLusaka: minLenStr(tr.dateLusaka, 1, 16, new Date().toISOString().slice(0, 10)),
    timeLusaka: minLenStr(tr.timeLusaka, 1, 16, '00:00'),
    timestamp: minLenStr(tr.timestamp, 1, 64, new Date().toISOString()),
    session:
      tr.session === 'ASIAN_SESSION' ||
      tr.session === 'LONDON_SESSION' ||
      tr.session === 'NEW_YORK_SESSION' ||
      tr.session === 'ALL_SESSIONS'
        ? tr.session
        : 'ALL_SESSIONS',
    symbol: minLenStr(tr.symbol, 1, 24, 'GOLD'),
    side: tr.side === 'SELL' ? 'SELL' : 'BUY',
    entry: finiteNum(tr.entry, 0),
    stop: finiteNum(tr.stop, 0),
    target: finiteNum(tr.target, 0),
    rrRatio: finiteNum(tr.rrRatio, 0),
    lots: finiteNum(tr.lots, 0.01, 0.01),
    riskDollars: finiteNum(tr.riskDollars, 0),
    status:
      tr.status === 'OPEN' ||
      tr.status === 'TP_HIT' ||
      tr.status === 'SL_HIT' ||
      tr.status === 'CLOSED'
        ? tr.status
        : 'SIGNALED',
    notes: clampStr(tr.notes, 600),
  };
  if (tr.signalId) out.signalId = clampStr(tr.signalId, 128);
  if (tr.orderId !== undefined) out.orderId = tr.orderId ? clampStr(tr.orderId, 128) : null;
  if (tr.closedAt !== undefined) out.closedAt = tr.closedAt ? clampStr(tr.closedAt, 64) : null;
  if (tr.strategyModule === 'EMA_STOCHASTIC_PRO') {
    out.strategyModule = tr.strategyModule;
  }
  if (tr.marketCondition) out.marketCondition = clampStr(tr.marketCondition, 40);
  if ((typeof tr.tp1 === 'number' && Number.isFinite(tr.tp1)) || tr.tp1 === null) out.tp1 = tr.tp1;
  if ((typeof tr.tp2 === 'number' && Number.isFinite(tr.tp2)) || tr.tp2 === null) out.tp2 = tr.tp2;
  if ((typeof tr.tp3 === 'number' && Number.isFinite(tr.tp3)) || tr.tp3 === null) out.tp3 = tr.tp3;
  if (typeof tr.tp1Hit === 'boolean') out.tp1Hit = tr.tp1Hit;
  if (typeof tr.tp2Hit === 'boolean') out.tp2Hit = tr.tp2Hit;
  if (
    (typeof tr.tp1RealizedPnl === 'number' && Number.isFinite(tr.tp1RealizedPnl)) ||
    tr.tp1RealizedPnl === null
  ) {
    out.tp1RealizedPnl = tr.tp1RealizedPnl;
  }
  if (
    (typeof tr.tp2RealizedPnl === 'number' && Number.isFinite(tr.tp2RealizedPnl)) ||
    tr.tp2RealizedPnl === null
  ) {
    out.tp2RealizedPnl = tr.tp2RealizedPnl;
  }
  if (typeof tr.breakevenMoved === 'boolean') out.breakevenMoved = tr.breakevenMoved;
  if (tr.executionStatus) out.executionStatus = clampStr(tr.executionStatus, 32);
  if ((typeof tr.exitPrice === 'number' && Number.isFinite(tr.exitPrice)) || tr.exitPrice === null) {
    out.exitPrice = tr.exitPrice;
  }
  if ((typeof tr.pnlDollars === 'number' && Number.isFinite(tr.pnlDollars)) || tr.pnlDollars === null) {
    out.pnlDollars = tr.pnlDollars;
  }
  if (
    (typeof tr.commissionDollars === 'number' && Number.isFinite(tr.commissionDollars)) ||
    tr.commissionDollars === null
  ) {
    out.commissionDollars = tr.commissionDollars;
  }
  if ((typeof tr.swapDollars === 'number' && Number.isFinite(tr.swapDollars)) || tr.swapDollars === null) {
    out.swapDollars = tr.swapDollars;
  }
  if (
    (typeof tr.slippagePips === 'number' && Number.isFinite(tr.slippagePips)) ||
    tr.slippagePips === null
  ) {
    out.slippagePips = tr.slippagePips;
  }
  if (tr.setupStatus) out.setupStatus = clampStr(tr.setupStatus, 120);
  if (tr.executionMode) out.executionMode = clampStr(tr.executionMode, 16);
  if (tr.feedSource) out.feedSource = clampStr(tr.feedSource, 80);
  if (tr.brokerName) out.brokerName = clampStr(tr.brokerName, 80);
  if (
    (typeof tr.balanceBefore === 'number' && Number.isFinite(tr.balanceBefore)) ||
    tr.balanceBefore === null
  ) {
    out.balanceBefore = tr.balanceBefore;
  }
  if (
    (typeof tr.balanceAfter === 'number' && Number.isFinite(tr.balanceAfter)) ||
    tr.balanceAfter === null
  ) {
    out.balanceAfter = tr.balanceAfter;
  }
  return out;
}

export function buildTraderAccountPayload(
  targetId: string,
  bundle: UserSyncBundle,
  forcePendingForNonAdmin = false
): Record<string, unknown> {
  const safeStatus =
    bundle.status === 'ACTIVE' || bundle.status === 'EXPIRED' || bundle.status === 'BLOCKED'
      ? bundle.status
      : 'PENDING';
  const status = forcePendingForNonAdmin ? 'PENDING' : safeStatus;
  return {
    ownerId: targetId,
    appUserId: safeId(bundle.appUserId, targetId),
    fullName: minLenStr(bundle.fullName, 1, 120, 'Trader'),
    brokerName: minLenStr(bundle.brokerName, 1, 80, 'XM'),
    brokerServer: clampStr(bundle.brokerServer, 120),
    mt5Login: minLenStr(bundle.mt5Login, 1, 64, '0'),
    accountType: bundle.accountType === 'Live' ? 'Live' : 'Demo',
    status,
    plan:
      bundle.plan === 'monthly' || bundle.plan === 'quarterly' ? bundle.plan : 'weekly',
    amountKwacha: finiteNum(bundle.amountKwacha, 0, 0),
    amountUsd: finiteNum(bundle.amountUsd, 0, 0),
    paymentMethod: bundle.paymentMethod === 'MTN MoMo' ? 'MTN MoMo' : 'Airtel MoMo',
    transactionId: clampStr(bundle.transactionId, 120),
    submittedAt: minLenStr(bundle.submittedAt, 1, 64, new Date().toISOString()),
    approvedAt: forcePendingForNonAdmin
      ? null
      : bundle.approvedAt
        ? clampStr(bundle.approvedAt, 64)
        : null,
    expiresAt: forcePendingForNonAdmin
      ? null
      : bundle.expiresAt
        ? clampStr(bundle.expiresAt, 64)
        : null,
    feedAccess: forcePendingForNonAdmin ? false : Boolean(bundle.feedAccess),
    autoTradeEnabled: forcePendingForNonAdmin ? false : Boolean(bundle.autoTradeEnabled),
    brokerConnected: Boolean(bundle.brokerConnected),
    balance: finiteNum(bundle.balance, 0, 0),
    equity: finiteNum(bundle.equity, 0, 0),
    brokerSetup: sanitizeBrokerSetup(bundle.brokerSetup),
    settings: sanitizeStrategySettings(bundle.settings),
    levels: sanitizeLevels(bundle.levels),
  };
}

export function buildTraderPrivatePayload(
  targetId: string,
  bundle: UserSyncBundle
): Record<string, unknown> {
  const safePhone = minLenStr(bundle.phone, 4, 32, '0000');
  const safeNorm = minLenStr(bundle.normalizedPhone || safePhone, 4, 32, safePhone);
  const fallbackEmail =
    targetId === auth.currentUser?.uid ? auth.currentUser?.email || '' : '';
  return {
    ownerId: targetId,
    phone: safePhone,
    normalizedPhone: safeNorm,
    email: clampStr(bundle.email || fallbackEmail, 180),
    passwordHash: clampStr(bundle.passwordHash, 256),
    brokerApiKeyLast4: clampStr(bundle.brokerApiKeyLast4, 8),
    hasBrokerApiKey: Boolean(bundle.hasBrokerApiKey),
    brokerBridgeUrl: clampStr(bundle.brokerBridgeUrl, 300),
    hasScreenshot: Boolean(bundle.hasScreenshot),
    lastBalanceSyncAt: bundle.lastBalanceSyncAt
      ? clampStr(bundle.lastBalanceSyncAt, 64)
      : null,
    balanceSyncSource: bundle.balanceSyncSource
      ? clampStr(bundle.balanceSyncSource, 32)
      : null,
  };
}

const TRADER_ACCOUNT_REQUIRED_KEYS = [
  'ownerId',
  'appUserId',
  'fullName',
  'brokerName',
  'brokerServer',
  'mt5Login',
  'accountType',
  'status',
  'plan',
  'amountKwacha',
  'amountUsd',
  'paymentMethod',
  'transactionId',
  'submittedAt',
  'approvedAt',
  'expiresAt',
  'feedAccess',
  'autoTradeEnabled',
  'brokerConnected',
  'balance',
  'equity',
  'brokerSetup',
  'settings',
  'levels',
  'createdAt',
  'updatedAt',
];

const TRADER_ACCOUNT_ALLOWED_KEYS = new Set(TRADER_ACCOUNT_REQUIRED_KEYS);

const TRADER_PRIVATE_REQUIRED_KEYS = [
  'ownerId',
  'phone',
  'normalizedPhone',
  'email',
  'passwordHash',
  'brokerApiKeyLast4',
  'hasBrokerApiKey',
  'brokerBridgeUrl',
  'hasScreenshot',
  'createdAt',
  'updatedAt',
];

const TRADER_PRIVATE_ALLOWED_KEYS = new Set([
  ...TRADER_PRIVATE_REQUIRED_KEYS,
  'lastBalanceSyncAt',
  'balanceSyncSource',
]);

const TRADER_TRADE_REQUIRED_KEYS = [
  'ownerId',
  'id',
  'dateLusaka',
  'timeLusaka',
  'timestamp',
  'session',
  'symbol',
  'side',
  'entry',
  'stop',
  'target',
  'rrRatio',
  'lots',
  'riskDollars',
  'status',
  'notes',
  'createdAt',
  'updatedAt',
];

const TRADER_TRADE_ALLOWED_KEYS = new Set([
  ...TRADER_TRADE_REQUIRED_KEYS,
  'signalId',
  'orderId',
  'closedAt',
  'strategyModule',
  'marketCondition',
  'tp1',
  'tp2',
  'tp3',
  'tp1Hit',
  'tp2Hit',
  'tp1RealizedPnl',
  'tp2RealizedPnl',
  'breakevenMoved',
  'executionStatus',
  'exitPrice',
  'pnlDollars',
  'commissionDollars',
  'swapDollars',
  'slippagePips',
  'setupStatus',
  'executionMode',
  'feedSource',
  'brokerName',
  'balanceBefore',
  'balanceAfter',
]);

function isTimestampValue(v: unknown): boolean {
  return Boolean(
    v &&
      typeof v === 'object' &&
      (typeof (v as { toDate?: unknown }).toDate === 'function' ||
        typeof (v as { seconds?: unknown }).seconds === 'number')
  );
}

function isPermissionDeniedError(err: unknown): boolean {
  const code =
    err && typeof err === 'object' && 'code' in err
      ? String((err as { code?: unknown }).code)
      : '';
  const msg = err instanceof Error ? err.message : String(err);
  return (
    code.includes('permission-denied') ||
    msg.toLowerCase().includes('missing or insufficient permissions') ||
    msg.toLowerCase().includes('permission-denied')
  );
}

function needsLegacyDocReset(
  data: Record<string, unknown> | undefined,
  expectedOwnerId: string,
  allowedKeys: Set<string>,
  requiredKeys: string[]
): boolean {
  if (!data) return false;
  if (data.ownerId !== expectedOwnerId) return true;
  if (!isTimestampValue(data.createdAt)) return true;
  for (const req of requiredKeys) {
    if (!(req in data)) return true;
  }
  for (const key of Object.keys(data)) {
    if (!allowedKeys.has(key)) return true;
  }
  return false;
}

function needsUserAccountReset(
  data: Record<string, unknown> | undefined,
  expectedOwnerId: string
): boolean {
  if (!data) return false;
  if (
    needsLegacyDocReset(
      data,
      expectedOwnerId,
      TRADER_ACCOUNT_ALLOWED_KEYS,
      TRADER_ACCOUNT_REQUIRED_KEYS
    )
  ) {
    return true;
  }
  if (
    typeof data.appUserId !== 'string' ||
    !/^[a-zA-Z0-9_\-]{1,128}$/.test(data.appUserId)
  ) {
    return true;
  }
  if (!data.brokerSetup || typeof data.brokerSetup !== 'object') return true;
  if (!data.levels || typeof data.levels !== 'object') return true;
  const settings = data.settings as Record<string, unknown> | undefined;
  if (
    !settings ||
    typeof settings !== 'object' ||
    settings.strategyMode !== 'EMA_STOCHASTIC_PRO' ||
    !settings.emaPro ||
    typeof settings.emaPro !== 'object'
  ) {
    return true;
  }
  return false;
}

function needsPrivateDocReset(
  data: Record<string, unknown> | undefined,
  expectedOwnerId: string
): boolean {
  if (!data) return false;
  if (
    needsLegacyDocReset(
      data,
      expectedOwnerId,
      TRADER_PRIVATE_ALLOWED_KEYS,
      TRADER_PRIVATE_REQUIRED_KEYS
    )
  ) {
    return true;
  }
  if (typeof data.phone !== 'string' || data.phone.length < 4 || data.phone.length > 32) {
    return true;
  }
  if (
    typeof data.normalizedPhone !== 'string' ||
    data.normalizedPhone.length < 4 ||
    data.normalizedPhone.length > 32
  ) {
    return true;
  }
  return false;
}

function needsTradeDocReset(
  data: Record<string, unknown> | undefined,
  expectedOwnerId: string,
  expectedTradeId: string
): boolean {
  if (!data) return false;
  if (
    needsLegacyDocReset(
      data,
      expectedOwnerId,
      TRADER_TRADE_ALLOWED_KEYS,
      TRADER_TRADE_REQUIRED_KEYS
    )
  ) {
    return true;
  }
  if (data.id !== expectedTradeId) return true;
  if ('strategyModule' in data && data.strategyModule !== 'EMA_STOCHASTIC_PRO') {
    return true;
  }
  return false;
}

export async function saveUserBundleToFirestore(
  bundle: UserSyncBundle,
  options?: { asAdmin?: boolean }
): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser) return;

  const isAdminActor = Boolean(options?.asAdmin);
  if (isAdminActor) {
    await ensureAdminDocExists();
  }

  const targetId = isAdminActor
    ? safeId(bundle.ownerId || bundle.appUserId, currentUser.uid)
    : currentUser.uid;
  const userPath = `users/${targetId}`;
  const privatePath = `users/${targetId}/private/profile`;

  const userRef = doc(db, 'users', targetId);
  const privRef = doc(db, 'users', targetId, 'private', 'profile');

  let existingUserSnap;
  try {
    existingUserSnap = await getDoc(userRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, userPath);
  }

  let existingPrivSnap;
  try {
    existingPrivSnap = await getDoc(privRef);
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, privatePath);
  }

  const existingUserData = existingUserSnap.exists()
    ? (existingUserSnap.data() as Record<string, unknown>)
    : undefined;
  const existingPrivData = existingPrivSnap.exists()
    ? (existingPrivSnap.data() as Record<string, unknown>)
    : undefined;

  let userNeedsCreate = !existingUserSnap.exists();
  if (
    existingUserSnap.exists() &&
    needsUserAccountReset(existingUserData, targetId) &&
    (isAdminActor || existingUserData?.status !== 'ACTIVE')
  ) {
    try {
      await deleteDoc(userRef);
      userNeedsCreate = true;
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, userPath);
    }
  }

  // Step 1: Write parent user document FIRST so subcollection exists() checks always pass
  if (userNeedsCreate) {
    const createPayload = buildTraderAccountPayload(targetId, bundle, !isAdminActor);
    try {
      await setDoc(userRef, {
        ...createPayload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, userPath);
    }
  } else if (isAdminActor) {
    const updatePayload = buildTraderAccountPayload(targetId, bundle, false);
    delete updatePayload.ownerId;
    delete updatePayload.appUserId;
    try {
      await updateDoc(userRef, {
        ...updatePayload,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      if (isPermissionDeniedError(error)) {
        try {
          await deleteDoc(userRef);
          await setDoc(userRef, {
            ...buildTraderAccountPayload(targetId, bundle, false),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          userNeedsCreate = true;
        } catch (recoveryError) {
          handleFirestoreError(recoveryError, OperationType.WRITE, userPath);
        }
      } else {
        handleFirestoreError(error, OperationType.UPDATE, userPath);
      }
    }
  } else {
    const runtimeFields = {
      brokerName: minLenStr(bundle.brokerName, 1, 80, 'XM'),
      brokerServer: clampStr(bundle.brokerServer, 120),
      mt5Login: minLenStr(bundle.mt5Login, 1, 64, '0'),
      accountType: bundle.accountType === 'Live' ? 'Live' : 'Demo',
      autoTradeEnabled: Boolean(bundle.autoTradeEnabled),
      brokerConnected: Boolean(bundle.brokerConnected),
      balance: finiteNum(bundle.balance, 0, 0),
      equity: finiteNum(bundle.equity, 0, 0),
      brokerSetup: sanitizeBrokerSetup(bundle.brokerSetup),
      settings: sanitizeStrategySettings(bundle.settings),
      levels: sanitizeLevels(bundle.levels),
      updatedAt: serverTimestamp(),
    };
    try {
      await updateDoc(userRef, runtimeFields);
    } catch (error) {
      if (isPermissionDeniedError(error) && existingUserData?.status !== 'ACTIVE') {
        try {
          await deleteDoc(userRef);
          await setDoc(userRef, {
            ...buildTraderAccountPayload(targetId, bundle, true),
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
          userNeedsCreate = true;
        } catch (recoveryError) {
          handleFirestoreError(recoveryError, OperationType.WRITE, userPath);
        }
      } else {
        handleFirestoreError(error, OperationType.UPDATE, userPath);
      }
    }
  }

  // Step 2: Write private PII profile AFTER parent users/{targetId} is persisted
  let privNeedsCreate = !existingPrivSnap.exists();
  if (existingPrivSnap.exists() && needsPrivateDocReset(existingPrivData, targetId)) {
    try {
      await deleteDoc(privRef);
      privNeedsCreate = true;
    } catch (error) {
      handleFirestoreError(error, OperationType.DELETE, privatePath);
    }
  }

  const privPayload = buildTraderPrivatePayload(targetId, bundle);
  if (privNeedsCreate) {
    try {
      await setDoc(privRef, {
        ...privPayload,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.CREATE, privatePath);
    }
  } else {
    const updatePriv = { ...privPayload, updatedAt: serverTimestamp() };
    delete (updatePriv as { ownerId?: string }).ownerId;
    try {
      await updateDoc(privRef, updatePriv);
    } catch (error) {
      if (isPermissionDeniedError(error)) {
        try {
          await deleteDoc(privRef);
          await setDoc(privRef, {
            ...privPayload,
            createdAt: serverTimestamp(),
            updatedAt: serverTimestamp(),
          });
        } catch (recoveryError) {
          handleFirestoreError(recoveryError, OperationType.WRITE, privatePath);
        }
      } else {
        handleFirestoreError(error, OperationType.UPDATE, privatePath);
      }
    }
  }

  // Step 3: Record initial payment proof if creating/resetting user with a transactionId
  if (userNeedsCreate && bundle.transactionId) {
    const payIdToWrite = safeId(`pay-${bundle.appUserId}`, `pay-${Date.now()}`);
    const payPath = `users/${targetId}/payments/${payIdToWrite}`;
    const candidatePayRef = doc(db, 'users', targetId, 'payments', payIdToWrite);
    try {
      const existingPaySnap = await getDoc(candidatePayRef);
      if (!existingPaySnap.exists()) {
        await setDoc(candidatePayRef, {
          ownerId: targetId,
          id: payIdToWrite,
          plan:
            bundle.plan === 'monthly' || bundle.plan === 'quarterly' ? bundle.plan : 'weekly',
          amountKwacha: Math.max(0, Number(bundle.amountKwacha) || 0),
          amountUsd: Math.max(0, Number(bundle.amountUsd) || 0),
          paymentMethod: bundle.paymentMethod === 'MTN MoMo' ? 'MTN MoMo' : 'Airtel MoMo',
          transactionId: clampStr(bundle.transactionId, 120),
          status: isAdminActor && bundle.status === 'ACTIVE' ? 'APPROVED' : 'PENDING',
          recordedAt: clampStr(bundle.submittedAt, 64, new Date().toISOString()),
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.WRITE, payPath);
    }
  }

  // Step 4: Admin updates any pending payment records after status transition
  if (
    isAdminActor &&
    (bundle.status === 'ACTIVE' || bundle.status === 'EXPIRED' || bundle.status === 'BLOCKED')
  ) {
    try {
      const paySnap = await getDocs(collection(db, 'users', targetId, 'payments'));
      const pendingPayments = paySnap.docs.filter(
        (pd) => (pd.data() as Record<string, unknown>)?.status === 'PENDING'
      );
      if (pendingPayments.length > 0) {
        const payBatch = writeBatch(db);
        const nextPayStatus = bundle.status === 'ACTIVE' ? 'APPROVED' : 'REJECTED';
        for (const pd of pendingPayments) {
          payBatch.update(pd.ref, {
            status: nextPayStatus,
            updatedAt: serverTimestamp(),
          });
        }
        await payBatch.commit();
      }
    } catch {
      // Non-blocking if no pending payments or legacy payment schema
    }
  }
}

export async function syncRenewalToFirestore(bundle: UserSyncBundle): Promise<void> {
  const currentUser = auth.currentUser;
  if (!currentUser) return;
  const userPath = `users/${currentUser.uid}`;
  const isAdminUser = currentUser.email?.toLowerCase() === 'muyobakuyewana@gmail.com';
  let snap;
  try {
    snap = await getDoc(doc(db, 'users', currentUser.uid));
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, userPath);
  }
  if (
    !snap.exists() ||
    needsUserAccountReset(snap.data() as Record<string, unknown>, currentUser.uid)
  ) {
    await saveUserBundleToFirestore(
      { ...bundle, status: 'PENDING', feedAccess: false, autoTradeEnabled: false },
      { asAdmin: isAdminUser }
    );
  } else {
    try {
      await updateDoc(doc(db, 'users', currentUser.uid), {
        status: 'PENDING',
        plan:
          bundle.plan === 'monthly' || bundle.plan === 'quarterly' ? bundle.plan : 'weekly',
        amountKwacha: Math.max(0, Number(bundle.amountKwacha) || 0),
        amountUsd: Math.max(0, Number(bundle.amountUsd) || 0),
        paymentMethod: bundle.paymentMethod === 'MTN MoMo' ? 'MTN MoMo' : 'Airtel MoMo',
        transactionId: clampStr(bundle.transactionId, 120),
        submittedAt: clampStr(bundle.submittedAt, 64, new Date().toISOString()),
        feedAccess: false,
        autoTradeEnabled: false,
        updatedAt: serverTimestamp(),
      });
    } catch (error) {
      handleFirestoreError(error, OperationType.UPDATE, userPath);
    }
  }

  const payId = safeId(`pay-${Date.now()}`, `pay-${Date.now()}`);
  const payPath = `users/${currentUser.uid}/payments/${payId}`;
  try {
    await setDoc(doc(db, 'users', currentUser.uid, 'payments', payId), {
      ownerId: currentUser.uid,
      id: payId,
      plan:
        bundle.plan === 'monthly' || bundle.plan === 'quarterly' ? bundle.plan : 'weekly',
      amountKwacha: Math.max(0, Number(bundle.amountKwacha) || 0),
      amountUsd: Math.max(0, Number(bundle.amountUsd) || 0),
      paymentMethod: bundle.paymentMethod === 'MTN MoMo' ? 'MTN MoMo' : 'Airtel MoMo',
      transactionId: clampStr(bundle.transactionId, 120),
      status: 'PENDING',
      recordedAt: clampStr(bundle.submittedAt, 64, new Date().toISOString()),
      createdAt: serverTimestamp(),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.CREATE, payPath);
  }
}

export async function syncTradesToFirestore(
  targetUserId: string,
  trades: TradeLogEntry[]
): Promise<void> {
  if (!auth.currentUser || !Array.isArray(trades) || trades.length === 0) return;
  const safeTargetId = safeId(targetUserId, auth.currentUser.uid);
  const recentTrades = trades.slice(0, 25);
  const tradesColPath = `users/${safeTargetId}/trades`;
  let existingSnap;
  try {
    existingSnap = await getDocs(collection(db, 'users', safeTargetId, 'trades'));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, tradesColPath);
  }
  const existingById = new Map(
    existingSnap.docs.map((d) => [d.id, d.data() as Record<string, unknown>])
  );

  for (const tr of recentTrades) {
    const clean = sanitizeTradeForFirestore(safeTargetId, tr);
    const tid = String(clean.id);
    const tradePath = `${tradesColPath}/${tid}`;
    const ref = doc(db, 'users', safeTargetId, 'trades', tid);
    const existingData = existingById.get(tid);

    if (!existingData) {
      try {
        await setDoc(ref, {
          ...clean,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.CREATE, tradePath);
      }
    } else if (needsTradeDocReset(existingData, safeTargetId, tid)) {
      try {
        await deleteDoc(ref);
        await setDoc(ref, {
          ...clean,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        handleFirestoreError(error, OperationType.WRITE, tradePath);
      }
    } else {
      try {
        await updateDoc(ref, {
          ...(clean.orderId !== undefined ? { orderId: clean.orderId } : {}),
          ...(clean.closedAt !== undefined ? { closedAt: clean.closedAt } : {}),
          stop: clean.stop,
          ...(clean.tp1 !== undefined ? { tp1: clean.tp1 } : {}),
          ...(clean.tp2 !== undefined ? { tp2: clean.tp2 } : {}),
          ...(clean.tp3 !== undefined ? { tp3: clean.tp3 } : {}),
          target: clean.target,
          ...(clean.tp1Hit !== undefined ? { tp1Hit: clean.tp1Hit } : {}),
          ...(clean.tp2Hit !== undefined ? { tp2Hit: clean.tp2Hit } : {}),
          ...(clean.tp1RealizedPnl !== undefined
            ? { tp1RealizedPnl: clean.tp1RealizedPnl }
            : {}),
          ...(clean.tp2RealizedPnl !== undefined
            ? { tp2RealizedPnl: clean.tp2RealizedPnl }
            : {}),
          ...(clean.breakevenMoved !== undefined
            ? { breakevenMoved: clean.breakevenMoved }
            : {}),
          status: clean.status,
          ...(clean.executionStatus !== undefined
            ? { executionStatus: clean.executionStatus }
            : {}),
          ...(clean.exitPrice !== undefined ? { exitPrice: clean.exitPrice } : {}),
          ...(clean.pnlDollars !== undefined ? { pnlDollars: clean.pnlDollars } : {}),
          ...(clean.commissionDollars !== undefined
            ? { commissionDollars: clean.commissionDollars }
            : {}),
          ...(clean.swapDollars !== undefined ? { swapDollars: clean.swapDollars } : {}),
          ...(clean.slippagePips !== undefined ? { slippagePips: clean.slippagePips } : {}),
          notes: clean.notes,
          ...(clean.balanceAfter !== undefined ? { balanceAfter: clean.balanceAfter } : {}),
          updatedAt: serverTimestamp(),
        });
      } catch (error) {
        if (isPermissionDeniedError(error)) {
          try {
            await deleteDoc(ref);
            await setDoc(ref, {
              ...clean,
              createdAt: serverTimestamp(),
              updatedAt: serverTimestamp(),
            });
          } catch (recoveryError) {
            handleFirestoreError(recoveryError, OperationType.WRITE, tradePath);
          }
        } else {
          handleFirestoreError(error, OperationType.UPDATE, tradePath);
        }
      }
    }
  }
}

export async function saveAdminPublicConfigToFirestore(
  momo: MoMoConfig,
  plans: PlanPricing
): Promise<void> {
  if (!auth.currentUser) return;
  const path = 'config/public';
  try {
    await ensureAdminDocExists();
    await setDoc(doc(db, 'config', 'public'), {
      momo: {
        airtelNumber: clampStr(momo.airtelNumber, 40),
        mtnNumber: clampStr(momo.mtnNumber, 40),
        recipientName: clampStr(momo.recipientName, 120),
        whatsappRenewNumber: clampStr(momo.whatsappRenewNumber, 40),
      },
      plans: {
        weekly: {
          label: minLenStr(plans.weekly?.label, 1, 40, 'Weekly'),
          kwacha: finiteNum(plans.weekly?.kwacha, 150, 0),
          usd: finiteNum(plans.weekly?.usd, 5, 0),
          days: Math.min(366, finiteNum(plans.weekly?.days, 7, 1)),
        },
        monthly: {
          label: minLenStr(plans.monthly?.label, 1, 40, 'Monthly'),
          kwacha: finiteNum(plans.monthly?.kwacha, 500, 0),
          usd: finiteNum(plans.monthly?.usd, 20, 0),
          days: Math.min(366, finiteNum(plans.monthly?.days, 30, 1)),
        },
        quarterly: {
          label: minLenStr(plans.quarterly?.label, 1, 40, 'Quarterly'),
          kwacha: finiteNum(plans.quarterly?.kwacha, 1200, 0),
          usd: finiteNum(plans.quarterly?.usd, 45, 0),
          days: Math.min(366, finiteNum(plans.quarterly?.days, 90, 1)),
        },
      },
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function fetchPublicConfigFromFirestore(): Promise<{
  momo?: MoMoConfig;
  plans?: PlanPricing;
} | null> {
  try {
    const cfgSnap = await getDoc(doc(db, 'config', 'public'));
    if (cfgSnap.exists()) {
      return cfgSnap.data() as { momo?: MoMoConfig; plans?: PlanPricing };
    }
  } catch {
    // Non-blocking fallback
  }
  return null;
}

export async function saveAdminMasterConfigToFirestore(
  master: MasterConfigSyncBundle
): Promise<void> {
  if (!auth.currentUser) return;
  const path = 'adminConfig/master';
  try {
    await ensureAdminDocExists();
    await setDoc(doc(db, 'adminConfig', 'master'), {
      baseUrl: minLenStr(master.baseUrl, 1, 200, 'https://api.tickerall.com'),
      brokerServer: clampStr(master.brokerServer, 120),
      mt5AccountNumber: clampStr(master.mt5AccountNumber, 64),
      apiKeyLast4: clampStr(master.apiKeyLast4, 8),
      hasMasterKey: Boolean(master.hasMasterKey),
      hasMasterPassword: Boolean(master.hasMasterPassword),
      apiKeyEnc: clampStr(master.apiKeyEnc, 1024),
      passwordEnc: clampStr(master.passwordEnc, 1024),
      quotaUsed: finiteNum(master.quotaUsed, 0, 0),
      desiredConnected: Boolean(master.desiredConnected),
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, path);
  }
}

export async function fetchAllUsersFromFirestoreForAdmin(): Promise<{
  users: UserSyncBundle[];
  publicConfig: { momo?: MoMoConfig; plans?: PlanPricing } | null;
  masterConfig: Partial<MasterConfigSyncBundle> | null;
}> {
  if (!auth.currentUser) return { users: [], publicConfig: null, masterConfig: null };
  let publicConfig: { momo?: MoMoConfig; plans?: PlanPricing } | null = null;
  let masterConfig: Partial<MasterConfigSyncBundle> | null = null;

  try {
    const cfgSnap = await getDoc(doc(db, 'config', 'public'));
    if (cfgSnap.exists()) {
      publicConfig = cfgSnap.data() as { momo?: MoMoConfig; plans?: PlanPricing };
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.GET, 'config/public');
  }

  try {
    const masterSnap = await getDoc(doc(db, 'adminConfig', 'master'));
    if (masterSnap.exists()) {
      masterConfig = masterSnap.data() as Partial<MasterConfigSyncBundle>;
    }
  } catch {
    // Master doc may not exist yet on first run
  }

  let usersDocs;
  try {
    usersDocs = await getDocs(collection(db, 'users'));
  } catch (error) {
    handleFirestoreError(error, OperationType.LIST, 'users');
  }

  const bundles: UserSyncBundle[] = [];
  for (const userDoc of usersDocs.docs) {
    const uid = userDoc.id;
    if (!/^[a-zA-Z0-9_\-]{1,128}$/.test(uid)) continue;
    const u = userDoc.data() as Record<string, unknown>;

    let priv: Record<string, unknown> = {};
    try {
      const privSnap = await getDoc(doc(db, 'users', uid, 'private', 'profile'));
      if (privSnap.exists()) {
        priv = privSnap.data() as Record<string, unknown>;
      }
    } catch (error) {
      handleFirestoreError(error, OperationType.GET, `users/${uid}/private/profile`);
    }

    let trades: TradeLogEntry[] = [];
    try {
      const tradesSnap = await getDocs(collection(db, 'users', uid, 'trades'));
      trades = tradesSnap.docs.map((td) => td.data() as TradeLogEntry);
    } catch (error) {
      handleFirestoreError(error, OperationType.LIST, `users/${uid}/trades`);
    }

    const toIso = (v: unknown): string | null => {
      if (!v) return null;
      if (typeof v === 'string') return v;
      if (typeof (v as Timestamp)?.toDate === 'function') {
        return (v as Timestamp).toDate().toISOString();
      }
      return null;
    };

    const firestoreUpdatedAt = toIso(u.updatedAt);

    bundles.push({
      ownerId: String(u.ownerId || uid),
      appUserId: String(u.appUserId || uid),
      fullName: String(u.fullName || 'Trader'),
      phone: String(priv.phone || ''),
      normalizedPhone: String(priv.normalizedPhone || priv.phone || ''),
      email: String(priv.email || ''),
      passwordHash: String(priv.passwordHash || ''),
      brokerName: String(u.brokerName || 'XM'),
      brokerServer: String(u.brokerServer || ''),
      mt5Login: String(u.mt5Login || ''),
      brokerApiKeyLast4: String(priv.brokerApiKeyLast4 || ''),
      hasBrokerApiKey: Boolean(priv.hasBrokerApiKey),
      brokerBridgeUrl: String(priv.brokerBridgeUrl || ''),
      brokerConnected: Boolean(u.brokerConnected),
      brokerSetup: u.brokerSetup as BrokerAccountSetup,
      accountType: u.accountType === 'Live' ? 'Live' : 'Demo',
      status: (u.status as UserSyncBundle['status']) || 'PENDING',
      plan: (u.plan as UserSyncBundle['plan']) || 'weekly',
      amountKwacha: Number(u.amountKwacha) || 0,
      amountUsd: Number(u.amountUsd) || 0,
      paymentMethod: u.paymentMethod === 'MTN MoMo' ? 'MTN MoMo' : 'Airtel MoMo',
      transactionId: String(u.transactionId || ''),
      hasScreenshot: Boolean(priv.hasScreenshot),
      submittedAt: String(u.submittedAt || new Date().toISOString()),
      approvedAt: u.approvedAt ? String(u.approvedAt) : null,
      expiresAt: u.expiresAt ? String(u.expiresAt) : null,
      feedAccess: Boolean(u.feedAccess),
      autoTradeEnabled: Boolean(u.autoTradeEnabled),
      balance: Number(u.balance) || 0,
      equity: Number(u.equity) || 0,
      lastBalanceSyncAt: priv.lastBalanceSyncAt ? String(priv.lastBalanceSyncAt) : null,
      balanceSyncSource: (priv.balanceSyncSource as UserSyncBundle['balanceSyncSource']) ?? null,
      settings: u.settings as StrategySettings,
      levels: u.levels as DaySessionLevels,
      trades,
      createdAt: toIso(u.createdAt) || String(u.submittedAt || new Date().toISOString()),
      firestoreUpdatedAt,
    });
  }

  // Deduplicate duplicate appUserId entries (preferring most recently updated & linked doc)
  const dedupedByAppId = new Map<string, UserSyncBundle>();
  bundles.sort((a, b) => {
    const aLinked = a.ownerId !== a.appUserId ? 1 : 0;
    const bLinked = b.ownerId !== b.appUserId ? 1 : 0;
    const aMs = a.firestoreUpdatedAt ? Date.parse(a.firestoreUpdatedAt) : 0;
    const bMs = b.firestoreUpdatedAt ? Date.parse(b.firestoreUpdatedAt) : 0;
    if (aMs !== bMs) return aMs - bMs;
    return aLinked - bLinked;
  });
  for (const b of bundles) {
    dedupedByAppId.set(b.appUserId, b);
  }

  return { users: Array.from(dedupedByAppId.values()), publicConfig, masterConfig };
}

export async function ensureAdminDocExists(): Promise<void> {
  const user = auth.currentUser;
  if (!user || user.email?.toLowerCase() !== 'muyobakuyewana@gmail.com') return;
  const adminPath = `admins/${user.uid}`;
  try {
    const ref = doc(db, 'admins', user.uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        uid: user.uid,
        email: user.email,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });
    }
  } catch (error) {
    handleFirestoreError(error, OperationType.WRITE, adminPath);
  }
}

export async function updateUserBasicInFirestore(
  userId: string,
  fields: Record<string, unknown>
): Promise<void> {
  if (!auth.currentUser) return;
  const path = `users/${userId}`;
  try {
    await updateDoc(doc(db, 'users', userId), {
      ...fields,
      updatedAt: serverTimestamp(),
    });
  } catch (error) {
    handleFirestoreError(error, OperationType.UPDATE, path);
  }
}
