# Gold AI Trader — Firestore Security Specification (Phase 0)

## 1. Data Invariants
1. **Identity Ownership Invariant**: Every `/users/{userId}` document and every subcollection document under `/users/{userId}/private/{docId}`, `/users/{userId}/trades/{tradeId}`, and `/users/{userId}/payments/{paymentId}` MUST carry `ownerId == userId`. Non-admin clients can only read or write documents where `request.auth.uid == userId` and `request.auth.token.email_verified == true`.
2. **Privilege Non-Escalation Invariant**: A non-admin trader creating `/users/{userId}` MUST initialize `status == 'PENDING'`, `feedAccess == false`, `autoTradeEnabled == false`, `approvedAt == null`, and `expiresAt == null`. Only `isAdmin()` can transition `status` to `'ACTIVE'` or `'BLOCKED'`, enable `feedAccess`, or grant `approvedAt`/`expiresAt`.
3. **Renewal Integrity Invariant**: When an existing non-admin user submits a subscription renewal, `status` MUST transition back to `'PENDING'` with `feedAccess == false` and `autoTradeEnabled == false`.
4. **PII Isolation Invariant**: Phone numbers, normalized phone numbers, password hashes, email addresses, and broker bridge URLs are strictly isolated in `/users/{userId}/private/{docId}`, readable and writable ONLY by the owning user (`isOwner(userId)`) or `isAdmin()`. No blanket `isSignedIn()` reads exist anywhere.
5. **Temporal & Immutable Field Invariant**: `ownerId`, `appUserId`, and `createdAt` are immutable after creation. `createdAt == request.time` on create and `updatedAt == request.time` on every write.
6. **Parent Master Gate & Atomicity**: Subcollection records (`/private`, `/trades`, `/payments`) require the parent `/users/{userId}` document to exist (`exists(...)` or `existsAfter(...)` inside atomic batch writes).
7. **Volumetric Guard Invariant**: Every string field has an explicit `.size()` upper bound and every list field (`settings.newsEvents`) is capped (`size() <= 30`) to prevent Denial-of-Wallet storage abuse.
8. **Admin Master Config Isolation Invariant**: `/adminConfig/master` holds encrypted Master TickerAll proxy feed configuration and `desiredConnected` state; it is readable and writable ONLY by `isAdmin()` and NEVER readable or writable by regular users or anonymous callers. Public `/config/public` contains only MoMo payment numbers and plan pricing (zero PII or keys) so signup and cold-start hydration always remain served.

## 2. The "Dirty Dozen" Adversarial Payloads

| # | Attack Vector | Target Path | Adversarial Payload Summary | Expected Outcome |
|---|--------------|-------------|----------------------------|------------------|
| 1 | Unauthenticated Read | `/users/uidA` | Anonymous `getDoc` (`request.auth == null`) | `PERMISSION_DENIED` |
| 2 | Unverified Email Write | `/users/uidA` | `email_verified: false` attempting `setDoc` | `PERMISSION_DENIED` |
| 3 | Self-Approval Escalation on Create | `/users/uidA` | `{ ownerId: 'uidA', status: 'ACTIVE', feedAccess: true, approvedAt: '2026-01-01', ... }` | `PERMISSION_DENIED` |
| 4 | Cross-User Identity Spoof | `/users/uidB` | Authenticated as `uidA`, creating `{ ownerId: 'uidA' }` under `/users/uidB` | `PERMISSION_DENIED` |
| 5 | Shadow / Ghost Field Injection | `/users/uidA` | Valid fields plus `{ isAdmin: true, vipBypass: true }` | `PERMISSION_DENIED` |
| 6 | Status Upgrade via Update | `/users/uidA` | Non-admin owner updating `status: 'ACTIVE'` and `feedAccess: true` | `PERMISSION_DENIED` |
| 7 | Client Timestamp Backdating | `/users/uidA` | Supplying custom `createdAt: Timestamp(2020-01-01)` instead of `serverTimestamp()` | `PERMISSION_DENIED` |
| 8 | Blocked Account State Bypass | `/users/uidA` | Owner with `status == 'BLOCKED'` attempting to set `autoTradeEnabled: true` | `PERMISSION_DENIED` |
| 9 | Path Variable ID Poisoning | `/users/bad$id..with.dots` | Document ID violating `^[a-zA-Z0-9_\\-]+$` or exceeding 128 chars | `PERMISSION_DENIED` |
| 10 | PII Cross-Tenant Read | `/users/uidB/private/profile` | Authenticated `uidA` reading `uidB`'s phone and password hash | `PERMISSION_DENIED` |
| 11 | Unbounded Payload / String Flood | `/users/uidA/trades/t1` | `{ notes: 'A'.repeat(50000) }` or `newsEvents` array with 100 items | `PERMISSION_DENIED` |
| 12 | Blanket List Query Scraping | `/users` | Non-admin running unconstrained `getDocs(collection(db, 'users'))` | `PERMISSION_DENIED` |
| 13 | Non-Admin Master Config Read | `/adminConfig/master` | Verified regular trader reading Admin Master TickerAll config | `PERMISSION_DENIED` |

