import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface FirebaseConfigJson {
  projectId: string;
  appId: string;
  apiKey: string;
  authDomain: string;
  firestoreDatabaseId: string;
  storageBucket?: string;
  messagingSenderId?: string;
}

export interface VerifiedFirebaseToken {
  uid: string;
  email: string;
  emailVerified: boolean;
  name: string;
}

const CERTS_URL =
  'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';

let cachedCerts: Record<string, string> = {};
let certsExpiresAtMs = 0;

export function loadFirebaseConfig(): FirebaseConfigJson | null {
  try {
    const cfgPath = path.resolve(process.cwd(), 'firebase-applet-config.json');
    if (!fs.existsSync(cfgPath)) return null;
    const raw = fs.readFileSync(cfgPath, 'utf8');
    const parsed = JSON.parse(raw) as FirebaseConfigJson;
    if (!parsed?.projectId || parsed.projectId === 'remixed-project-id') return null;
    return parsed;
  } catch {
    return null;
  }
}

async function getGooglePublicCerts(): Promise<Record<string, string>> {
  const now = Date.now();
  if (now < certsExpiresAtMs && Object.keys(cachedCerts).length > 0) {
    return cachedCerts;
  }
  const resp = await fetch(CERTS_URL);
  if (!resp.ok) {
    throw new Error(`Failed to fetch Firebase public certificates (${resp.status})`);
  }
  const json = (await resp.json()) as Record<string, string>;
  const cc = resp.headers.get('cache-control') || '';
  const maxAgeMatch = cc.match(/max-age=(\d+)/i);
  const maxAgeSec = maxAgeMatch ? Math.max(60, Number(maxAgeMatch[1])) : 3600;
  cachedCerts = json;
  certsExpiresAtMs = now + maxAgeSec * 1000;
  return json;
}

function decodeBase64UrlJson<T>(segment: string): T {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return JSON.parse(Buffer.from(padded, 'base64').toString('utf8')) as T;
}

function decodeBase64UrlBuffer(segment: string): Buffer {
  const normalized = segment.replace(/-/g, '+').replace(/_/g, '/');
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4);
  return Buffer.from(padded, 'base64');
}

export async function verifyFirebaseIdToken(idToken: string): Promise<VerifiedFirebaseToken> {
  const cfg = loadFirebaseConfig();
  if (!cfg) {
    throw new Error('Firebase configuration is missing or unprovisioned.');
  }
  const parts = (idToken || '').trim().split('.');
  if (parts.length !== 3) {
    throw new Error('Malformed Firebase ID token.');
  }
  const [headerB64, payloadB64, sigB64] = parts;
  const header = decodeBase64UrlJson<{ alg?: string; kid?: string }>(headerB64);
  const payload = decodeBase64UrlJson<{
    aud?: string;
    iss?: string;
    sub?: string;
    exp?: number;
    iat?: number;
    auth_time?: number;
    email?: string;
    email_verified?: boolean;
    name?: string;
  }>(payloadB64);

  if (header.alg !== 'RS256' || !header.kid) {
    throw new Error('Unsupported Firebase token header.');
  }
  const certs = await getGooglePublicCerts();
  let cert = certs[header.kid];
  if (!cert) {
    certsExpiresAtMs = 0;
    const refreshed = await getGooglePublicCerts();
    cert = refreshed[header.kid];
  }
  if (!cert) {
    throw new Error('Unable to find matching Google signing certificate.');
  }

  const verifier = crypto.createVerify('RSA-SHA256');
  verifier.update(`${headerB64}.${payloadB64}`);
  verifier.end();
  const signatureOk = verifier.verify(cert, decodeBase64UrlBuffer(sigB64));
  if (!signatureOk) {
    throw new Error('Invalid Firebase ID token signature.');
  }

  const nowSec = Math.floor(Date.now() / 1000);
  const expectedIssuer = `https://securetoken.google.com/${cfg.projectId}`;
  if (payload.aud !== cfg.projectId) {
    throw new Error('Firebase token audience mismatch.');
  }
  if (payload.iss !== expectedIssuer) {
    throw new Error('Firebase token issuer mismatch.');
  }
  if (!payload.sub || typeof payload.sub !== 'string' || payload.sub.length > 128) {
    throw new Error('Firebase token missing subject.');
  }
  if (typeof payload.exp !== 'number' || payload.exp <= nowSec) {
    throw new Error('Firebase ID token expired.');
  }
  if (typeof payload.iat !== 'number' || payload.iat > nowSec + 300) {
    throw new Error('Firebase ID token issued in the future.');
  }
  if (typeof payload.auth_time === 'number' && payload.auth_time > nowSec + 300) {
    throw new Error('Firebase ID token auth_time invalid.');
  }

  return {
    uid: payload.sub,
    email: typeof payload.email === 'string' ? payload.email : '',
    emailVerified: payload.email_verified === true,
    name: typeof payload.name === 'string' ? payload.name : '',
  };
}

type FirestoreRestValue = {
  nullValue?: null;
  booleanValue?: boolean;
  integerValue?: string;
  doubleValue?: number;
  timestampValue?: string;
  stringValue?: string;
  arrayValue?: { values?: FirestoreRestValue[] };
  mapValue?: { fields?: Record<string, FirestoreRestValue> };
};

export function decodeFirestoreValue(val: FirestoreRestValue | undefined): unknown {
  if (!val || typeof val !== 'object') return undefined;
  if ('nullValue' in val) return null;
  if ('booleanValue' in val) return Boolean(val.booleanValue);
  if ('integerValue' in val) return Number(val.integerValue);
  if ('doubleValue' in val) return Number(val.doubleValue);
  if ('timestampValue' in val) return String(val.timestampValue || '');
  if ('stringValue' in val) return String(val.stringValue ?? '');
  if ('arrayValue' in val) {
    return (val.arrayValue?.values || []).map((item) => decodeFirestoreValue(item));
  }
  if ('mapValue' in val) {
    const out: Record<string, unknown> = {};
    const fields = val.mapValue?.fields || {};
    for (const [k, v] of Object.entries(fields)) {
      out[k] = decodeFirestoreValue(v);
    }
    return out;
  }
  return undefined;
}

export function decodeFirestoreDocumentFields(
  docJson: { fields?: Record<string, FirestoreRestValue> } | null | undefined
): Record<string, unknown> | null {
  if (!docJson || !docJson.fields) return null;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(docJson.fields)) {
    out[k] = decodeFirestoreValue(v);
  }
  return out;
}

export async function fetchFirestoreDocWithUserToken(
  docPath: string,
  idToken: string
): Promise<Record<string, unknown> | null> {
  const cfg = loadFirebaseConfig();
  if (!cfg) return null;
  const dbId = cfg.firestoreDatabaseId || '(default)';
  const cleanPath = docPath.replace(/^\/+/, '');
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    cfg.projectId
  )}/databases/${encodeURIComponent(dbId)}/documents/${cleanPath}`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  });
  if (resp.status === 404) return null;
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Firestore REST GET ${cleanPath} failed (${resp.status}): ${errText}`);
  }
  const json = (await resp.json()) as { fields?: Record<string, FirestoreRestValue> };
  return decodeFirestoreDocumentFields(json);
}

export async function fetchFirestoreCollectionWithUserToken(
  collectionPath: string,
  idToken: string
): Promise<Array<{ id: string; data: Record<string, unknown> }>> {
  const cfg = loadFirebaseConfig();
  if (!cfg) return [];
  const dbId = cfg.firestoreDatabaseId || '(default)';
  const cleanPath = collectionPath.replace(/^\/+/, '');
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    cfg.projectId
  )}/databases/${encodeURIComponent(dbId)}/documents/${cleanPath}?pageSize=100`;

  const resp = await fetch(url, {
    headers: {
      Authorization: `Bearer ${idToken}`,
    },
  });
  if (resp.status === 404) return [];
  if (!resp.ok) {
    const errText = await resp.text().catch(() => '');
    throw new Error(`Firestore REST LIST ${cleanPath} failed (${resp.status}): ${errText}`);
  }
  const json = (await resp.json()) as {
    documents?: Array<{ name?: string; fields?: Record<string, FirestoreRestValue> }>;
  };
  const results: Array<{ id: string; data: Record<string, unknown> }> = [];
  for (const d of json.documents || []) {
    const data = decodeFirestoreDocumentFields(d);
    if (!data) continue;
    const id = (d.name || '').split('/').pop() || '';
    if (id) results.push({ id, data });
  }
  return results;
}

export async function fetchPublicFirestoreDoc(
  docPath: 'config/public'
): Promise<Record<string, unknown> | null> {
  const cfg = loadFirebaseConfig();
  if (!cfg) return null;
  const dbId = cfg.firestoreDatabaseId || '(default)';
  const url = `https://firestore.googleapis.com/v1/projects/${encodeURIComponent(
    cfg.projectId
  )}/databases/${encodeURIComponent(dbId)}/documents/${docPath}`;

  const resp = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (resp.status === 404 || resp.status === 403) return null;
  if (!resp.ok) return null;
  const json = (await resp.json()) as { fields?: Record<string, FirestoreRestValue> };
  return decodeFirestoreDocumentFields(json);
}

