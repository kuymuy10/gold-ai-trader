/**
 * Gold AI Trader — Firestore Security Rules Verification Suite ("Dirty Dozen")
 * Designed for execution with @firebase/rules-unit-testing against the Firestore Emulator.
 */
import assert from 'node:assert/strict';

export interface DirtyDozenCase {
  id: number;
  name: string;
  actor: { uid: string | null; email?: string; email_verified?: boolean };
  operation: 'get' | 'list' | 'create' | 'update' | 'delete';
  path: string;
  payload?: Record<string, unknown>;
  expected: 'PERMISSION_DENIED';
}

export const DIRTY_DOZEN_PAYLOADS: DirtyDozenCase[] = [
  {
    id: 1,
    name: 'Unauthenticated read of trader account',
    actor: { uid: null },
    operation: 'get',
    path: 'users/trader_alpha',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 2,
    name: 'Unverified email user attempting to create trader profile',
    actor: { uid: 'trader_alpha', email: 'alpha@example.com', email_verified: false },
    operation: 'create',
    path: 'users/trader_alpha',
    payload: { ownerId: 'trader_alpha', status: 'PENDING', feedAccess: false },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 3,
    name: 'Self-approval escalation on create (status ACTIVE / feedAccess true)',
    actor: { uid: 'trader_alpha', email: 'alpha@example.com', email_verified: true },
    operation: 'create',
    path: 'users/trader_alpha',
    payload: {
      ownerId: 'trader_alpha',
      appUserId: 'usr-1',
      fullName: 'Attacker',
      brokerName: 'XM',
      brokerServer: 'XMGlobal-MT5',
      mt5Login: '123456',
      accountType: 'Demo',
      status: 'ACTIVE',
      plan: 'weekly',
      amountKwacha: 150,
      amountUsd: 5,
      paymentMethod: 'Airtel MoMo',
      transactionId: 'TX1',
      submittedAt: '2026-01-01T00:00:00.000Z',
      approvedAt: '2026-01-01T00:00:00.000Z',
      expiresAt: '2099-01-01T00:00:00.000Z',
      feedAccess: true,
      autoTradeEnabled: false,
      brokerConnected: true,
      balance: 1000,
      equity: 1000,
    },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 4,
    name: 'Cross-user identity spoof writing to another UID path',
    actor: { uid: 'trader_alpha', email: 'alpha@example.com', email_verified: true },
    operation: 'create',
    path: 'users/trader_beta',
    payload: { ownerId: 'trader_alpha', status: 'PENDING', feedAccess: false },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 5,
    name: 'Shadow ghost field injection (isAdmin: true)',
    actor: { uid: 'trader_alpha', email: 'alpha@example.com', email_verified: true },
    operation: 'create',
    path: 'users/trader_alpha',
    payload: { ownerId: 'trader_alpha', isAdmin: true, status: 'PENDING' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 6,
    name: 'Non-admin owner self-escalating status and feedAccess via update',
    actor: { uid: 'trader_alpha', email: 'alpha@example.com', email_verified: true },
    operation: 'update',
    path: 'users/trader_alpha',
    payload: { status: 'ACTIVE', feedAccess: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 7,
    name: 'Client timestamp backdating instead of request.time',
    actor: { uid: 'trader_alpha', email: 'alpha@example.com', email_verified: true },
    operation: 'create',
    path: 'users/trader_alpha',
    payload: { ownerId: 'trader_alpha', createdAt: '2020-01-01T00:00:00.000Z' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 8,
    name: 'Blocked user toggling autoTradeEnabled on',
    actor: { uid: 'trader_blocked', email: 'blocked@example.com', email_verified: true },
    operation: 'update',
    path: 'users/trader_blocked',
    payload: { autoTradeEnabled: true },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 9,
    name: 'Path variable ID poisoning with illegal characters',
    actor: { uid: 'trader_alpha', email: 'alpha@example.com', email_verified: true },
    operation: 'create',
    path: 'users/trader_alpha/trades/bad.id$123',
    payload: { ownerId: 'trader_alpha', id: 'bad.id$123' },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 10,
    name: 'PII cross-tenant read of another user private profile',
    actor: { uid: 'trader_alpha', email: 'alpha@example.com', email_verified: true },
    operation: 'get',
    path: 'users/trader_beta/private/profile',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 11,
    name: 'Volumetric string overflow on trade notes (> 600 chars)',
    actor: { uid: 'trader_alpha', email: 'alpha@example.com', email_verified: true },
    operation: 'create',
    path: 'users/trader_alpha/trades/trd-overflow',
    payload: { ownerId: 'trader_alpha', id: 'trd-overflow', notes: 'X'.repeat(2000) },
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 12,
    name: 'Blanket list query by non-admin user on users collection',
    actor: { uid: 'trader_alpha', email: 'alpha@example.com', email_verified: true },
    operation: 'list',
    path: 'users',
    expected: 'PERMISSION_DENIED',
  },
  {
    id: 13,
    name: 'Non-admin verified user reading encrypted adminConfig/master',
    actor: { uid: 'trader_alpha', email: 'alpha@example.com', email_verified: true },
    operation: 'get',
    path: 'adminConfig/master',
    expected: 'PERMISSION_DENIED',
  },
];

assert.equal(DIRTY_DOZEN_PAYLOADS.length, 13);

import fs from 'node:fs';
import path from 'node:path';

const rulesContent = fs.readFileSync(path.resolve('firestore.rules'), 'utf8');
assert.ok(
  rulesContent.includes('exists(/databases/$(database)/documents/users/$(userId))'),
  'Subcollection rules must enforce parent user existence via exists()'
);
assert.ok(
  !rulesContent.includes('existsAfter('),
  'Sequential parent-first writes avoid fragile batch-only existsAfter() assumptions'
);
assert.ok(
  rulesContent.includes("request.auth.token.email.lower() == 'muyobakuyewana@gmail.com'"),
  'Root admin email guard must be present'
);
assert.ok(
  rulesContent.includes('ema.size() <= 60'),
  'isValidEmaProConfig must permit dynamic spread filter fields (<= 60 keys)'
);
assert.ok(
  rulesContent.includes("'NEW_YORK_SESSION'") && rulesContent.includes("'ALL_SESSIONS'"),
  'isValidTradeRecord must allow all-session trading tags'
);
