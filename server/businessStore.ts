import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { Request, Response } from 'express';
import {
  DEFAULT_STRATEGY_SETTINGS,
  getLusakaClock,
  round2,
} from '../src/utils/strategyEngine.ts';
import {
  DEFAULT_EMA_PRO_CONFIG,
  mergeEmaProConfig,
} from '../src/utils/emaStochasticPro.ts';
import { DEFAULT_ADMIN_SPREAD_POLICY } from '../src/utils/dynamicSpread.ts';
import type {
  AdminSpreadPolicy,
  AdminUserRow,
  AiTradeApproval,
  AuditLogRecord,
  BrokerAccountSetup,
  DaySessionLevels,
  MasterConfigSyncBundle,
  MoMoConfig,
  PlanPricing,
  RiskEventRecord,
  SignalHistoryEntry,
  StrategySettings,
  SubscriptionPlan,
  TradeLogEntry,
  TradeOrderRecord,
  UserPublicProfile,
  UserStatus,
  UserSyncBundle,
} from '../src/types/connectivity.ts';

const DATA_DIR = path.resolve(process.cwd(), 'data');
const STORE_PATH = path.join(DATA_DIR, 'business-store.json');
const TMP_STORE_PATH = path.join(DATA_DIR, 'business-store.json.tmp');
const BACKUP_STORE_PATH = path.join(DATA_DIR, 'business-store.bak.json');
const SECRET_PATH = path.join(DATA_DIR, 'server-secret.key');

export const USER_COOKIE_NAME = 'goldai_session';
export const ADMIN_COOKIE_NAME = 'goldai_admin_session';

function ensureDataDir(): boolean {
  try {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
    return true;
  } catch {
    return false;
  }
}

function getMasterSecretBuffer(): Buffer {
  const envSecret = process.env.KEY_ENCRYPTION_SECRET?.trim();
  if (envSecret && envSecret.length >= 16) {
    return crypto.createHash('sha256').update(envSecret).digest();
  }
  try {
    ensureDataDir();
    if (fs.existsSync(SECRET_PATH)) {
      const hex = fs.readFileSync(SECRET_PATH, 'utf8').trim();
      if (hex.length >= 32) {
        return crypto.createHash('sha256').update(hex).digest();
      }
    }
    const generated = crypto.randomBytes(32).toString('hex');
    fs.writeFileSync(SECRET_PATH, generated, { mode: 0o600 });
    return crypto.createHash('sha256').update(generated).digest();
  } catch {
    const ephemeral = crypto.randomBytes(32).toString('hex');
    return crypto.createHash('sha256').update(ephemeral).digest();
  }
}

const MASTER_KEY = getMasterSecretBuffer();

function getCloudWrapKeyBuffer(): Buffer {
  const envSecret = process.env.KEY_ENCRYPTION_SECRET?.trim();
  if (envSecret && envSecret.length >= 16) {
    return crypto.createHash('sha256').update(`cloud-wrap:${envSecret}`).digest();
  }
  let scope = 'gold-ai-trader-default';
  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (fs.existsSync(cfgPath)) {
      const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8')) as {
        projectId?: string;
        firestoreDatabaseId?: string;
      };
      if (cfg?.projectId) {
        scope = `${cfg.projectId}:${cfg.firestoreDatabaseId || '(default)'}`;
      }
    }
  } catch {
    // Fallback to default scope
  }
  return crypto
    .createHash('sha256')
    .update(`gold-ai-trader-master-wrap-v1:${scope}`)
    .digest();
}

const CLOUD_WRAP_KEY = getCloudWrapKeyBuffer();

export function encryptSecret(plain: string): string {
  const clean = plain.trim();
  if (!clean) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', MASTER_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(clean, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${tag.toString('hex')}.${encrypted.toString('hex')}`;
}

export function decryptSecret(payload: string | null | undefined): string {
  if (!payload || typeof payload !== 'string') return '';
  const parts = payload.split('.');
  if (parts.length !== 3) return '';
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const data = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', MASTER_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function encryptCloudMasterSecret(plain: string): string {
  const clean = plain.trim();
  if (!clean) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', CLOUD_WRAP_KEY, iv);
  const encrypted = Buffer.concat([cipher.update(clean, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${iv.toString('hex')}.${tag.toString('hex')}.${encrypted.toString('hex')}`;
}

export function decryptCloudMasterSecret(payload: string | null | undefined): string {
  if (!payload || typeof payload !== 'string') return '';
  const parts = payload.split('.');
  if (parts.length !== 3) return '';
  try {
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    const data = Buffer.from(parts[2], 'hex');
    const decipher = crypto.createDecipheriv('aes-256-gcm', CLOUD_WRAP_KEY, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const derived = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${derived}`;
}

export function verifyPassword(password: string, storedHash: string): boolean {
  const parts = (storedHash || '').split(':');
  if (parts.length !== 2) return false;
  try {
    const salt = parts[0];
    const expected = Buffer.from(parts[1], 'hex');
    const actual = crypto.scryptSync(password, salt, 64);
    if (expected.length !== actual.length) return false;
    return crypto.timingSafeEqual(expected, actual);
  } catch {
    return false;
  }
}

export function normalizePhone(raw: string): string {
  return (raw || '').replace(/[^\d+]/g, '').trim();
}

export function parseCookies(req: Request): Record<string, string> {
  const raw = req.headers.cookie || '';
  const out: Record<string, string> = {};
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = decodeURIComponent(part.slice(0, idx).trim());
    const val = decodeURIComponent(part.slice(idx + 1).trim());
    if (key) out[key] = val;
  }
  return out;
}

function signToken(payloadObj: Record<string, unknown>): string {
  const jsonB64 = Buffer.from(JSON.stringify(payloadObj), 'utf8').toString('base64url');
  const sig = crypto.createHmac('sha256', MASTER_KEY).update(jsonB64).digest('base64url');
  return `${jsonB64}.${sig}`;
}

function verifyToken<T extends Record<string, unknown>>(token: string | undefined): T | null {
  if (!token || !token.includes('.')) return null;
  const [jsonB64, sig] = token.split('.');
  if (!jsonB64 || !sig) return null;
  const expectedSig = crypto.createHmac('sha256', MASTER_KEY).update(jsonB64).digest('base64url');
  try {
    const a = Buffer.from(sig);
    const b = Buffer.from(expectedSig);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(Buffer.from(jsonB64, 'base64url').toString('utf8')) as T;
    if (typeof parsed.exp === 'number' && Date.now() > parsed.exp) return null;
    return parsed;
  } catch {
    return null;
  }
}

function isHttpsRequest(req: Request): boolean {
  const fwdProto = String(req.headers['x-forwarded-proto'] || '').toLowerCase();
  const origin = String(req.headers.origin || '').toLowerCase();
  return req.secure || fwdProto.includes('https') || origin.startsWith('https://');
}

export function setAuthCookie(
  req: Request,
  res: Response,
  name: string,
  payload: Record<string, unknown>
) {
  const exp = Date.now() + 30 * 24 * 60 * 60 * 1000;
  const token = signToken({ ...payload, exp });
  const https = isHttpsRequest(req);
  res.cookie(name, token, {
    httpOnly: true,
    sameSite: https ? 'none' : 'lax',
    secure: https,
    path: '/',
    maxAge: 30 * 24 * 60 * 60 * 1000,
  });
}

export function clearAuthCookie(req: Request, res: Response, name: string) {
  const https = isHttpsRequest(req);
  res.clearCookie(name, {
    path: '/',
    sameSite: https ? 'none' : 'lax',
    secure: https,
  });
}

export function createFreshDayLevels(dateLusaka: string): DaySessionLevels {
  return {
    dateLusaka,
    pdh: null,
    pdl: null,
    prevDayDate: null,
    asianHigh: null,
    asianLow: null,
    londonHigh: null,
    londonLow: null,
    asianTradesToday: 0,
    londonTradesToday: 0,
    totalTradesToday: 0,
    consecutiveLossesToday: 0,
    manualOverride: false,
  };
}

export interface PaymentRecord {
  id: string;
  userId: string;
  plan: SubscriptionPlan;
  amountKwacha: number;
  amountUsd: number;
  paymentMethod: 'Airtel MoMo' | 'MTN MoMo';
  transactionId: string;
  recordedAt: string;
}

export interface StoredUser {
  id: string;
  fullName: string;
  phone: string;
  normalizedPhone: string;
  passwordHash: string;
  brokerName: string;
  brokerServer: string;
  mt5Login: string;
  brokerApiKeyEnc: string;
  brokerApiKeyLast4: string;
  brokerBridgeUrl: string;
  brokerConnected: boolean;
  brokerSetup?: BrokerAccountSetup;
  accountType: 'Demo' | 'Live';
  status: UserStatus;
  plan: SubscriptionPlan;
  amountKwacha: number;
  amountUsd: number;
  paymentMethod: 'Airtel MoMo' | 'MTN MoMo';
  transactionId: string;
  screenshotDataUrl: string | null;
  submittedAt: string;
  approvedAt: string | null;
  expiresAt: string | null;
  feedAccess: boolean;
  autoTradeEnabled: boolean;
  balance: number;
  equity: number;
  lastBalanceSyncAt?: string | null;
  balanceSyncSource?: 'TICKERALL_MT5' | 'BROKER_BRIDGE' | 'TRADE_PNL' | 'MANUAL' | null;
  settings: StrategySettings;
  levels: DaySessionLevels;
  tradeLog: TradeLogEntry[];
  signalHistory: SignalHistoryEntry[];
  tradeOrders?: TradeOrderRecord[];
  riskEvents?: RiskEventRecord[];
  auditLogs?: AuditLogRecord[];
  notifications?: Array<{
    id: string;
    timestamp: string;
    title: string;
    detail: string;
    level: 'INFO' | 'WARNING' | 'CRITICAL';
  }>;
  processedSignalIds: string[];
  processedHistoryIds: string[];
  processedAutoIds: string[];
  spreadRejectedCountToday?: number;
  acceptedAbove45CountToday?: number;
  lastAiApproval?: AiTradeApproval | null;
  firebaseUid?: string | null;
  firebaseEmail?: string | null;
  pinResetCodeHash?: string | null;
  pinResetExpiresAt?: string | null;
  lastAdminActionAt?: string | null;
  createdAt: string;
}

export interface BusinessStoreData {
  adminPasswordHash: string;
  adminPinCustom?: boolean;
  tickerAllMaster: {
    apiKeyEnc: string;
    apiKeyLast4: string;
    baseUrl: string;
    brokerServer: string;
    mt5AccountNumber: string;
    passwordEnc: string;
    quotaUsed: number;
    desiredConnected: boolean;
    configuredByAdmin?: boolean;
  };
  spreadPolicy?: AdminSpreadPolicy;
  momo: MoMoConfig;
  plans: PlanPricing;
  payments: PaymentRecord[];
  users: StoredUser[];
}

const DEFAULT_PLANS: PlanPricing = {
  weekly: { label: 'Weekly', kwacha: 150, usd: 5, days: 7 },
  monthly: { label: 'Monthly', kwacha: 500, usd: 20, days: 30 },
  quarterly: { label: 'Quarterly', kwacha: 1200, usd: 45, days: 90 },
};

const DEFAULT_MOMO: MoMoConfig = {
  airtelNumber: '+260 970 000 000',
  mtnNumber: '+260 960 000 000',
  recipientName: 'Gold AI Trader Admin',
  whatsappRenewNumber: '+260970000000',
};

function createInitialStore(): BusinessStoreData {
  const envKey = process.env.TICKERALL_API_KEY?.trim() || '';
  const envPass = process.env.MT5_PASSWORD?.trim() || '';
  const adminPass = process.env.ADMIN_PASSWORD?.trim() || 'GoldAdmin2026!';

  return {
    adminPasswordHash: hashPassword(adminPass),
    tickerAllMaster: {
      apiKeyEnc: envKey ? encryptSecret(envKey) : '',
      apiKeyLast4: envKey ? envKey.slice(-4) : '',
      baseUrl: process.env.TICKERALL_BASE_URL?.trim() || 'https://api.tickerall.com',
      brokerServer: process.env.MT5_SERVER?.trim() || '',
      mt5AccountNumber: process.env.MT5_ACCOUNT?.trim() || '',
      passwordEnc: envPass ? encryptSecret(envPass) : '',
      quotaUsed: 0,
      desiredConnected: false,
      configuredByAdmin: false,
    },
    spreadPolicy: { ...DEFAULT_ADMIN_SPREAD_POLICY },
    momo: { ...DEFAULT_MOMO },
    plans: structuredClone(DEFAULT_PLANS),
    payments: [],
    users: [],
  };
}

function writeStoreFileSafe(data: BusinessStoreData): void {
  if (!ensureDataDir()) return;
  try {
    const serialized = JSON.stringify(data, null, 2);
    fs.writeFileSync(TMP_STORE_PATH, serialized);
    fs.renameSync(TMP_STORE_PATH, STORE_PATH);
    fs.writeFileSync(BACKUP_STORE_PATH, serialized);
  } catch {
    try {
      const serialized = JSON.stringify(data, null, 2);
      fs.writeFileSync(STORE_PATH, serialized);
      fs.writeFileSync(BACKUP_STORE_PATH, serialized);
    } catch {
      // Ignore disk write failures on read-only filesystems
    }
  }
}

function tryReadStoreFile(filePath: string): Partial<BusinessStoreData> | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8').trim();
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<BusinessStoreData>;
    if (!parsed || typeof parsed !== 'object') return null;
    return parsed;
  } catch {
    return null;
  }
}

function loadStoreFromDisk(): BusinessStoreData {
  ensureDataDir();
  const primaryParsed = tryReadStoreFile(STORE_PATH);
  const backupParsed = primaryParsed ? null : tryReadStoreFile(BACKUP_STORE_PATH);
  const parsed = primaryParsed ?? backupParsed;
  const recoveredFromBackup = Boolean(!primaryParsed && backupParsed);

  if (!parsed) {
    const initial = createInitialStore();
    writeStoreFileSafe(initial);
    return initial;
  }
  try {
    const fallback = createInitialStore();
    const merged: BusinessStoreData = {
      adminPasswordHash: parsed.adminPasswordHash || fallback.adminPasswordHash,
      adminPinCustom: Boolean(parsed.adminPinCustom),
      tickerAllMaster: {
        ...fallback.tickerAllMaster,
        ...(parsed.tickerAllMaster || {}),
        desiredConnected: Boolean(parsed.tickerAllMaster?.desiredConnected),
      },
      spreadPolicy: {
        ...DEFAULT_ADMIN_SPREAD_POLICY,
        ...(parsed.spreadPolicy || {}),
      },
      momo: { ...fallback.momo, ...(parsed.momo || {}) },
      plans: {
        weekly: { ...fallback.plans.weekly, ...(parsed.plans?.weekly || {}) },
        monthly: { ...fallback.plans.monthly, ...(parsed.plans?.monthly || {}) },
        quarterly: { ...fallback.plans.quarterly, ...(parsed.plans?.quarterly || {}) },
      },
      payments: Array.isArray(parsed.payments) ? parsed.payments : [],
      users: Array.isArray(parsed.users) ? parsed.users : [],
    };
    const origUserCount = merged.users.length;
    const origPaymentCount = merged.payments.length;
    let dirty = recoveredFromBackup;
    merged.users = merged.users.filter(
      (u) => !['Test Trader A', 'Test Trader B', 'Verify User'].includes(u.fullName)
    );
    merged.payments = merged.payments.filter(
      (p) => !['MP260418.TESTA', 'MP260418.TESTB', 'TX-VERIFY-01'].includes(p.transactionId)
    );
    if (merged.users.length !== origUserCount || merged.payments.length !== origPaymentCount) {
      dirty = true;
    }
    if (merged.tickerAllMaster.apiKeyLast4 === '4321') {
      merged.tickerAllMaster.apiKeyEnc = '';
      merged.tickerAllMaster.apiKeyLast4 = '';
      merged.tickerAllMaster.quotaUsed = 0;
      dirty = true;
    }
    if (
      merged.momo.recipientName === 'Gold AI TRADER Admin' ||
      merged.momo.recipientName === 'Trend line Gold Bot Admin'
    ) {
      merged.momo.recipientName = 'Gold AI Trader Admin';
      dirty = true;
    }
    for (const u of merged.users) {
      const rawSettings = (u.settings || {}) as unknown as Record<string, unknown>;
      const legacySettingKeys = [
        'falconEnabled',
        'supertrendAtrPeriod',
        'supertrendMultiplier',
        'emaFastPeriod',
        'emaSlowPeriod',
        'rsiPeriod',
        'trendlineEnabled',
        'asiaStart',
        'asiaEnd',
        'nyStart',
        'nyEnd',
        'breakoutBuffer',
        'minAsiaRange',
        'maxAsiaRange',
        'londonRrRatio',
        'maxLondonTrades',
        'nyRetestTolerance',
        'nyRrRatio',
        'maxNyTrades',
      ];
      let hadLegacy = false;
      for (const staleKey of legacySettingKeys) {
        if (staleKey in rawSettings) {
          delete rawSettings[staleKey];
          hadLegacy = true;
          dirty = true;
        }
      }
      if (hadLegacy || !('asianStart' in rawSettings) || !('slPips' in rawSettings) || !('maxSlPips' in rawSettings)) {
        u.settings = {
          strategyMode: 'EMA_STOCHASTIC_PRO',
          asianStart: DEFAULT_STRATEGY_SETTINGS.asianStart,
          asianEnd: DEFAULT_STRATEGY_SETTINGS.asianEnd,
          londonStart: DEFAULT_STRATEGY_SETTINGS.londonStart,
          londonEnd: DEFAULT_STRATEGY_SETTINGS.londonEnd,
          slPips:
            typeof rawSettings.slPips === 'number' && rawSettings.slPips >= 5
              ? rawSettings.slPips
              : DEFAULT_STRATEGY_SETTINGS.slPips,
          maxSlPips:
            typeof rawSettings.maxSlPips === 'number' && rawSettings.maxSlPips >= 10
              ? rawSettings.maxSlPips
              : DEFAULT_STRATEGY_SETTINGS.maxSlPips,
          newsClearanceMins: DEFAULT_STRATEGY_SETTINGS.newsClearanceMins,
          maxTradesPerDay: DEFAULT_STRATEGY_SETTINGS.maxTradesPerDay,
          maxConsecutiveLosses: DEFAULT_STRATEGY_SETTINGS.maxConsecutiveLosses,
          riskPercent: DEFAULT_STRATEGY_SETTINGS.riskPercent,
          defaultLotSize:
            typeof rawSettings.defaultLotSize === 'number' && rawSettings.defaultLotSize >= 0.01
              ? rawSettings.defaultLotSize
              : DEFAULT_STRATEGY_SETTINGS.defaultLotSize,
          autoLogSignals:
            typeof rawSettings.autoLogSignals === 'boolean' ? rawSettings.autoLogSignals : true,
          aiApproverEnabled:
            typeof rawSettings.aiApproverEnabled === 'boolean' ? rawSettings.aiApproverEnabled : true,
          maxAutoLotCap:
            typeof rawSettings.maxAutoLotCap === 'number' && rawSettings.maxAutoLotCap >= 0.01
              ? Math.max(0.5, rawSettings.maxAutoLotCap)
              : DEFAULT_STRATEGY_SETTINGS.maxAutoLotCap,
          dailyGuardPct:
            typeof rawSettings.dailyGuardPct === 'number' && rawSettings.dailyGuardPct >= 0.5
              ? rawSettings.dailyGuardPct
              : DEFAULT_STRATEGY_SETTINGS.dailyGuardPct,
          emaPro: { ...DEFAULT_EMA_PRO_CONFIG },
          newsEvents:
            Array.isArray(u.settings?.newsEvents) && u.settings.newsEvents.length > 0
              ? u.settings.newsEvents
              : DEFAULT_STRATEGY_SETTINGS.newsEvents.map((ev) => ({ ...ev })),
        };
        dirty = true;
      } else {
        if (typeof rawSettings.aiApproverEnabled !== 'boolean') {
          u.settings.aiApproverEnabled = true;
          dirty = true;
        }
        if (u.settings.strategyMode !== 'EMA_STOCHASTIC_PRO') {
          u.settings.strategyMode = 'EMA_STOCHASTIC_PRO';
          // Upgrade untouched legacy defaults to balanced EMA STOCHASTIC PRO limits
          if (
            (u.settings.maxTradesPerDay === 5 || u.settings.maxTradesPerDay === 15) &&
            (u.settings.maxConsecutiveLosses === 2 || u.settings.maxConsecutiveLosses === 3)
          ) {
            u.settings.maxTradesPerDay = DEFAULT_STRATEGY_SETTINGS.maxTradesPerDay;
            u.settings.maxConsecutiveLosses = DEFAULT_STRATEGY_SETTINGS.maxConsecutiveLosses;
            u.settings.riskPercent = DEFAULT_STRATEGY_SETTINGS.riskPercent;
            u.settings.dailyGuardPct = DEFAULT_STRATEGY_SETTINGS.dailyGuardPct;
          }
          dirty = true;
        }
        if (!u.settings.emaPro) {
          u.settings.emaPro = mergeEmaProConfig(null);
          dirty = true;
        } else {
          u.settings.emaPro = mergeEmaProConfig(u.settings.emaPro);
        }
      }
      if (!Array.isArray(u.tradeOrders)) u.tradeOrders = [];
      if (!Array.isArray(u.riskEvents)) u.riskEvents = [];
      if (!Array.isArray(u.auditLogs)) u.auditLogs = [];
      if (!Array.isArray(u.notifications)) u.notifications = [];

      const legacyStatusField = ['c', 'r', 't', 'Status'].join('');
      if (Array.isArray(u.tradeLog)) {
        for (const tr of u.tradeLog) {
          const rawTr = tr as unknown as Record<string, unknown>;
          if ('falconStatus' in rawTr || 'falconUsed' in rawTr) {
            delete rawTr.falconStatus;
            delete rawTr.falconUsed;
            dirty = true;
          }
          if (legacyStatusField in rawTr || 'trendlineStatus' in rawTr) {
            if (!rawTr.setupStatus) {
              rawTr.setupStatus = String(rawTr[legacyStatusField] || rawTr.trendlineStatus || 'EMA_PRO');
            }
            delete rawTr[legacyStatusField];
            delete rawTr.trendlineStatus;
            dirty = true;
          }
          if (rawTr.strategyModule && rawTr.strategyModule !== 'EMA_STOCHASTIC_PRO') {
            rawTr.strategyModule = 'EMA_STOCHASTIC_PRO';
            dirty = true;
          }
          if (rawTr.session === 'LONDON_BREAKOUT' || rawTr.session === 'NY_RETEST') {
            rawTr.session = 'LONDON_SESSION';
            dirty = true;
          }
        }
      }
      if (Array.isArray(u.signalHistory)) {
        for (const sig of u.signalHistory) {
          const rawSig = sig as unknown as Record<string, unknown>;
          if ('falcon' in rawSig) {
            delete rawSig.falcon;
            dirty = true;
          }
          if (legacyStatusField in rawSig || 'trendline' in rawSig) {
            if (!rawSig.setupStatus) {
              rawSig.setupStatus = String(rawSig[legacyStatusField] || rawSig.trendline || 'EMA_PRO');
            }
            delete rawSig[legacyStatusField];
            delete rawSig.trendline;
            dirty = true;
          }
          if (rawSig.strategyModule && rawSig.strategyModule !== 'EMA_STOCHASTIC_PRO') {
            rawSig.strategyModule = 'EMA_STOCHASTIC_PRO';
            dirty = true;
          }
          if (rawSig.strategy === 'LONDON_BREAKOUT' || rawSig.strategy === 'NY_RETEST') {
            rawSig.strategy = 'LONDON_SESSION';
            dirty = true;
          }
        }
      }

      const rawLevels = (u.levels || {}) as unknown as Record<string, unknown>;
      if (
        !u.levels ||
        'asiaHigh' in rawLevels ||
        !('consecutiveLossesToday' in rawLevels) ||
        !('pdh' in rawLevels)
      ) {
        const fresh = createFreshDayLevels(
          typeof rawLevels.dateLusaka === 'string'
            ? rawLevels.dateLusaka
            : getLusakaClock().dateLusaka
        );
        fresh.londonHigh = typeof rawLevels.londonHigh === 'number' ? rawLevels.londonHigh : null;
        fresh.londonLow = typeof rawLevels.londonLow === 'number' ? rawLevels.londonLow : null;
        fresh.asianHigh = typeof rawLevels.asiaHigh === 'number' ? rawLevels.asiaHigh : null;
        fresh.asianLow = typeof rawLevels.asiaLow === 'number' ? rawLevels.asiaLow : null;
        u.levels = fresh;
        recomputeUserTradeCountsForToday(u, fresh.dateLusaka);
        dirty = true;
      }

      if (!u.brokerSetup) {
        u.brokerSetup = createEmptyBrokerSetup(u.brokerName);
        if (u.autoTradeEnabled) {
          u.autoTradeEnabled = false;
        }
        dirty = true;
      }
    }
    // Sync admin password hash with configured ADMIN_PASSWORD or default unless custom PIN was set
    const expectedAdminPass = process.env.ADMIN_PASSWORD?.trim() || 'GoldAdmin2026!';
    if (!merged.adminPinCustom && !verifyPassword(expectedAdminPass, merged.adminPasswordHash)) {
      merged.adminPasswordHash = hashPassword(expectedAdminPass);
      dirty = true;
    }
    // Sync env TickerAll key if admin hasn't saved one via UI yet
    const envKey = process.env.TICKERALL_API_KEY?.trim() || '';
    if (!merged.tickerAllMaster.apiKeyEnc && envKey) {
      merged.tickerAllMaster.apiKeyEnc = encryptSecret(envKey);
      merged.tickerAllMaster.apiKeyLast4 = envKey.slice(-4);
      dirty = true;
    }
    if (dirty) {
      writeStoreFileSafe(merged);
    }
    return merged;
  } catch {
    const initial = createInitialStore();
    writeStoreFileSafe(initial);
    return initial;
  }
}

let storeData: BusinessStoreData = loadStoreFromDisk();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

export function saveStoreNow() {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  writeStoreFileSafe(storeData);
}

export function scheduleStoreSave() {
  if (saveTimer) return;
  saveTimer = setTimeout(() => {
    saveTimer = null;
    writeStoreFileSafe(storeData);
  }, 400);
}

export function getStore(): BusinessStoreData {
  return storeData;
}

export function getAdminSpreadPolicy(): AdminSpreadPolicy {
  return {
    ...DEFAULT_ADMIN_SPREAD_POLICY,
    ...(storeData.spreadPolicy || {}),
  };
}

export function updateAdminSpreadPolicy(
  patch: Partial<AdminSpreadPolicy> & { sensitivity?: AdminSpreadPolicy['spreadSensitivity'] }
): AdminSpreadPolicy {
  const current = getAdminSpreadPolicy();
  const rawSens = patch.spreadSensitivity ?? patch.sensitivity;
  const nextSens =
    rawSens === 'CONSERVATIVE' ||
    rawSens === 'BALANCED' ||
    rawSens === 'AGGRESSIVE'
      ? rawSens
      : current.spreadSensitivity;
  const next: AdminSpreadPolicy = {
    maxSpreadPoints:
      typeof patch.maxSpreadPoints === 'number' && Number.isFinite(patch.maxSpreadPoints)
        ? Math.max(20, Math.min(300, Math.round(patch.maxSpreadPoints)))
        : current.maxSpreadPoints,
    spreadSensitivity: nextSens,
    allowHighSpreadTrades:
      typeof patch.allowHighSpreadTrades === 'boolean'
        ? patch.allowHighSpreadTrades
        : current.allowHighSpreadTrades,
    minNetRewardRisk:
      typeof patch.minNetRewardRisk === 'number' && Number.isFinite(patch.minNetRewardRisk)
        ? Math.max(1.0, Math.min(4.0, Math.round(patch.minNetRewardRisk * 100) / 100))
        : current.minNetRewardRisk,
    commissionPerLot:
      typeof patch.commissionPerLot === 'number' && Number.isFinite(patch.commissionPerLot)
        ? Math.max(0, Math.min(50, Math.round(patch.commissionPerLot * 100) / 100))
        : current.commissionPerLot,
    estimatedSlippagePoints:
      typeof patch.estimatedSlippagePoints === 'number' &&
      Number.isFinite(patch.estimatedSlippagePoints)
        ? Math.max(0, Math.min(50, Math.round(patch.estimatedSlippagePoints)))
        : current.estimatedSlippagePoints,
    maxQuoteAgeSeconds:
      typeof patch.maxQuoteAgeSeconds === 'number' && Number.isFinite(patch.maxQuoteAgeSeconds)
        ? Math.max(3, Math.min(180, Math.round(patch.maxQuoteAgeSeconds)))
        : current.maxQuoteAgeSeconds,
    defaultSymbol:
      typeof patch.defaultSymbol === 'string' && patch.defaultSymbol.trim()
        ? patch.defaultSymbol.trim()
        : current.defaultSymbol,
    defaultDigits:
      patch.defaultDigits === 3 ? 3 : patch.defaultDigits === 2 ? 2 : current.defaultDigits,
    defaultPointSize:
      typeof patch.defaultPointSize === 'number' && patch.defaultPointSize > 0
        ? patch.defaultPointSize
        : patch.defaultDigits === 3
          ? 0.001
          : patch.defaultDigits === 2
            ? 0.01
            : current.defaultPointSize,
  };
  storeData.spreadPolicy = next;
  saveStoreNow();
  return next;
}

export function getAdminTickerAllKey(): string {
  if (storeData.tickerAllMaster.apiKeyEnc) {
    const dec = decryptSecret(storeData.tickerAllMaster.apiKeyEnc);
    if (dec) return dec;
  }
  return process.env.TICKERALL_API_KEY?.trim() || '';
}

export function getAdminMasterPassword(): string {
  if (storeData.tickerAllMaster.passwordEnc) {
    const dec = decryptSecret(storeData.tickerAllMaster.passwordEnc);
    if (dec) return dec;
  }
  return process.env.MT5_PASSWORD?.trim() || '';
}

export function incrementTickerAllQuota(amount = 1) {
  storeData.tickerAllMaster.quotaUsed = (storeData.tickerAllMaster.quotaUsed || 0) + amount;
  scheduleStoreSave();
}

export function isUsingDefaultPublicConfig(): boolean {
  return (
    storeData.momo.airtelNumber === DEFAULT_MOMO.airtelNumber &&
    storeData.momo.mtnNumber === DEFAULT_MOMO.mtnNumber &&
    storeData.momo.recipientName === DEFAULT_MOMO.recipientName &&
    storeData.momo.whatsappRenewNumber === DEFAULT_MOMO.whatsappRenewNumber
  );
}

export function applyPublicConfigHydration(
  momo?: Partial<MoMoConfig> | null,
  plans?: Partial<PlanPricing> | null,
  onlyIfDefault = false
): boolean {
  let updated = false;
  if (onlyIfDefault && !isUsingDefaultPublicConfig()) {
    return false;
  }
  if (momo && typeof momo === 'object') {
    if (typeof momo.airtelNumber === 'string' && momo.airtelNumber.trim()) {
      storeData.momo.airtelNumber = momo.airtelNumber.trim();
      updated = true;
    }
    if (typeof momo.mtnNumber === 'string' && momo.mtnNumber.trim()) {
      storeData.momo.mtnNumber = momo.mtnNumber.trim();
      updated = true;
    }
    if (typeof momo.recipientName === 'string' && momo.recipientName.trim()) {
      storeData.momo.recipientName = momo.recipientName.trim();
      updated = true;
    }
    if (typeof momo.whatsappRenewNumber === 'string' && momo.whatsappRenewNumber.trim()) {
      storeData.momo.whatsappRenewNumber = momo.whatsappRenewNumber.trim();
      updated = true;
    }
  }
  if (plans && typeof plans === 'object') {
    if (plans.weekly) {
      storeData.plans.weekly = { ...storeData.plans.weekly, ...plans.weekly };
      updated = true;
    }
    if (plans.monthly) {
      storeData.plans.monthly = { ...storeData.plans.monthly, ...plans.monthly };
      updated = true;
    }
    if (plans.quarterly) {
      storeData.plans.quarterly = { ...storeData.plans.quarterly, ...plans.quarterly };
      updated = true;
    }
  }
  if (updated) saveStoreNow();
  return updated;
}

export function toMasterConfigSyncBundle(): MasterConfigSyncBundle {
  const plainKey = getAdminTickerAllKey();
  const plainPass = getAdminMasterPassword();
  return {
    baseUrl: storeData.tickerAllMaster.baseUrl || 'https://api.tickerall.com',
    brokerServer: storeData.tickerAllMaster.brokerServer || '',
    mt5AccountNumber: storeData.tickerAllMaster.mt5AccountNumber || '',
    apiKeyLast4:
      storeData.tickerAllMaster.apiKeyLast4 || (plainKey ? plainKey.slice(-4) : ''),
    hasMasterKey: Boolean(plainKey),
    hasMasterPassword: Boolean(plainPass),
    apiKeyEnc: plainKey ? encryptCloudMasterSecret(plainKey) : '',
    passwordEnc: plainPass ? encryptCloudMasterSecret(plainPass) : '',
    quotaUsed: storeData.tickerAllMaster.quotaUsed || 0,
    desiredConnected: Boolean(storeData.tickerAllMaster.desiredConnected),
  };
}

export function applyMasterConfigSyncBundle(
  bundle: Partial<MasterConfigSyncBundle> | null | undefined
): boolean {
  if (!bundle || typeof bundle !== 'object') return false;
  const isUnconfiguredColdStart =
    !storeData.tickerAllMaster.configuredByAdmin &&
    !storeData.tickerAllMaster.brokerServer.trim() &&
    !storeData.tickerAllMaster.mt5AccountNumber.trim();
  const hadLocalKey = Boolean(getAdminTickerAllKey());
  const hadLocalServer = Boolean(
    storeData.tickerAllMaster.brokerServer.trim() &&
      storeData.tickerAllMaster.mt5AccountNumber.trim()
  );
  let changed = false;

  if (
    typeof bundle.baseUrl === 'string' &&
    bundle.baseUrl.trim() &&
    (isUnconfiguredColdStart ||
      !storeData.tickerAllMaster.baseUrl ||
      storeData.tickerAllMaster.baseUrl === 'https://api.tickerall.com')
  ) {
    storeData.tickerAllMaster.baseUrl = bundle.baseUrl.trim();
    changed = true;
  }
  if (
    typeof bundle.brokerServer === 'string' &&
    bundle.brokerServer.trim() &&
    (isUnconfiguredColdStart || !storeData.tickerAllMaster.brokerServer.trim())
  ) {
    storeData.tickerAllMaster.brokerServer = bundle.brokerServer.trim();
    changed = true;
  }
  if (
    typeof bundle.mt5AccountNumber === 'string' &&
    bundle.mt5AccountNumber.trim() &&
    (isUnconfiguredColdStart || !storeData.tickerAllMaster.mt5AccountNumber.trim())
  ) {
    storeData.tickerAllMaster.mt5AccountNumber = bundle.mt5AccountNumber.trim();
    changed = true;
  }
  if (
    (isUnconfiguredColdStart || !hadLocalKey) &&
    typeof bundle.apiKeyEnc === 'string' &&
    bundle.apiKeyEnc.trim()
  ) {
    const plainKey = decryptCloudMasterSecret(bundle.apiKeyEnc.trim());
    if (plainKey) {
      storeData.tickerAllMaster.apiKeyEnc = encryptSecret(plainKey);
      storeData.tickerAllMaster.apiKeyLast4 =
        (typeof bundle.apiKeyLast4 === 'string' && bundle.apiKeyLast4.trim()) ||
        plainKey.slice(-4);
      changed = true;
    }
  }
  if (
    (isUnconfiguredColdStart || !getAdminMasterPassword()) &&
    typeof bundle.passwordEnc === 'string' &&
    bundle.passwordEnc.trim()
  ) {
    const plainPass = decryptCloudMasterSecret(bundle.passwordEnc.trim());
    if (plainPass) {
      storeData.tickerAllMaster.passwordEnc = encryptSecret(plainPass);
      changed = true;
    }
  }
  if (typeof bundle.quotaUsed === 'number' && Number.isFinite(bundle.quotaUsed)) {
    const nextQuota = Math.max(storeData.tickerAllMaster.quotaUsed || 0, bundle.quotaUsed);
    if (nextQuota !== storeData.tickerAllMaster.quotaUsed) {
      storeData.tickerAllMaster.quotaUsed = nextQuota;
      changed = true;
    }
  }
  if (
    (isUnconfiguredColdStart || (!hadLocalKey && !hadLocalServer)) &&
    typeof bundle.desiredConnected === 'boolean'
  ) {
    storeData.tickerAllMaster.desiredConnected = bundle.desiredConnected;
    changed = true;
  }
  if (changed) {
    storeData.tickerAllMaster.configuredByAdmin = true;
    saveStoreNow();
  }
  return changed;
}

export function computeDaysLeft(expiresAt: string | null): number {
  if (!expiresAt) return 0;
  const expMs = Date.parse(expiresAt);
  if (!Number.isFinite(expMs)) return 0;
  const diff = expMs - Date.now();
  if (diff <= 0) return 0;
  return Math.ceil(diff / (24 * 60 * 60 * 1000));
}

export function refreshAllUserExpiries() {
  const now = Date.now();
  let changed = false;
  for (const u of storeData.users) {
    if (u.status === 'ACTIVE' && u.expiresAt) {
      const expMs = Date.parse(u.expiresAt);
      if (Number.isFinite(expMs) && expMs <= now) {
        u.status = 'EXPIRED';
        u.feedAccess = false;
        u.autoTradeEnabled = false;
        changed = true;
      }
    }
  }
  if (changed) scheduleStoreSave();
}

export function ensureUserDayRollover(user: StoredUser, nowMs = Date.now()) {
  const clock = getLusakaClock(nowMs);
  if (!user.levels || user.levels.dateLusaka !== clock.dateLusaka) {
    user.levels = createFreshDayLevels(clock.dateLusaka);
    user.processedSignalIds = [];
    user.processedHistoryIds = [];
    user.processedAutoIds = [];
    user.spreadRejectedCountToday = 0;
    user.acceptedAbove45CountToday = 0;
    scheduleStoreSave();
  }
}

export function recomputeUserTradeCountsForToday(user: StoredUser, dateLusaka: string) {
  const todaysTrades = user.tradeLog.filter((t) => t.dateLusaka === dateLusaka);
  user.levels.asianTradesToday = todaysTrades.filter(
    (t) => t.session === 'ASIAN_SESSION'
  ).length;
  user.levels.londonTradesToday = todaysTrades.filter(
    (t) => t.session === 'LONDON_SESSION'
  ).length;
  user.levels.totalTradesToday = todaysTrades.length;

  const closedChrono = todaysTrades
    .filter((t) => t.status === 'SL_HIT' || t.status === 'TP_HIT' || t.status === 'CLOSED')
    .sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  let lossStreak = 0;
  for (const tr of closedChrono) {
    if (tr.status === 'SL_HIT' || (tr.pnlDollars ?? 0) < 0) {
      lossStreak += 1;
    } else if (tr.status === 'TP_HIT' || (tr.pnlDollars ?? 0) >= 0) {
      lossStreak = 0;
    }
  }
  user.levels.consecutiveLossesToday = lossStreak;
}

export function computeUserDailyPnl(user: StoredUser, dateLusaka: string): {
  dailyPnlDollars: number;
  dailyPnlPct: number;
  dailyGuardHit: boolean;
} {
  const todaysClosed = user.tradeLog.filter(
    (t) =>
      t.dateLusaka === dateLusaka &&
      (t.status === 'TP_HIT' || t.status === 'SL_HIT' || t.status === 'CLOSED') &&
      typeof t.pnlDollars === 'number'
  );
  const dailyPnlDollars = round2(
    todaysClosed.reduce((acc, t) => acc + (t.pnlDollars ?? 0), 0)
  );
  const startOfDayBalance = Math.max(1, round2(user.balance - dailyPnlDollars));
  const dailyPnlPct = round2((dailyPnlDollars / startOfDayBalance) * 100);
  const guardPct = Math.abs(user.settings.dailyGuardPct || 5.0);
  const dailyGuardHit = dailyPnlPct <= -guardPct;
  return { dailyPnlDollars, dailyPnlPct, dailyGuardHit };
}

export function createEmptyBrokerSetup(brokerName = ''): BrokerAccountSetup {
  const lower = brokerName.toLowerCase();
  const preset: 'XM' | 'Exness' | 'Weltrade' | 'Other' = lower.includes('weltrade')
    ? 'Weltrade'
    : lower.includes('exness')
      ? 'Exness'
      : lower.includes('xm')
        ? 'XM'
        : 'Other';
  const inferredVariant =
    lower.includes('cent') || lower.includes('micro')
      ? lower.includes('weltrade') || lower.includes('exness') || lower.includes('usc')
        ? 'CENT_USC'
        : 'CENT_USD'
      : lower.includes('raw') || lower.includes('ecn') || lower.includes('zero') || lower.includes('pro')
        ? 'ECN_RAW'
        : 'STANDARD';
  return {
    platformMt5: false,
    accountStandard: false,
    currencyUsd: false,
    leverageValid: false,
    hasWrongMt4OrCtrader: false,
    hasWrongCentOrEcn: false,
    hasWrongZmwOrEur: false,
    selectedBrokerPreset: preset,
    accountVariant: inferredVariant,
    confirmedAt: null,
  };
}

export function normalizeBrokerSetup(
  raw: Partial<BrokerAccountSetup> | undefined,
  brokerName = ''
): BrokerAccountSetup {
  const base = createEmptyBrokerSetup(brokerName);
  const accountVariant =
    raw?.accountVariant === 'STANDARD' ||
    raw?.accountVariant === 'CENT_USD' ||
    raw?.accountVariant === 'CENT_USC' ||
    raw?.accountVariant === 'ECN_RAW'
      ? raw.accountVariant
      : base.accountVariant ?? 'STANDARD';
  const setup: BrokerAccountSetup = {
    platformMt5: Boolean(raw?.platformMt5),
    accountStandard: Boolean(raw?.accountStandard),
    currencyUsd: Boolean(raw?.currencyUsd),
    leverageValid: Boolean(raw?.leverageValid),
    hasWrongMt4OrCtrader: Boolean(raw?.hasWrongMt4OrCtrader),
    // Cent, Micro, and ECN/Raw MT5 accounts are now supported across brokers
    hasWrongCentOrEcn: false,
    hasWrongZmwOrEur: Boolean(raw?.hasWrongZmwOrEur),
    selectedBrokerPreset:
      raw?.selectedBrokerPreset === 'Exness' ||
      raw?.selectedBrokerPreset === 'Weltrade' ||
      raw?.selectedBrokerPreset === 'XM' ||
      raw?.selectedBrokerPreset === 'Other'
        ? raw.selectedBrokerPreset
        : base.selectedBrokerPreset,
    accountVariant,
    confirmedAt: raw?.confirmedAt ?? null,
  };
  const complete = isBrokerSetupComplete(setup);
  if (complete && !setup.confirmedAt) {
    setup.confirmedAt = new Date().toISOString();
  } else if (!complete) {
    setup.confirmedAt = null;
  }
  return setup;
}

export function hasWrongBrokerSetup(setup: BrokerAccountSetup | undefined): boolean {
  if (!setup) return false;
  return Boolean(setup.hasWrongMt4OrCtrader || setup.hasWrongZmwOrEur);
}

export function isBrokerSetupComplete(setup: BrokerAccountSetup | undefined): boolean {
  if (!setup) return false;
  if (hasWrongBrokerSetup(setup)) return false;
  return Boolean(
    setup.platformMt5 &&
      setup.accountStandard &&
      setup.currencyUsd &&
      setup.leverageValid
  );
}

export function toPublicUser(user: StoredUser): UserPublicProfile {
  refreshAllUserExpiries();
  const planSpec = storeData.plans[user.plan] || DEFAULT_PLANS.weekly;
  const normalizedSetup = normalizeBrokerSetup(user.brokerSetup, user.brokerName);
  const brokerSetupWrongAccount = hasWrongBrokerSetup(normalizedSetup);
  const brokerSetupComplete = isBrokerSetupComplete(normalizedSetup);
  const brokerConnected = Boolean(
    user.brokerConnected && user.mt5Login.trim() && user.brokerName.trim()
  );
  return {
    id: user.id,
    fullName: user.fullName,
    phone: user.phone,
    brokerName: user.brokerName,
    brokerServer: user.brokerServer,
    mt5Login: user.mt5Login,
    brokerApiKeyLast4: user.brokerApiKeyLast4 || '',
    hasBrokerApiKey: Boolean(user.brokerApiKeyEnc),
    brokerBridgeUrl: user.brokerBridgeUrl || '',
    brokerConnected,
    brokerSetup: normalizedSetup,
    brokerSetupComplete,
    brokerSetupWrongAccount,
    accountType: user.accountType,
    status: user.status,
    plan: user.plan,
    planLabel: planSpec.label,
    amountLabel: `K${user.amountKwacha} / $${user.amountUsd}`,
    paymentMethod: user.paymentMethod,
    transactionId: user.transactionId,
    hasScreenshot: Boolean(user.screenshotDataUrl),
    submittedAt: user.submittedAt,
    approvedAt: user.approvedAt,
    expiresAt: user.expiresAt,
    daysLeft: computeDaysLeft(user.expiresAt),
    feedAccess: user.status === 'ACTIVE' && Boolean(user.feedAccess),
    autoTradeEnabled: Boolean(
      user.autoTradeEnabled &&
        brokerConnected &&
        brokerSetupComplete &&
        !brokerSetupWrongAccount &&
        user.status === 'ACTIVE'
    ),
    balance: round2(user.balance),
    equity: round2(user.equity),
    lastBalanceSyncAt: user.lastBalanceSyncAt ?? null,
    balanceSyncSource: user.balanceSyncSource ?? null,
    firebaseLinked: Boolean(user.firebaseUid),
    firebaseEmail: user.firebaseEmail ?? null,
    createdAt: user.createdAt,
  };
}

export function toAdminUserRow(user: StoredUser): AdminUserRow {
  const base = toPublicUser(user);
  return {
    ...base,
    screenshotDataUrl: user.screenshotDataUrl || null,
    totalTrades: user.tradeLog.length,
    openTradesCount: user.tradeLog.filter((t) => t.status === 'OPEN').length,
  };
}

export function findUserById(userId: string): StoredUser | null {
  refreshAllUserExpiries();
  return storeData.users.find((u) => u.id === userId) || null;
}

export function findUserByFirebaseUid(firebaseUid: string): StoredUser | null {
  refreshAllUserExpiries();
  if (!firebaseUid) return null;
  return storeData.users.find((u) => u.firebaseUid === firebaseUid) || null;
}

export function findUserByPhone(phone: string): StoredUser | null {
  refreshAllUserExpiries();
  const norm = normalizePhone(phone);
  if (!norm) return null;
  return storeData.users.find((u) => u.normalizedPhone === norm) || null;
}

export function toUserSyncBundle(user: StoredUser, ownerIdOverride?: string): UserSyncBundle {
  return {
    ownerId: ownerIdOverride || user.firebaseUid || user.id,
    appUserId: user.id,
    fullName: user.fullName,
    phone: user.phone,
    normalizedPhone: user.normalizedPhone,
    email: user.firebaseEmail || '',
    passwordHash: user.passwordHash,
    brokerName: user.brokerName,
    brokerServer: user.brokerServer,
    mt5Login: user.mt5Login,
    brokerApiKeyLast4: user.brokerApiKeyLast4 || '',
    hasBrokerApiKey: Boolean(user.brokerApiKeyEnc),
    brokerBridgeUrl: user.brokerBridgeUrl || '',
    brokerConnected: Boolean(user.brokerConnected),
    brokerSetup: normalizeBrokerSetup(user.brokerSetup, user.brokerName),
    accountType: user.accountType,
    status: user.status,
    plan: user.plan,
    amountKwacha: user.amountKwacha,
    amountUsd: user.amountUsd,
    paymentMethod: user.paymentMethod,
    transactionId: user.transactionId,
    hasScreenshot: Boolean(user.screenshotDataUrl),
    submittedAt: user.submittedAt,
    approvedAt: user.approvedAt,
    expiresAt: user.expiresAt,
    feedAccess: Boolean(user.feedAccess),
    autoTradeEnabled: Boolean(user.autoTradeEnabled),
    balance: round2(user.balance),
    equity: round2(user.equity),
    lastBalanceSyncAt: user.lastBalanceSyncAt ?? null,
    balanceSyncSource: user.balanceSyncSource ?? null,
    settings: user.settings,
    levels: user.levels,
    trades: user.tradeLog.slice(0, 50),
    createdAt: user.createdAt,
  };
}

export function upsertUserFromSyncBundle(
  bundle: UserSyncBundle,
  opts?: { trustedStatus?: boolean; verifiedFirebaseUid?: string; verifiedEmail?: string }
): StoredUser {
  const clock = getLusakaClock();
  const normPhone = normalizePhone(bundle.normalizedPhone || bundle.phone);
  const existing =
    (opts?.verifiedFirebaseUid ? findUserByFirebaseUid(opts.verifiedFirebaseUid) : null) ||
    (bundle.ownerId ? findUserByFirebaseUid(bundle.ownerId) : null) ||
    findUserById(bundle.appUserId) ||
    (normPhone ? findUserByPhone(normPhone) : null);

  if (existing) {
    if (opts?.verifiedFirebaseUid) existing.firebaseUid = opts.verifiedFirebaseUid;
    if (opts?.verifiedEmail) existing.firebaseEmail = opts.verifiedEmail;
    if (!existing.passwordHash && bundle.passwordHash) {
      existing.passwordHash = bundle.passwordHash;
    }
    const adminActionMs = existing.lastAdminActionAt
      ? Date.parse(existing.lastAdminActionAt)
      : NaN;
    const incomingUpdatedMs = bundle.firestoreUpdatedAt
      ? Date.parse(bundle.firestoreUpdatedAt)
      : NaN;
    const hasRecentLocalAdminAction =
      Number.isFinite(adminActionMs) &&
      (!Number.isFinite(incomingUpdatedMs) || incomingUpdatedMs <= adminActionMs + 2000);

    if (opts?.trustedStatus && !hasRecentLocalAdminAction) {
      // Only update status/privilege fields from authoritative Firestore when verified
      // and not overridden by a newer explicit Admin action on this server.
      if (
        bundle.status === 'ACTIVE' &&
        (existing.status === 'PENDING' || existing.status === 'EXPIRED')
      ) {
        existing.status = bundle.status;
        existing.feedAccess = Boolean(bundle.feedAccess);
        existing.approvedAt = bundle.approvedAt;
        existing.expiresAt = bundle.expiresAt;
      } else if (
        bundle.status === 'ACTIVE' &&
        existing.status === 'ACTIVE' &&
        bundle.expiresAt &&
        (!existing.expiresAt || Date.parse(bundle.expiresAt) > Date.parse(existing.expiresAt))
      ) {
        existing.expiresAt = bundle.expiresAt;
      } else if (bundle.status === 'BLOCKED') {
        existing.status = 'BLOCKED';
        existing.feedAccess = false;
        existing.autoTradeEnabled = false;
      }
      if (!existing.brokerApiKeyLast4 && bundle.brokerApiKeyLast4) {
        existing.brokerApiKeyLast4 = bundle.brokerApiKeyLast4;
      }
      if (!existing.brokerConnected && bundle.brokerConnected && bundle.mt5Login) {
        existing.brokerName = bundle.brokerName || existing.brokerName;
        existing.brokerServer = bundle.brokerServer || existing.brokerServer;
        existing.mt5Login = bundle.mt5Login;
        existing.brokerBridgeUrl = bundle.brokerBridgeUrl || existing.brokerBridgeUrl;
        existing.brokerConnected = true;
        if (bundle.brokerSetup) {
          existing.brokerSetup = normalizeBrokerSetup(bundle.brokerSetup, existing.brokerName);
        }
        if (existing.status === 'ACTIVE' && bundle.autoTradeEnabled) {
          existing.autoTradeEnabled = true;
        }
      }
    }
    const legacyTradeStatusKey = ['c', 'r', 't', 'Status'].join('');
    if (Array.isArray(bundle.trades) && bundle.trades.length > existing.tradeLog.length) {
      const seenIds = new Set(existing.tradeLog.map((t) => t.id));
      for (const tr of bundle.trades) {
        if (tr?.id && !seenIds.has(tr.id)) {
          const rawTr = { ...tr } as unknown as Record<string, unknown>;
          if (legacyTradeStatusKey in rawTr) {
            if (!rawTr.setupStatus) rawTr.setupStatus = rawTr[legacyTradeStatusKey];
            delete rawTr[legacyTradeStatusKey];
          }
          rawTr.strategyModule = 'EMA_STOCHASTIC_PRO';
          existing.tradeLog.push(rawTr as unknown as TradeLogEntry);
        }
      }
      existing.tradeLog.sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp));
    }
    saveStoreNow();
    return existing;
  }

  const normalizedStatus: UserStatus =
    opts?.trustedStatus &&
    (bundle.status === 'ACTIVE' ||
      bundle.status === 'EXPIRED' ||
      bundle.status === 'BLOCKED' ||
      bundle.status === 'PENDING')
      ? bundle.status
      : 'PENDING';

  const legacyTradeStatusKey = ['c', 'r', 't', 'Status'].join('');
  const normalizedBundleTrades = Array.isArray(bundle.trades)
    ? bundle.trades.map((tr) => {
        const rawTr = { ...tr } as unknown as Record<string, unknown>;
        if (legacyTradeStatusKey in rawTr) {
          if (!rawTr.setupStatus) rawTr.setupStatus = rawTr[legacyTradeStatusKey];
          delete rawTr[legacyTradeStatusKey];
        }
        rawTr.strategyModule = 'EMA_STOCHASTIC_PRO';
        return rawTr as unknown as TradeLogEntry;
      })
    : [];

  const restored: StoredUser = {
    id: bundle.appUserId || `usr-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
    fullName: bundle.fullName || 'Trader',
    phone: bundle.phone || '',
    normalizedPhone: normPhone || bundle.phone || '',
    passwordHash: bundle.passwordHash || hashPassword(crypto.randomBytes(16).toString('hex')),
    brokerName: bundle.brokerName || 'XM',
    brokerServer: bundle.brokerServer || '',
    mt5Login: bundle.mt5Login || '',
    brokerApiKeyEnc: '',
    brokerApiKeyLast4: bundle.brokerApiKeyLast4 || '',
    brokerBridgeUrl: bundle.brokerBridgeUrl || '',
    brokerConnected: Boolean(bundle.brokerConnected && bundle.mt5Login),
    brokerSetup: normalizeBrokerSetup(bundle.brokerSetup, bundle.brokerName),
    accountType: bundle.accountType === 'Live' ? 'Live' : 'Demo',
    status: normalizedStatus,
    plan:
      bundle.plan === 'monthly' || bundle.plan === 'quarterly' ? bundle.plan : 'weekly',
    amountKwacha: Number(bundle.amountKwacha) || 150,
    amountUsd: Number(bundle.amountUsd) || 5,
    paymentMethod: bundle.paymentMethod === 'MTN MoMo' ? 'MTN MoMo' : 'Airtel MoMo',
    transactionId: bundle.transactionId || '',
    screenshotDataUrl: null,
    submittedAt: bundle.submittedAt || new Date().toISOString(),
    approvedAt: normalizedStatus === 'PENDING' ? null : bundle.approvedAt ?? null,
    expiresAt: normalizedStatus === 'PENDING' ? null : bundle.expiresAt ?? null,
    feedAccess: normalizedStatus === 'ACTIVE' ? Boolean(bundle.feedAccess) : false,
    autoTradeEnabled: normalizedStatus === 'ACTIVE' ? Boolean(bundle.autoTradeEnabled) : false,
    balance: round2(Number(bundle.balance) || 138.76),
    equity: round2(Number(bundle.equity) || Number(bundle.balance) || 138.76),
    lastBalanceSyncAt: bundle.lastBalanceSyncAt ?? null,
    balanceSyncSource: bundle.balanceSyncSource ?? null,
    settings: bundle.settings
      ? {
          ...buildDefaultUserSettings(),
          ...bundle.settings,
          strategyMode: 'EMA_STOCHASTIC_PRO',
          emaPro: mergeEmaProConfig(bundle.settings.emaPro),
        }
      : buildDefaultUserSettings(),
    levels: bundle.levels || createFreshDayLevels(clock.dateLusaka),
    tradeLog: normalizedBundleTrades,
    signalHistory: [],
    tradeOrders: [],
    riskEvents: [],
    auditLogs: [],
    notifications: [],
    processedSignalIds: [],
    processedHistoryIds: [],
    processedAutoIds: [],
    lastAiApproval: null,
    firebaseUid: opts?.verifiedFirebaseUid || bundle.ownerId || null,
    firebaseEmail: opts?.verifiedEmail || bundle.email || null,
    createdAt: bundle.createdAt || new Date().toISOString(),
  };

  storeData.users.unshift(restored);
  saveStoreNow();
  return restored;
}

export function getUserSessionMeta(req: Request): {
  user: StoredUser | null;
  impersonatedByAdmin: boolean;
} {
  const cookies = parseCookies(req);
  const payload = verifyToken<{
    role?: string;
    uid?: string;
    impersonatedByAdmin?: boolean;
  }>(cookies[USER_COOKIE_NAME]);
  if (!payload || payload.role !== 'user' || !payload.uid) {
    return { user: null, impersonatedByAdmin: false };
  }
  return {
    user: findUserById(payload.uid),
    impersonatedByAdmin: Boolean(payload.impersonatedByAdmin),
  };
}

export function getAuthenticatedUser(req: Request): StoredUser | null {
  return getUserSessionMeta(req).user;
}

export function isAdminAuthenticated(req: Request): boolean {
  const cookies = parseCookies(req);
  const payload = verifyToken<{ role?: string }>(cookies[ADMIN_COOKIE_NAME]);
  return Boolean(payload && payload.role === 'admin');
}

export function issueUserSessionCookie(
  req: Request,
  res: Response,
  userId: string,
  impersonatedByAdmin = false
) {
  setAuthCookie(req, res, USER_COOKIE_NAME, {
    role: 'user',
    uid: userId,
    ...(impersonatedByAdmin ? { impersonatedByAdmin: true } : {}),
  });
}

export function issueAdminSessionCookie(req: Request, res: Response) {
  setAuthCookie(req, res, ADMIN_COOKIE_NAME, { role: 'admin' });
}

export function createOrAuthorizeTestAccount(): StoredUser {
  const clock = getLusakaClock();
  const now = Date.now();
  const nowIso = new Date(now).toISOString();
  const existingTest =
    storeData.users.find((u) => u.normalizedPhone === '+260900000001') ||
    storeData.users.find((u) => u.accountType === 'Demo' && /test/i.test(u.fullName)) ||
    null;

  if (existingTest) {
    existingTest.status = 'ACTIVE';
    existingTest.feedAccess = true;
    existingTest.accountType = 'Demo';
    existingTest.brokerConnected = true;
    existingTest.brokerSetup = normalizeBrokerSetup(
      {
        platformMt5: true,
        accountStandard: true,
        currencyUsd: true,
        leverageValid: true,
        hasWrongMt4OrCtrader: false,
        hasWrongCentOrEcn: false,
        hasWrongZmwOrEur: false,
        selectedBrokerPreset: 'XM',
        confirmedAt: existingTest.brokerSetup?.confirmedAt || nowIso,
      },
      existingTest.brokerName || 'XM'
    );
    existingTest.approvedAt = existingTest.approvedAt || nowIso;
    const currentExpMs = existingTest.expiresAt ? Date.parse(existingTest.expiresAt) : NaN;
    if (!Number.isFinite(currentExpMs) || currentExpMs <= now) {
      existingTest.expiresAt = new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString();
    }
    existingTest.lastAdminActionAt = nowIso;
    saveStoreNow();
    return existingTest;
  }

  const planSpec = storeData.plans.monthly || DEFAULT_PLANS.monthly;
  const testUser: StoredUser = {
    id: `usr-test-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    fullName: 'Gold AI Test Account',
    phone: '+260900000001',
    normalizedPhone: '+260900000001',
    passwordHash: hashPassword('Test1234!'),
    brokerName: 'XM',
    brokerServer: storeData.tickerAllMaster.brokerServer || 'XMGlobal-MT5 9',
    mt5Login: '99000001',
    brokerApiKeyEnc: '',
    brokerApiKeyLast4: '',
    brokerBridgeUrl: '',
    brokerConnected: true,
    brokerSetup: {
      platformMt5: true,
      accountStandard: true,
      currencyUsd: true,
      leverageValid: true,
      hasWrongMt4OrCtrader: false,
      hasWrongCentOrEcn: false,
      hasWrongZmwOrEur: false,
      selectedBrokerPreset: 'XM',
      confirmedAt: nowIso,
    },
    accountType: 'Demo',
    status: 'ACTIVE',
    plan: 'monthly',
    amountKwacha: planSpec.kwacha,
    amountUsd: planSpec.usd,
    paymentMethod: 'Airtel MoMo',
    transactionId: 'TEST-DEMO-ACCOUNT',
    screenshotDataUrl: null,
    submittedAt: nowIso,
    approvedAt: nowIso,
    expiresAt: new Date(now + 30 * 24 * 60 * 60 * 1000).toISOString(),
    feedAccess: true,
    autoTradeEnabled: false,
    balance: 1000,
    equity: 1000,
    lastBalanceSyncAt: null,
    balanceSyncSource: null,
    settings: buildDefaultUserSettings(),
    levels: createFreshDayLevels(clock.dateLusaka),
    tradeLog: [],
    signalHistory: [],
    tradeOrders: [],
    riskEvents: [],
    auditLogs: [],
    notifications: [],
    processedSignalIds: [],
    processedHistoryIds: [],
    processedAutoIds: [],
    lastAiApproval: null,
    firebaseUid: null,
    firebaseEmail: null,
    lastAdminActionAt: nowIso,
    createdAt: nowIso,
  };

  storeData.users.unshift(testUser);
  saveStoreNow();
  return testUser;
}

export function buildDefaultUserSettings(): StrategySettings {
  return {
    ...DEFAULT_STRATEGY_SETTINGS,
    strategyMode: 'EMA_STOCHASTIC_PRO',
    autoLogSignals: true,
    emaPro: { ...DEFAULT_EMA_PRO_CONFIG },
    newsEvents: DEFAULT_STRATEGY_SETTINGS.newsEvents.map((ev) => ({ ...ev })),
  };
}
