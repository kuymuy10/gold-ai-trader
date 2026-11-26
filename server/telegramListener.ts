import { Api, TelegramClient } from 'telegram';
import { NewMessage, type NewMessageEvent } from 'telegram/events/index.js';
import { Logger, LogLevel } from 'telegram/extensions/Logger.js';
import { StringSession } from 'telegram/sessions/index.js';
import type {
  ParsedTelegramSignal,
  SignalSourceMode,
  TelegramChannelMessage,
  TelegramConnectionStatus,
  TelegramListenerPublicState,
} from '../src/types/connectivity.ts';
import { getLusakaClock } from '../src/utils/strategyEngine.ts';
import { parseTelegramSignal } from '../src/utils/telegramSignalParser.ts';
import {
  createEmptyTelegramConfig,
  decryptSecret,
  encryptSecret,
  findUserById,
  getStore,
  saveStoreNow,
  type StoredTelegramConfig,
  type StoredUser,
} from './businessStore.ts';

interface TelegramUserRuntime {
  userId: string;
  client: TelegramClient | null;
  status: TelegramConnectionStatus;
  phoneCodeHash: string | null;
  pendingPhoneNumber: string | null;
  pendingApiId: number | null;
  pendingApiHash: string | null;
  isCodeViaApp: boolean;
  lastError: string | null;
  lastMessageAt: string | null;
  messageHandler: ((event: NewMessageEvent) => Promise<void>) | null;
  eventBuilder: NewMessage | null;
  resolvedChannelId: string | null;
  resolvedChannelTitle: string | null;
  listenerStartedAtSec: number | null;
}

export interface TelegramHookCallbacks {
  onStateChange: () => void;
  onSignalReceived: (
    userId: string,
    message: TelegramChannelMessage
  ) => Promise<{
    executionStatus: ParsedTelegramSignal['executionStatus'];
    executionNote: string;
    tradeId?: string | null;
    orderId?: string | null;
  }>;
}

const runtimes = new Map<string, TelegramUserRuntime>();
let callbacks: TelegramHookCallbacks = {
  onStateChange: () => {},
  onSignalReceived: async () => ({
    executionStatus: 'BLOCKED',
    executionNote: 'Auto-trading pipeline not initialized',
  }),
};

export function registerTelegramHooks(hooks: TelegramHookCallbacks): void {
  callbacks = hooks;
}

function getEnvTelegramDefaults() {
  const apiId = (process.env.TELEGRAM_API_ID || '').trim();
  const apiHash = (process.env.TELEGRAM_API_HASH || '').trim();
  const phoneNumber = (process.env.TELEGRAM_PHONE_NUMBER || '').trim();
  const channelTarget = (process.env.TELEGRAM_CHANNEL || '').trim();
  const sessionString = (process.env.TELEGRAM_SESSION_STRING || '').trim();
  return {
    apiId,
    apiHash,
    phoneNumber,
    channelTarget,
    sessionString,
    envFallbackConfigured: Boolean(apiId && apiHash && (phoneNumber || sessionString)),
  };
}

export function ensureUserTelegramConfig(user: StoredUser): StoredTelegramConfig {
  if (!user.telegramConfig) {
    user.telegramConfig = createEmptyTelegramConfig();
  }
  if (!Array.isArray(user.telegramMessages)) {
    user.telegramMessages = [];
  }
  return user.telegramConfig;
}

function getOrCreateRuntime(user: StoredUser): TelegramUserRuntime {
  let rt = runtimes.get(user.id);
  if (!rt) {
    const cfg = ensureUserTelegramConfig(user);
    rt = {
      userId: user.id,
      client: null,
      status: 'DISCONNECTED',
      phoneCodeHash: null,
      pendingPhoneNumber: null,
      pendingApiId: null,
      pendingApiHash: null,
      isCodeViaApp: false,
      lastError: null,
      lastMessageAt:
        Array.isArray(user.telegramMessages) && user.telegramMessages.length > 0
          ? user.telegramMessages[0].receivedAt
          : null,
      messageHandler: null,
      eventBuilder: null,
      resolvedChannelId: cfg.resolvedChannelId,
      resolvedChannelTitle: cfg.resolvedChannelTitle,
      listenerStartedAtSec: null,
    };
    runtimes.set(user.id, rt);
  }
  return rt;
}

function resolveEffectiveCredentials(user: StoredUser) {
  const cfg = ensureUserTelegramConfig(user);
  const env = getEnvTelegramDefaults();
  const apiIdStr = cfg.apiId.trim() || env.apiId;
  const apiIdNum = Number(apiIdStr);
  const userApiHash = cfg.apiHashEnc ? decryptSecret(cfg.apiHashEnc) : '';
  const apiHash = userApiHash || env.apiHash;
  const phoneNumber = cfg.phoneNumber.trim() || env.phoneNumber;
  const channelTarget = cfg.channelTarget.trim() || env.channelTarget;
  const userSession = cfg.sessionStringEnc ? decryptSecret(cfg.sessionStringEnc) : '';
  const sessionString = userSession || env.sessionString;
  return {
    apiIdStr,
    apiIdNum,
    apiHash,
    apiHashLast4: cfg.apiHashLast4 || (apiHash ? apiHash.slice(-4) : ''),
    hasApiHash: Boolean(apiHash),
    phoneNumber,
    channelTarget,
    sessionString,
    hasSession: Boolean(sessionString),
    envFallbackConfigured: env.envFallbackConfigured,
  };
}

function formatTelegramError(err: unknown): string {
  const rec = err as { errorMessage?: string; message?: string; seconds?: number } | null;
  const code = rec?.errorMessage || '';
  if (code === 'API_ID_INVALID') return 'Invalid Telegram API_ID or API_HASH.';
  if (code === 'PHONE_NUMBER_INVALID') {
    return 'Invalid phone number. Include country code (e.g. +260971234567).';
  }
  if (code === 'PHONE_CODE_INVALID') return 'Invalid verification code. Please try again.';
  if (code === 'PHONE_CODE_EXPIRED') {
    return 'Verification code expired. Click Connect Telegram to request a new code.';
  }
  if (code === 'PASSWORD_HASH_INVALID') return 'Incorrect Telegram 2FA password.';
  if (code === 'SESSION_PASSWORD_NEEDED') return 'Two-step verification password required.';
  if (code.startsWith('FLOOD_WAIT_')) {
    return `Telegram rate limit active (${code}). Please wait before retrying.`;
  }
  if (err instanceof Error && err.message) return err.message;
  return code || 'Telegram connection failed';
}

function createGramClient(sessionString: string, apiId: number, apiHash: string): TelegramClient {
  const silentLogger = new Logger(LogLevel.NONE);
  return new TelegramClient(new StringSession(sessionString), apiId, apiHash, {
    connectionRetries: 5,
    retryDelay: 1500,
    autoReconnect: true,
    baseLogger: silentLogger,
  });
}

function detachMessageHandler(rt: TelegramUserRuntime): void {
  if (rt.client && rt.messageHandler && rt.eventBuilder) {
    try {
      rt.client.removeEventHandler(rt.messageHandler, rt.eventBuilder);
    } catch {
      // Ignore cleanup errors
    }
  }
  rt.messageHandler = null;
  rt.eventBuilder = null;
}

function normalizeChannelLookup(rawTarget: string): {
  cleaned: string;
  numericCandidate: string | null;
  inviteHash: string | null;
} {
  let target = (rawTarget || '').trim();
  if (!target) return { cleaned: '', numericCandidate: null, inviteHash: null };

  // Strip full URL prefixes while handling t.me/c/<id>/<msg> and invite links
  const privatePostMatch = target.match(/(?:https?:\/\/)?(?:t\.me|telegram\.me)\/c\/(\d+)(?:\/\d+)?/i);
  if (privatePostMatch) {
    const negId = `-100${privatePostMatch[1]}`;
    return { cleaned: negId, numericCandidate: negId, inviteHash: null };
  }

  const inviteMatch = target.match(
    /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/(?:\+|joinchat\/)([A-Za-z0-9_\-]+)/i
  );
  if (inviteMatch) {
    return { cleaned: target, numericCandidate: null, inviteHash: inviteMatch[1] };
  }

  const publicUrlMatch = target.match(
    /(?:https?:\/\/)?(?:t\.me|telegram\.me)\/([A-Za-z0-9_]{3,})(?:\/\d+)?/i
  );
  if (publicUrlMatch) {
    target = publicUrlMatch[1];
  }

  if (target.startsWith('@')) {
    return { cleaned: target.slice(1), numericCandidate: null, inviteHash: null };
  }

  if (/^-?\d+$/.test(target)) {
    const normalizedId = target.startsWith('-100')
      ? target
      : target.startsWith('-')
        ? target
        : `-100${target}`;
    return { cleaned: target, numericCandidate: normalizedId, inviteHash: null };
  }

  return { cleaned: target, numericCandidate: null, inviteHash: null };
}

function getEntityDisplayTitle(entity: unknown, fallback: string): string {
  if (!entity || typeof entity !== 'object') return fallback;
  const rec = entity as {
    title?: string;
    username?: string;
    firstName?: string;
    lastName?: string;
  };
  if (rec.title) return rec.title;
  if (rec.username) return `@${rec.username}`;
  if (rec.firstName) return `${rec.firstName} ${rec.lastName || ''}`.trim();
  return fallback;
}

function getEntityChatIds(entity: unknown): Set<string> {
  const ids = new Set<string>();
  if (!entity || typeof entity !== 'object') return ids;
  const rec = entity as { id?: unknown; className?: string };
  if (rec.id !== undefined && rec.id !== null) {
    const raw = String(rec.id);
    ids.add(raw);
    if (rec.className === 'Channel' || rec.className === 'ChannelForbidden') {
      ids.add(raw.startsWith('-100') ? raw : `-100${raw.replace(/^-/, '')}`);
    } else if (rec.className === 'Chat' || rec.className === 'ChatForbidden') {
      ids.add(raw.startsWith('-') ? raw : `-${raw}`);
    }
  }
  return ids;
}

async function resolveChannelEntity(client: TelegramClient, rawTarget: string): Promise<{
  entity: unknown;
  canonicalId: string;
  title: string;
  acceptedIds: Set<string>;
}> {
  const { cleaned, numericCandidate, inviteHash } = normalizeChannelLookup(rawTarget);
  if (!cleaned) {
    throw new Error('Please configure the Channel Link or Channel ID first.');
  }

  if (inviteHash) {
    try {
      const checkRes = await client.invoke(new Api.messages.CheckChatInvite({ hash: inviteHash }));
      const rec = checkRes as unknown as { chat?: unknown };
      if (rec?.chat) {
        const ids = getEntityChatIds(rec.chat);
        const firstId = Array.from(ids)[0] || rawTarget;
        return {
          entity: rec.chat,
          canonicalId: numericCandidate || firstId,
          title: getEntityDisplayTitle(rec.chat, rawTarget),
          acceptedIds: ids,
        };
      }
    } catch {
      // Fall through to dialog scan below
    }
  }

  const lookupCandidates: string[] = [];
  if (numericCandidate) lookupCandidates.push(numericCandidate);
  lookupCandidates.push(cleaned);

  for (const candidate of lookupCandidates) {
    try {
      const ent = await client.getEntity(candidate);
      if (ent) {
        const ids = getEntityChatIds(ent);
        return {
          entity: ent,
          canonicalId: numericCandidate || Array.from(ids)[0] || candidate,
          title: getEntityDisplayTitle(ent, rawTarget),
          acceptedIds: ids,
        };
      }
    } catch {
      // Try next candidate or fall back to dialogs
    }
  }

  // Fallback: scan the user's joined dialogs (works reliably for private/non-owned channels)
  const dialogs = await client.getDialogs({ limit: 150 });
  const targetLower = cleaned.toLowerCase();
  for (const dlg of dialogs) {
    const dlgId = dlg.id !== undefined && dlg.id !== null ? String(dlg.id) : '';
    const ent = dlg.entity as { id?: unknown; username?: string; title?: string } | undefined;
    const entId = ent?.id !== undefined && ent?.id !== null ? String(ent.id) : '';
    const entUsername = (ent?.username || '').toLowerCase();
    const dlgTitle = (dlg.title || ent?.title || '').toLowerCase();
    const matchesNumeric =
      numericCandidate &&
      (dlgId === numericCandidate ||
        `-100${entId}` === numericCandidate ||
        entId === cleaned ||
        dlgId === cleaned);
    const matchesName =
      (entUsername && entUsername === targetLower) ||
      (dlgTitle && dlgTitle === targetLower);
    if (matchesNumeric || matchesName) {
      const targetEntity = ent || dlg.inputEntity;
      const ids = getEntityChatIds(targetEntity);
      if (dlgId) ids.add(dlgId);
      return {
        entity: targetEntity,
        canonicalId: dlgId || numericCandidate || entId || cleaned,
        title: getEntityDisplayTitle(targetEntity, dlg.title || rawTarget),
        acceptedIds: ids,
      };
    }
  }

  throw new Error(
    `Could not find channel "${rawTarget}" in your Telegram account. Make sure this Telegram user account has joined the channel and check the link or numeric -100... ID.`
  );
}

export function getTelegramPublicState(user: StoredUser): TelegramListenerPublicState {
  const cfg = ensureUserTelegramConfig(user);
  const creds = resolveEffectiveCredentials(user);
  const rt = getOrCreateRuntime(user);
  return {
    apiId: creds.apiIdStr,
    hasApiHash: creds.hasApiHash,
    apiHashLast4: creds.apiHashLast4,
    phoneNumber: creds.phoneNumber,
    channelTarget: creds.channelTarget,
    resolvedChannelTitle: rt.resolvedChannelTitle || cfg.resolvedChannelTitle,
    resolvedChannelId: rt.resolvedChannelId || cfg.resolvedChannelId,
    status: rt.status,
    hasSession: creds.hasSession,
    isCodeViaApp: rt.isCodeViaApp,
    autoExecuteSignals: Boolean(cfg.autoExecuteSignals),
    signalSource:
      cfg.signalSource === 'STRATEGY' || cfg.signalSource === 'TELEGRAM'
        ? cfg.signalSource
        : 'BOTH',
    lastError: rt.lastError,
    lastMessageAt:
      rt.lastMessageAt ||
      (user.telegramMessages && user.telegramMessages.length > 0
        ? user.telegramMessages[0].receivedAt
        : null),
    envFallbackConfigured: creds.envFallbackConfigured,
    messages: (user.telegramMessages || []).slice(0, 80),
  };
}

export function saveTelegramConfigForUser(
  user: StoredUser,
  patch: {
    apiId?: string;
    apiHash?: string;
    phoneNumber?: string;
    channelTarget?: string;
    autoExecuteSignals?: boolean;
    signalSource?: SignalSourceMode;
  }
): TelegramListenerPublicState {
  const cfg = ensureUserTelegramConfig(user);
  if (typeof patch.apiId === 'string') {
    cfg.apiId = patch.apiId.replace(/[^\d]/g, '').trim();
  }
  if (typeof patch.apiHash === 'string' && patch.apiHash.trim()) {
    const cleanHash = patch.apiHash.trim();
    cfg.apiHashEnc = encryptSecret(cleanHash);
    cfg.apiHashLast4 = cleanHash.slice(-4);
  }
  if (typeof patch.phoneNumber === 'string') {
    cfg.phoneNumber = patch.phoneNumber.replace(/[^\d+]/g, '').trim();
  }
  if (typeof patch.channelTarget === 'string') {
    const nextChannel = patch.channelTarget.trim();
    if (nextChannel !== cfg.channelTarget) {
      cfg.channelTarget = nextChannel;
      cfg.resolvedChannelId = null;
      cfg.resolvedChannelTitle = null;
      const rt = getOrCreateRuntime(user);
      rt.resolvedChannelId = null;
      rt.resolvedChannelTitle = null;
    }
  }
  if (typeof patch.autoExecuteSignals === 'boolean') {
    cfg.autoExecuteSignals = patch.autoExecuteSignals;
  }
  if (
    patch.signalSource === 'STRATEGY' ||
    patch.signalSource === 'TELEGRAM' ||
    patch.signalSource === 'BOTH'
  ) {
    cfg.signalSource = patch.signalSource;
  }
  const rt = getOrCreateRuntime(user);
  rt.lastError = null;
  saveStoreNow();
  callbacks.onStateChange();
  return getTelegramPublicState(user);
}

const connectInFlight = new Map<
  string,
  Promise<{
    ok: boolean;
    error?: string;
    needsCode?: boolean;
    needs2fa?: boolean;
    state: TelegramListenerPublicState;
  }>
>();

export async function connectTelegramUser(user: StoredUser): Promise<{
  ok: boolean;
  error?: string;
  needsCode?: boolean;
  needs2fa?: boolean;
  state: TelegramListenerPublicState;
}> {
  const existingConnect = connectInFlight.get(user.id);
  if (existingConnect) {
    return existingConnect;
  }
  const run = (async () => {
  const cfg = ensureUserTelegramConfig(user);
  const creds = resolveEffectiveCredentials(user);
  const rt = getOrCreateRuntime(user);

  if (!Number.isFinite(creds.apiIdNum) || creds.apiIdNum <= 0) {
    rt.lastError = 'Valid Telegram API_ID is required (from my.telegram.org).';
    rt.status = 'DISCONNECTED';
    callbacks.onStateChange();
    return { ok: false, error: rt.lastError, state: getTelegramPublicState(user) };
  }
  if (!creds.apiHash) {
    rt.lastError = 'Telegram API_HASH is required (from my.telegram.org).';
    rt.status = 'DISCONNECTED';
    callbacks.onStateChange();
    return { ok: false, error: rt.lastError, state: getTelegramPublicState(user) };
  }

  rt.status = 'CONNECTING';
  rt.lastError = null;
  detachMessageHandler(rt);
  if (rt.client) {
    try {
      await rt.client.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    rt.client = null;
  }
  callbacks.onStateChange();

  const client = createGramClient(creds.sessionString, creds.apiIdNum, creds.apiHash);
  try {
    await client.connect();
    const authorized = await client.checkAuthorization();
    if (authorized) {
      await client.getMe();
      const savedSession = String((client.session.save() as unknown) || '');
      if (savedSession) {
        cfg.sessionStringEnc = encryptSecret(savedSession);
      }
      rt.client = client;
      rt.status = 'CONNECTED';
      rt.phoneCodeHash = null;
      rt.pendingPhoneNumber = null;
      rt.pendingApiId = null;
      rt.pendingApiHash = null;
      rt.lastError = null;
      saveStoreNow();
      callbacks.onStateChange();
      return { ok: true, state: getTelegramPublicState(user) };
    }

    if (!creds.phoneNumber) {
      try {
        await client.disconnect();
      } catch {
        // Ignore
      }
      rt.client = null;
      rt.status = 'DISCONNECTED';
      rt.lastError = 'Phone number with country code is required to sign in.';
      callbacks.onStateChange();
      return { ok: false, error: rt.lastError, state: getTelegramPublicState(user) };
    }

    const sendRes = await client.sendCode(
      { apiId: creds.apiIdNum, apiHash: creds.apiHash },
      creds.phoneNumber
    );
    rt.client = client;
    rt.phoneCodeHash = sendRes.phoneCodeHash;
    rt.isCodeViaApp = Boolean(sendRes.isCodeViaApp);
    rt.pendingPhoneNumber = creds.phoneNumber;
    rt.pendingApiId = creds.apiIdNum;
    rt.pendingApiHash = creds.apiHash;
    rt.status = 'AWAITING_CODE';
    rt.lastError = null;
    callbacks.onStateChange();
    return {
      ok: true,
      needsCode: true,
      state: getTelegramPublicState(user),
    };
  } catch (err) {
    try {
      await client.disconnect();
    } catch {
      // Ignore
    }
    rt.client = null;
    rt.status = 'DISCONNECTED';
    rt.lastError = formatTelegramError(err);
    callbacks.onStateChange();
    return { ok: false, error: rt.lastError, state: getTelegramPublicState(user) };
  }
  })();
  connectInFlight.set(user.id, run);
  try {
    return await run;
  } finally {
    if (connectInFlight.get(user.id) === run) {
      connectInFlight.delete(user.id);
    }
  }
}

export async function verifyTelegramUserCode(
  user: StoredUser,
  params: { code?: string; password?: string }
): Promise<{
  ok: boolean;
  error?: string;
  needs2fa?: boolean;
  state: TelegramListenerPublicState;
}> {
  const cfg = ensureUserTelegramConfig(user);
  const rt = getOrCreateRuntime(user);
  const code = (params.code || '').trim();
  const password = (params.password || '').trim();

  if (!rt.client || (rt.status !== 'AWAITING_CODE' && rt.status !== 'AWAITING_2FA')) {
    return {
      ok: false,
      error: 'No pending Telegram verification. Click Connect Telegram first.',
      state: getTelegramPublicState(user),
    };
  }

  const client = rt.client;
  const apiId = rt.pendingApiId || Number(resolveEffectiveCredentials(user).apiIdNum);
  const apiHash = rt.pendingApiHash || resolveEffectiveCredentials(user).apiHash;
  const phoneNumber = rt.pendingPhoneNumber || resolveEffectiveCredentials(user).phoneNumber;

  const finalizeAuthorizedSession = async () => {
    await client.getMe();
    const savedSession = String((client.session.save() as unknown) || '');
    if (savedSession) {
      cfg.sessionStringEnc = encryptSecret(savedSession);
    }
    rt.status = 'CONNECTED';
    rt.phoneCodeHash = null;
    rt.pendingPhoneNumber = null;
    rt.pendingApiId = null;
    rt.pendingApiHash = null;
    rt.lastError = null;
    saveStoreNow();
    callbacks.onStateChange();
  };

  try {
    if (rt.status === 'AWAITING_2FA') {
      if (!password) {
        return {
          ok: false,
          needs2fa: true,
          error: 'Please enter your Telegram 2FA cloud password.',
          state: getTelegramPublicState(user),
        };
      }
      await client.signInWithPassword(
        { apiId, apiHash },
        {
          password: async () => password,
          onError: async () => true,
        }
      );
      await finalizeAuthorizedSession();
      return { ok: true, state: getTelegramPublicState(user) };
    }

    if (!code) {
      return {
        ok: false,
        error: 'Please enter the verification code sent to your Telegram app or SMS.',
        state: getTelegramPublicState(user),
      };
    }
    if (!rt.phoneCodeHash || !phoneNumber) {
      return {
        ok: false,
        error: 'Verification session expired. Click Connect Telegram again.',
        state: getTelegramPublicState(user),
      };
    }

    try {
      await client.invoke(
        new Api.auth.SignIn({
          phoneNumber,
          phoneCodeHash: rt.phoneCodeHash,
          phoneCode: code,
        })
      );
      await finalizeAuthorizedSession();
      return { ok: true, state: getTelegramPublicState(user) };
    } catch (signInErr) {
      const codeMsg = (signInErr as { errorMessage?: string } | null)?.errorMessage || '';
      if (codeMsg === 'SESSION_PASSWORD_NEEDED') {
        if (password) {
          await client.signInWithPassword(
            { apiId, apiHash },
            {
              password: async () => password,
              onError: async () => true,
            }
          );
          await finalizeAuthorizedSession();
          return { ok: true, state: getTelegramPublicState(user) };
        }
        rt.status = 'AWAITING_2FA';
        rt.lastError = null;
        callbacks.onStateChange();
        return {
          ok: true,
          needs2fa: true,
          state: getTelegramPublicState(user),
        };
      }
      throw signInErr;
    }
  } catch (err) {
    rt.lastError = formatTelegramError(err);
    callbacks.onStateChange();
    return {
      ok: false,
      needs2fa: rt.status === 'AWAITING_2FA',
      error: rt.lastError,
      state: getTelegramPublicState(user),
    };
  }
}

export async function startListeningTelegramUser(user: StoredUser): Promise<{
  ok: boolean;
  error?: string;
  state: TelegramListenerPublicState;
}> {
  const cfg = ensureUserTelegramConfig(user);
  const creds = resolveEffectiveCredentials(user);
  const rt = getOrCreateRuntime(user);

  if (!creds.channelTarget) {
    rt.lastError = 'Channel Link or Channel ID is required before starting listener.';
    callbacks.onStateChange();
    return { ok: false, error: rt.lastError, state: getTelegramPublicState(user) };
  }

  if (!rt.client || (rt.status !== 'CONNECTED' && rt.status !== 'LISTENING')) {
    if (!creds.hasSession) {
      rt.lastError = 'Telegram is disconnected. Click Connect Telegram first.';
      callbacks.onStateChange();
      return { ok: false, error: rt.lastError, state: getTelegramPublicState(user) };
    }
    const recon = await connectTelegramUser(user);
    if (!recon.ok) {
      return { ok: false, error: recon.error, state: getTelegramPublicState(user) };
    }
  }

  const client = rt.client;
  if (!client) {
    return {
      ok: false,
      error: 'Telegram client unavailable. Click Connect Telegram first.',
      state: getTelegramPublicState(user),
    };
  }

  try {
    detachMessageHandler(rt);
    const resolved = await resolveChannelEntity(client, creds.channelTarget);

    rt.resolvedChannelId = resolved.canonicalId;
    rt.resolvedChannelTitle = resolved.title;
    cfg.resolvedChannelId = resolved.canonicalId;
    cfg.resolvedChannelTitle = resolved.title;
    cfg.desiredListening = true;
    rt.listenerStartedAtSec = Math.floor(Date.now() / 1000) - 2;
    rt.lastError = null;

    const handler = async (event: NewMessageEvent) => {
      try {
        const msg = event.message;
        if (!msg) return;
        const msgText = (msg.message || msg.text || '').trim();
        if (!msgText) return;

        // Verify message belongs to the configured channel
        const rawChatId = event.chatId !== undefined && event.chatId !== null ? String(event.chatId) : '';
        if (
          rawChatId &&
          resolved.acceptedIds.size > 0 &&
          !resolved.acceptedIds.has(rawChatId) &&
          !resolved.acceptedIds.has(rawChatId.replace(/^-100/, ''))
        ) {
          return;
        }

        const freshUser = findUserById(user.id);
        if (!freshUser || freshUser.status !== 'ACTIVE') return;
        const freshCfg = ensureUserTelegramConfig(freshUser);
        if (!freshCfg.desiredListening) return;

        const existingList = freshUser.telegramMessages || [];
        const duplicate = existingList.some(
          (m) =>
            m.telegramMessageId === msg.id &&
            m.channelId === resolved.canonicalId
        );
        if (duplicate) return;

        const nowIso = new Date().toISOString();
        const lusakaClock = getLusakaClock(Date.now());
        const parsed = parseTelegramSignal(msgText);
        const activeSignalSource = freshCfg.signalSource || 'BOTH';
        const allowTelegramExec =
          Boolean(freshCfg.autoExecuteSignals) && activeSignalSource !== 'STRATEGY';
        if (!parsed.isSignal) {
          parsed.executionStatus = 'NOT_SIGNAL';
          parsed.executionNote = parsed.reason || 'Normal channel message — not traded';
        } else if (activeSignalSource === 'STRATEGY') {
          parsed.executionStatus = 'IGNORED_SETTING';
          parsed.executionNote =
            'Signal source is Built-in Strategy only — switch to Telegram or Both to auto-trade';
        } else if (!freshCfg.autoExecuteSignals) {
          parsed.executionStatus = 'IGNORED_SETTING';
          parsed.executionNote = 'Signal parsed — Auto-Execute Telegram Signals is paused';
        }

        const record: TelegramChannelMessage = {
          id: `tg-${resolved.canonicalId}-${msg.id}-${Date.now()}`,
          telegramMessageId: msg.id,
          channelId: resolved.canonicalId,
          channelTitle: resolved.title,
          text: msgText.slice(0, 4000),
          receivedAt: nowIso,
          lusakaTime: lusakaClock.timeLusaka,
          parsed,
        };

        freshUser.telegramMessages = [record, ...existingList].slice(0, 150);
        rt.lastMessageAt = nowIso;
        saveStoreNow();
        callbacks.onStateChange();

        if (parsed.isSignal && allowTelegramExec) {
          const execRes = await callbacks.onSignalReceived(freshUser.id, record);
          const afterUser = findUserById(freshUser.id);
          const savedTarget = afterUser?.telegramMessages?.find((m) => m.id === record.id);
          if (savedTarget) {
            savedTarget.parsed = {
              ...savedTarget.parsed,
              executionStatus: execRes.executionStatus,
              executionNote: execRes.executionNote,
              tradeId: execRes.tradeId ?? null,
              orderId: execRes.orderId ?? null,
            };
            saveStoreNow();
            callbacks.onStateChange();
          }
        }
      } catch (err) {
        console.error('[Telegram NewMessage handler error]', err);
      }
    };

    const eventBuilder = new NewMessage({
      chats: [resolved.entity as Api.TypeEntityLike],
    });
    client.addEventHandler(handler, eventBuilder);
    rt.messageHandler = handler;
    rt.eventBuilder = eventBuilder;
    rt.status = 'LISTENING';
    saveStoreNow();
    callbacks.onStateChange();
    return { ok: true, state: getTelegramPublicState(user) };
  } catch (err) {
    rt.status = 'CONNECTED';
    rt.lastError = formatTelegramError(err);
    callbacks.onStateChange();
    return { ok: false, error: rt.lastError, state: getTelegramPublicState(user) };
  }
}

export function stopListeningTelegramUser(user: StoredUser): {
  ok: boolean;
  state: TelegramListenerPublicState;
} {
  const cfg = ensureUserTelegramConfig(user);
  const rt = getOrCreateRuntime(user);
  detachMessageHandler(rt);
  cfg.desiredListening = false;
  rt.status = rt.client ? 'CONNECTED' : 'DISCONNECTED';
  saveStoreNow();
  callbacks.onStateChange();
  return { ok: true, state: getTelegramPublicState(user) };
}

export async function disconnectTelegramUser(
  user: StoredUser,
  clearSession = false
): Promise<{
  ok: boolean;
  state: TelegramListenerPublicState;
}> {
  const cfg = ensureUserTelegramConfig(user);
  const rt = getOrCreateRuntime(user);
  detachMessageHandler(rt);
  cfg.desiredListening = false;
  if (clearSession) {
    cfg.sessionStringEnc = '';
    cfg.resolvedChannelId = null;
    cfg.resolvedChannelTitle = null;
    rt.resolvedChannelId = null;
    rt.resolvedChannelTitle = null;
  }
  if (rt.client) {
    try {
      await rt.client.disconnect();
    } catch {
      // Ignore disconnect errors
    }
    rt.client = null;
  }
  rt.status = 'DISCONNECTED';
  rt.phoneCodeHash = null;
  rt.pendingPhoneNumber = null;
  rt.pendingApiId = null;
  rt.pendingApiHash = null;
  rt.lastError = null;
  saveStoreNow();
  callbacks.onStateChange();
  return { ok: true, state: getTelegramPublicState(user) };
}

export async function resumeTelegramListenersOnBoot(): Promise<void> {
  const users = getStore().users;
  for (const user of users) {
    if (user.status !== 'ACTIVE') continue;
    const cfg = ensureUserTelegramConfig(user);
    const creds = resolveEffectiveCredentials(user);
    if (cfg.desiredListening && creds.hasSession && creds.channelTarget) {
      try {
        await startListeningTelegramUser(user);
      } catch (err) {
        console.error('[Telegram boot resume error]', err);
      }
    }
  }
}

export async function sendTelegramPushMessage(
  user: StoredUser,
  text: string
): Promise<{ ok: boolean; error?: string }> {
  const cleanText = text.trim();
  if (!cleanText) {
    return { ok: false, error: 'Empty notification message' };
  }
  const rt = getOrCreateRuntime(user);
  const creds = resolveEffectiveCredentials(user);

  if (!rt.client || (rt.status !== 'CONNECTED' && rt.status !== 'LISTENING')) {
    if (rt.status === 'AWAITING_CODE' || rt.status === 'AWAITING_2FA' || rt.status === 'CONNECTING') {
      return { ok: false, error: 'Telegram authentication is currently in progress.' };
    }
    if (!creds.hasSession || !Number.isFinite(creds.apiIdNum) || creds.apiIdNum <= 0 || !creds.apiHash) {
      return { ok: false, error: 'Telegram user account is not connected.' };
    }
    const recon = await connectTelegramUser(user);
    if (!recon.ok) {
      return { ok: false, error: recon.error || 'Failed to reconnect Telegram session.' };
    }
  }

  const client = rt.client;
  if (!client) {
    return { ok: false, error: 'Telegram client unavailable.' };
  }

  try {
    await client.sendMessage('me', { message: cleanText });
    return { ok: true };
  } catch (err) {
    const formatted = formatTelegramError(err);
    console.error('[Telegram push alert error]', formatted);
    return { ok: false, error: formatted };
  }
}

export async function shutdownAllTelegramClients(): Promise<void> {
  for (const rt of runtimes.values()) {
    detachMessageHandler(rt);
    if (rt.client) {
      try {
        await rt.client.disconnect();
      } catch {
        // Ignore shutdown disconnect error
      }
      rt.client = null;
    }
    rt.status = 'DISCONNECTED';
  }
}
