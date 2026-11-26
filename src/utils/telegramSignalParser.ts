import type { ParsedTelegramSignal } from '../types/connectivity.ts';

const KNOWN_SYMBOLS = new Set([
  'XAUUSD',
  'XAGUSD',
  'EURUSD',
  'GBPUSD',
  'USDJPY',
  'USDCHF',
  'USDCAD',
  'AUDUSD',
  'NZDUSD',
  'EURJPY',
  'GBPJPY',
  'EURGBP',
  'EURAUD',
  'GBPAUD',
  'AUDJPY',
  'CADJPY',
  'CHFJPY',
  'EURCAD',
  'GBPCAD',
  'BTCUSD',
  'ETHUSD',
  'SOLUSD',
  'XRPUSD',
  'US30',
  'NAS100',
  'US100',
  'USTEC',
  'SPX500',
  'US500',
  'GER40',
  'DE40',
  'UK100',
  'WTI',
  'USOIL',
  'UKOIL',
]);

const SYMBOL_ALIASES: Record<string, string> = {
  GOLD: 'XAUUSD',
  XAU: 'XAUUSD',
  SILVER: 'XAGUSD',
  BITCOIN: 'BTCUSD',
  BTC: 'BTCUSD',
  ETHEREUM: 'ETHUSD',
  ETH: 'ETHUSD',
  DOW: 'US30',
  DJ30: 'US30',
  NASDAQ: 'NAS100',
  NDX: 'NAS100',
};

const NON_SIGNAL_RECAP_PATTERNS = [
  /\btp\s*[123]?\s*(hit|smashed|done|reached|triggered|achieved|cleared)\b/i,
  /\b(hit|smashed|reached)\s*tp\s*[123]?\b/i,
  /\bsl\s*(hit|triggered)\b/i,
  /\b(stopped out|closed\s+(?:half|partial|all|in\s+profit)|book\s+profit|secure\s+profits?)\b/i,
  /\b(move|shift|trail)\s+sl\s+(?:to\s+)?(?:be|breakeven|entry)\b/i,
  /\b(?:running|floating)\s+\+?\d+\s*(?:pips?|pts|points)\b/i,
];

function extractPair(text: string): string | null {
  const upper = text.toUpperCase();

  // Check explicit slash or contiguous 6-7 char FX/Metal/Crypto symbols first
  const slashMatch = upper.match(/\b([A-Z]{3,5})\s*\/\s*([A-Z]{3,4})\b/);
  if (slashMatch) {
    const joined = `${slashMatch[1]}${slashMatch[2]}`;
    if (KNOWN_SYMBOLS.has(joined)) return joined;
    if (/^[A-Z]{6}$/.test(joined)) return joined;
  }

  const tokenMatches = upper.match(/\b[A-Z0-9]{3,8}\b/g) ?? [];
  for (const token of tokenMatches) {
    if (KNOWN_SYMBOLS.has(token)) {
      return token;
    }
    if (SYMBOL_ALIASES[token]) {
      return SYMBOL_ALIASES[token];
    }
  }

  // Fallback for generic 6-letter FX pairs paired with BUY/SELL (e.g., EURNZD)
  const fxNearby = upper.match(/\b([A-Z]{6})\b(?=\s+(?:BUY|SELL|LONG|SHORT)\b)|\b(?:BUY|SELL|LONG|SHORT)\s+([A-Z]{6})\b/);
  const candidate = fxNearby?.[1] || fxNearby?.[2] || null;
  if (candidate && candidate !== 'MARKET' && candidate !== 'SIGNAL' && candidate !== 'PROFIT') {
    return candidate;
  }

  return null;
}

function extractDirection(text: string): 'BUY' | 'SELL' | null {
  const hasBuy = /\b(BUY|LONG)\b/i.test(text);
  const hasSell = /\b(SELL|SHORT)\b/i.test(text);
  if (hasBuy && !hasSell) return 'BUY';
  if (hasSell && !hasBuy) return 'SELL';
  if (hasBuy && hasSell) {
    const buyIdx = text.search(/\b(BUY|LONG)\b/i);
    const sellIdx = text.search(/\b(SELL|SHORT)\b/i);
    return buyIdx <= sellIdx ? 'BUY' : 'SELL';
  }
  return null;
}

function parseNum(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replace(/,/g, '').trim();
  const n = Number(cleaned);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function extractSl(text: string): number | null {
  const m = text.match(/(?:stop\s*loss|\bsl)\s*[:=@\-]?\s*(\d+(?:[.,]\d+)?)/i);
  return parseNum(m?.[1]?.replace(',', '.'));
}

function extractTakeProfits(text: string): {
  tp1: number | null;
  tp2: number | null;
  tp3: number | null;
} {
  let tp1: number | null = null;
  let tp2: number | null = null;
  let tp3: number | null = null;

  const m1 = text.match(/(?:take\s*profit\s*1|\btp\s*1)\s*[:=@\-]?\s*(\d+(?:[.,]\d+)?)/i);
  const m2 = text.match(/(?:take\s*profit\s*2|\btp\s*2)\s*[:=@\-]?\s*(\d+(?:[.,]\d+)?)/i);
  const m3 = text.match(/(?:take\s*profit\s*3|\btp\s*3)\s*[:=@\-]?\s*(\d+(?:[.,]\d+)?)/i);

  tp1 = parseNum(m1?.[1]?.replace(',', '.'));
  tp2 = parseNum(m2?.[1]?.replace(',', '.'));
  tp3 = parseNum(m3?.[1]?.replace(',', '.'));

  // Handle single or multi-value `TP: 2658 / 2665 / 2675` or `TP 2658`
  if (tp1 === null && tp2 === null && tp3 === null) {
    const lineMatch = text.match(/(?:take\s*profit|\btp)\s*[:=@\-]?\s*([^\n\r]+)/i);
    if (lineMatch && lineMatch[1]) {
      const nums = (lineMatch[1].match(/\d+(?:[.,]\d+)?/g) ?? [])
        .map((token) => parseNum(token.replace(',', '.')))
        .filter((n): n is number => n !== null);
      if (nums.length >= 1) tp1 = nums[0];
      if (nums.length >= 2) tp2 = nums[1];
      if (nums.length >= 3) tp3 = nums[2];
    }
  }

  return { tp1, tp2, tp3 };
}

function extractEntry(text: string, pair: string | null): {
  entry: number | null;
  entryIsMarket: boolean;
} {
  const isMarketMentioned = /\b(NOW|CMP|MARKET\s*EXECUTION|AT\s*MARKET|CURRENT\s*PRICE)\b/i.test(
    text
  );

  // Explicit Entry: 2650 or Entry: 2648 - 2652
  const entryLabelMatch = text.match(
    /(?:entry\s*(?:price|zone)?|enter\s*(?:at|@|now)?|open\s*(?:at|@)?)\s*[:=@\-]?\s*(\d+(?:[.,]\d+)?)(?:\s*(?:-|to|–)\s*(\d+(?:[.,]\d+)?))?/i
  );
  if (entryLabelMatch) {
    const a = parseNum(entryLabelMatch[1]?.replace(',', '.'));
    const b = parseNum(entryLabelMatch[2]?.replace(',', '.'));
    if (a !== null && b !== null) {
      return {
        entry: Math.round(((a + b) / 2) * 100000) / 100000,
        entryIsMarket: isMarketMentioned,
      };
    }
    if (a !== null) {
      return { entry: a, entryIsMarket: isMarketMentioned };
    }
  }

  // Inline direction/pair entry: `XAUUSD BUY @ 2650` or `BUY XAUUSD 2650 - 2654` or `SELL EURUSD 1.0850`
  const inlineMatch = text.match(
    /\b(?:BUY|SELL|LONG|SHORT)\b(?:\s+[A-Z0-9/]{3,10})?\s*(?:@|AT)?\s*(\d+(?:[.,]\d+)?)(?:\s*(?:-|to|–)\s*(\d+(?:[.,]\d+)?))?/i
  );
  if (inlineMatch) {
    const a = parseNum(inlineMatch[1]?.replace(',', '.'));
    const b = parseNum(inlineMatch[2]?.replace(',', '.'));
    if (a !== null && b !== null) {
      return {
        entry: Math.round(((a + b) / 2) * 100000) / 100000,
        entryIsMarket: isMarketMentioned,
      };
    }
    if (a !== null) {
      return { entry: a, entryIsMarket: isMarketMentioned };
    }
  }

  if (pair) {
    const pairBuySell = text.match(
      new RegExp(
        `${pair.replace('/', '\\/?')}\\s+(?:BUY|SELL|LONG|SHORT)\\s*(?:@|AT)?\\s*(\\d+(?:[.,]\\d+)?)`,
        'i'
      )
    );
    const a = parseNum(pairBuySell?.[1]?.replace(',', '.'));
    if (a !== null) {
      return { entry: a, entryIsMarket: isMarketMentioned };
    }
  }

  return { entry: null, entryIsMarket: isMarketMentioned };
}

export function inferSymbolDigits(symbol: string): number {
  const upper = symbol.toUpperCase();
  if (upper.includes('JPY')) return 3;
  if (upper.includes('XAU') || upper.includes('GOLD')) return 2;
  if (upper.includes('BTC') || upper.includes('ETH') || upper.includes('US30') || upper.includes('NAS') || upper.includes('SPX') || upper.includes('GER')) {
    return 2;
  }
  if (upper.includes('XAG')) return 3;
  if (/^[A-Z]{6}$/.test(upper)) return 5;
  return 2;
}

export function parseTelegramSignal(rawText: string): ParsedTelegramSignal {
  const text = (rawText || '').slice(0, 4000).trim();
  if (!text) {
    return {
      isSignal: false,
      pair: null,
      direction: null,
      entry: null,
      sl: null,
      tp1: null,
      tp2: null,
      tp3: null,
      reason: 'Empty message',
      executionStatus: 'NOT_SIGNAL',
    };
  }

  for (const recapRe of NON_SIGNAL_RECAP_PATTERNS) {
    if (recapRe.test(text)) {
      return {
        isSignal: false,
        pair: extractPair(text),
        direction: extractDirection(text),
        entry: null,
        sl: null,
        tp1: null,
        tp2: null,
        tp3: null,
        reason: 'Trade update or recap message — not a new entry signal',
        executionStatus: 'NOT_SIGNAL',
      };
    }
  }

  const pair = extractPair(text);
  const direction = extractDirection(text);
  const sl = extractSl(text);
  const { tp1, tp2, tp3 } = extractTakeProfits(text);
  const { entry, entryIsMarket } = extractEntry(text, pair);

  if (!pair || !direction || sl === null || tp1 === null) {
    return {
      isSignal: false,
      pair,
      direction,
      entry,
      entryIsMarket,
      sl,
      tp1,
      tp2,
      tp3,
      reason: 'Normal channel message (missing pair, BUY/SELL direction, SL, or TP)',
      executionStatus: 'NOT_SIGNAL',
    };
  }

  // Validate directional geometry so malformed or opposite numbers never trigger trades
  const refPrice = entry;
  if (direction === 'BUY') {
    if (sl >= tp1) {
      return {
        isSignal: false,
        pair,
        direction,
        entry,
        entryIsMarket,
        sl,
        tp1,
        tp2,
        tp3,
        reason: 'Ignored malformed BUY levels (SL >= TP1)',
        executionStatus: 'NOT_SIGNAL',
      };
    }
    if (refPrice !== null && (sl >= refPrice || tp1 <= refPrice)) {
      return {
        isSignal: false,
        pair,
        direction,
        entry,
        entryIsMarket,
        sl,
        tp1,
        tp2,
        tp3,
        reason: 'Ignored inconsistent BUY entry/SL/TP geometry',
        executionStatus: 'NOT_SIGNAL',
      };
    }
  } else {
    if (sl <= tp1) {
      return {
        isSignal: false,
        pair,
        direction,
        entry,
        entryIsMarket,
        sl,
        tp1,
        tp2,
        tp3,
        reason: 'Ignored malformed SELL levels (SL <= TP1)',
        executionStatus: 'NOT_SIGNAL',
      };
    }
    if (refPrice !== null && (sl <= refPrice || tp1 >= refPrice)) {
      return {
        isSignal: false,
        pair,
        direction,
        entry,
        entryIsMarket,
        sl,
        tp1,
        tp2,
        tp3,
        reason: 'Ignored inconsistent SELL entry/SL/TP geometry',
        executionStatus: 'NOT_SIGNAL',
      };
    }
  }

  return {
    isSignal: true,
    pair,
    direction,
    entry,
    entryIsMarket: entry === null || entryIsMarket,
    sl,
    tp1,
    tp2,
    tp3,
    reason: `Parsed ${pair} ${direction} signal`,
    executionStatus: 'QUEUED',
  };
}
