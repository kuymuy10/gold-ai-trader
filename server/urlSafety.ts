import net from 'node:net';

function isPrivateOrReservedIpv4(ip: string): boolean {
  const parts = ip.split('.').map((p) => Number(p));
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
    return true;
  }
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a >= 224) return true;
  return false;
}

function isPrivateOrReservedIpv6(ip: string): boolean {
  const normalized = ip.replace(/^\[|\]$/g, '').split('%')[0].toLowerCase();
  if (normalized === '::1' || normalized === '::' || normalized === '0:0:0:0:0:0:0:1') {
    return true;
  }
  if (normalized.startsWith('::ffff:')) {
    const mappedV4 = normalized.slice(7);
    if (net.isIPv4(mappedV4)) {
      return isPrivateOrReservedIpv4(mappedV4);
    }
  }
  if (normalized.startsWith('fc') || normalized.startsWith('fd') || normalized.startsWith('fe80')) {
    return true;
  }
  return false;
}

export function isSafeExternalUrl(rawUrl: string): { safe: boolean; reason?: string } {
  try {
    const parsed = new URL(rawUrl);
    if (
      parsed.protocol !== 'https:' &&
      parsed.protocol !== 'http:' &&
      parsed.protocol !== 'wss:' &&
      parsed.protocol !== 'ws:'
    ) {
      return { safe: false, reason: 'Only http(s) and ws(s) protocols are permitted.' };
    }
    const rawHost = parsed.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!rawHost) {
      return { safe: false, reason: 'Hostname is required.' };
    }
    if (
      rawHost === 'localhost' ||
      rawHost === '0.0.0.0' ||
      rawHost === 'metadata.google.internal' ||
      rawHost.endsWith('.internal') ||
      rawHost.endsWith('.local') ||
      rawHost.endsWith('.localhost')
    ) {
      return { safe: false, reason: 'Blocked local or internal metadata hostname.' };
    }
    const ipVersion = net.isIP(rawHost);
    if (ipVersion === 4 && isPrivateOrReservedIpv4(rawHost)) {
      return { safe: false, reason: 'Blocked private or loopback IPv4 address.' };
    }
    if (ipVersion === 6 && isPrivateOrReservedIpv6(rawHost)) {
      return { safe: false, reason: 'Blocked private or loopback IPv6 address.' };
    }
    return { safe: true };
  } catch {
    return { safe: false, reason: 'Invalid URL format.' };
  }
}
