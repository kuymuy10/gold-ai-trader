import type { BrokerType } from '../types/connectivity';

export interface StoredBrokerProfile {
  brokerType: BrokerType;
  brokerServer: string;
  mt5AccountNumber: string;
  mt5Password: string;
}

const STORAGE_KEY = 'goldmaster.brokerProfile.v1';

const VALID_BROKERS: BrokerType[] = ['mt5', 'mt4', 'ctrader', 'dxtrade'];

export function loadBrokerProfile(): StoredBrokerProfile {
  const defaults: StoredBrokerProfile = {
    brokerType: 'mt5',
    brokerServer: '',
    mt5AccountNumber: '',
    mt5Password: '',
  };

  if (typeof window === 'undefined' || !window.localStorage) {
    return defaults;
  }

  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaults;
    const parsed = JSON.parse(raw) as Partial<StoredBrokerProfile>;
    const brokerType = VALID_BROKERS.includes(parsed.brokerType as BrokerType)
      ? (parsed.brokerType as BrokerType)
      : 'mt5';

    return {
      brokerType,
      brokerServer: typeof parsed.brokerServer === 'string' ? parsed.brokerServer : '',
      mt5AccountNumber:
        typeof parsed.mt5AccountNumber === 'string'
          ? parsed.mt5AccountNumber
          : typeof parsed.mt5AccountNumber === 'number'
            ? String(parsed.mt5AccountNumber)
            : '',
      mt5Password: typeof parsed.mt5Password === 'string' ? parsed.mt5Password : '',
    };
  } catch {
    return defaults;
  }
}

export function saveBrokerProfile(profile: Partial<StoredBrokerProfile>): StoredBrokerProfile {
  const current = loadBrokerProfile();
  const next: StoredBrokerProfile = {
    brokerType:
      profile.brokerType && VALID_BROKERS.includes(profile.brokerType)
        ? profile.brokerType
        : current.brokerType,
    brokerServer:
      typeof profile.brokerServer === 'string' ? profile.brokerServer : current.brokerServer,
    mt5AccountNumber:
      typeof profile.mt5AccountNumber === 'string'
        ? profile.mt5AccountNumber
        : current.mt5AccountNumber,
    mt5Password:
      typeof profile.mt5Password === 'string' ? profile.mt5Password : current.mt5Password,
  };

  if (typeof window !== 'undefined' && window.localStorage) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Ignore storage quota / private mode errors
    }
  }
  return next;
}

export function validateBrokerProfile(profile: {
  brokerServer: string;
  mt5AccountNumber: string;
}): {
  valid: boolean;
  missingServer: boolean;
  missingAccount: boolean;
  errorMessage: string | null;
} {
  const missingServer = !profile.brokerServer || !profile.brokerServer.trim();
  const acctTrimmed = (profile.mt5AccountNumber || '').trim();
  const acctNum = Number(acctTrimmed);
  const missingAccount = !acctTrimmed || !Number.isFinite(acctNum) || acctNum <= 0;
  const valid = !missingServer && !missingAccount;
  return {
    valid,
    missingServer,
    missingAccount,
    errorMessage: valid ? null : 'Fill Broker Server and MT5 Account Number first',
  };
}

export function buildMaskedSessionPayload(profile: StoredBrokerProfile): {
  broker: BrokerType;
  server: string;
  account: number;
  password: string;
} {
  const acctNum = Number((profile.mt5AccountNumber || '').trim());
  return {
    broker: profile.brokerType || 'mt5',
    server: (profile.brokerServer || '').trim(),
    account: Number.isFinite(acctNum) && acctNum > 0 ? acctNum : 0,
    password: profile.mt5Password && profile.mt5Password.length > 0 ? '***' : '',
  };
}
