import { GoogleGenAI, ThinkingLevel, Type } from '@google/genai';
import type {
  AiApprovalDecision,
  AiTradeApproval,
  DaySessionLevels,
  EmaStochasticProSnapshot,
  M15Candle,
  SessionPhase,
  StrategySettings,
  TradeSignal,
  UsdNewsEvent,
} from '../src/types/connectivity.ts';
import { mergeEmaProConfig } from '../src/utils/emaStochasticPro.ts';
import { round2 } from '../src/utils/strategyEngine.ts';

export const GEMINI_APPROVER_MODEL = 'gemini-4-hydrogen';

let cachedClientKey = '';
let cachedClient: GoogleGenAI | null = null;

function getGeminiClient(): GoogleGenAI | null {
  const apiKey = process.env.GEMINI_API_KEY?.trim() || '';
  if (!apiKey || apiKey === 'MY_GEMINI_API_KEY') {
    return null;
  }
  if (!cachedClient || cachedClientKey !== apiKey) {
    cachedClientKey = apiKey;
    cachedClient = new GoogleGenAI({
      apiKey,
      httpOptions: {
        headers: {
          'User-Agent': 'aistudio-build',
        },
      },
    });
  }
  return cachedClient;
}

export interface ReviewTradeWithGeminiParams {
  executionContext: 'AUTO' | 'MANUAL' | 'PRECHECK';
  lusakaDate: string;
  lusakaTime: string;
  lusakaWeekday: string;
  isWeekend: boolean;
  phase: SessionPhase;
  symbol: string;
  proposedSide: 'BUY' | 'SELL' | 'WAIT';
  entry: number | null;
  stop: number | null;
  tp1: number | null;
  tp2: number | null;
  tp3?: number | null;
  lots: number;
  accountBalance: number;
  settings: StrategySettings;
  levels: DaySessionLevels;
  emaPro?: EmaStochasticProSnapshot | null;
  activeSignal: TradeSignal;
  newsStatus: {
    clear: boolean;
    blockingEvent: UsdNewsEvent | null;
    minutesUntil: number | null;
  };
  currentCandle: M15Candle | null;
  recentClosedCandles: M15Candle[];
  dailyPnlPct: number;
  dailyGuardHit: boolean;
  openPositionsCount?: number;
  lastTickAtMs?: number | null;
  notes?: string;
}

export interface ReviewTradeResult {
  ok: boolean;
  errorCode?: 'MISSING_API_KEY' | 'UPSTREAM_ERROR' | 'INVALID_RESPONSE';
  approval: AiTradeApproval;
}

const EMA_PRO_SYSTEM_INSTRUCTION = `You are the Independent Senior Risk & Execution Approver AI for GOLD AI TRADER running the EMA STOCHASTIC PRO XAUUSD algorithmic desk (TickerAll MT5 master feed & user MT5 broker bridge across XM, Exness, Weltrade, and other MT5 brokers).
Evaluate the trade candidate objectively using measurable evidence across all criteria:
1. H1 major trend & EMA50 slope (note: Trend Continuation setups require H1 EMA50 vs EMA200 alignment; Reversal setups on Liquidity Sweep + confirmed CHoCH + Stoch cross + rejection close are explicitly VALID even before H1 EMA50 crosses EMA200)
2. M15 trend & market structure
3. M5 entry timing & pullback toward EMA 9 or EMA 21
4. EMA 9/21/50/200 alignment (reject flat/choppy EMA compression)
5. Stochastic (14,3,3) crossover timing (BUY prefers 20-50 cross or <20 oversold or valid trend-aligned ~50 cross; SELL prefers 50-80 cross or >80 overbought or valid trend-aligned ~50 cross)
6. Non-repainting SMC confirmation (Liquidity Sweep, BOS, CHoCH, Order Block, FVG — reversal setups require sweep + CHoCH; continuation setups require relevant bullish/bearish SMC structure; do NOT require all SMC elements simultaneously)
7. Confirmation candle strength on closed M5 candle
8. ATR(14) & market volatility
9. Spread filter compliance
10. High-impact USD news risk
11. Swing + ATR Stop-Loss distance suitability
12. Reward-to-Risk ratio (minimum 1:2 to TP2)
13. Existing open positions & daily/session risk limits

Return decision as ONE of:
- APPROVED (when confidence >= configured threshold and measurable evidence supports either a valid Continuation or valid Reversal setup with sound risk/R:R)
- REJECTED (contradicts setup structure, choppy/sideways EMAs, poor R:R, stale feed data, or risk breach)
- WAITING FOR CONFIRMATION (setup developing but awaiting stronger candle close, pullback, CHoCH, or Stoch crossover)

Never invent prices or certainty. Base confidencePct (0-100) strictly on evidence passed.`;

const APPROVAL_RESPONSE_SCHEMA = {
  type: Type.OBJECT,
  properties: {
    decision: {
      type: Type.STRING,
      description: 'Must be one of: APPROVED, REJECTED, WAITING FOR CONFIRMATION',
    },
    approved: {
      type: Type.BOOLEAN,
      description: 'True ONLY when decision is APPROVED.',
    },
    confidencePct: {
      type: Type.INTEGER,
      description: 'Measurable evidence confidence score from 0 to 100.',
    },
    summary: {
      type: Type.STRING,
      description: 'Plain-English 1-2 sentence explanation citing specific technical & risk evidence.',
    },
    ruleAudit: {
      type: Type.ARRAY,
      items: { type: Type.STRING },
      description: '5 to 8 concise audit bullets covering Setup Type, Trend/EMA, Stoch, SMC, Volatility/Spread, SL/R:R, and Risk Controls.',
    },
  },
  required: ['decision', 'approved', 'confidencePct', 'summary', 'ruleAudit'],
};

export function enforceHardRiskChecks(params: ReviewTradeWithGeminiParams): {
  hardStatus: AiApprovalDecision | null;
  reason: string | null;
} {
  const cfg = mergeEmaProConfig(params.settings.emaPro);
  const maxTradesPerDay = params.settings.maxTradesPerDay || 10;

  if (params.isWeekend) {
    return { hardStatus: 'REJECTED', reason: 'Market closed (Weekend)' };
  }
  if (!params.newsStatus.clear) {
    return {
      hardStatus: 'REJECTED',
      reason: `High-impact USD news blackout: ${params.newsStatus.blockingEvent?.title ?? 'News window'}`,
    };
  }
  if (params.dailyGuardHit) {
    return {
      hardStatus: 'REJECTED',
      reason: `Daily loss limit (${params.settings.dailyGuardPct}%) hit — AI cannot override hard risk controls`,
    };
  }
  if (params.levels.consecutiveLossesToday >= (params.settings.maxConsecutiveLosses || 3)) {
    return {
      hardStatus: 'REJECTED',
      reason: `Trading paused after ${params.levels.consecutiveLossesToday} consecutive losses`,
    };
  }
  if (params.levels.totalTradesToday >= maxTradesPerDay) {
    return {
      hardStatus: 'REJECTED',
      reason: `Max daily trades (${maxTradesPerDay}) reached`,
    };
  }
  if (params.accountBalance <= 0) {
    return {
      hardStatus: 'REJECTED',
      reason: 'Account equity/balance unavailable — trade blocked',
    };
  }
  if (params.proposedSide === 'WAIT' || params.entry === null || params.stop === null) {
    return {
      hardStatus: 'WAITING FOR CONFIRMATION',
      reason: 'No valid confirmed entry & stop loss candidate yet',
    };
  }
  if (
    params.lastTickAtMs &&
    Date.now() - params.lastTickAtMs > 180_000 &&
    params.executionContext === 'AUTO'
  ) {
    return {
      hardStatus: 'REJECTED',
      reason: 'Market feed data is stale (>3 minutes since last tick) — signal rejected',
    };
  }
  if ((params.openPositionsCount ?? 0) >= cfg.maxSimultaneousPositions) {
    return {
      hardStatus: 'REJECTED',
      reason: `Max simultaneous positions (${cfg.maxSimultaneousPositions}) reached`,
    };
  }
  const slDist = Math.abs(params.entry - params.stop);
  const tp2Dist = params.tp2 !== null ? Math.abs(params.tp2 - params.entry) : 0;
  const actualRr = slDist > 0 ? tp2Dist / slDist : 0;
  if (actualRr < cfg.minRewardRisk - 0.05) {
    return {
      hardStatus: 'REJECTED',
      reason: `Reward-to-risk (${actualRr.toFixed(2)}:1) is below configured minimum (${cfg.minRewardRisk}:1)`,
    };
  }
  if (params.emaPro?.spreadEvaluation) {
    const spEval = params.emaPro.spreadEvaluation;
    if (!spEval.dataAvailable || spEval.classification === 'DATA_UNAVAILABLE') {
      return {
        hardStatus: 'REJECTED',
        reason: `DATA UNAVAILABLE: ${spEval.reason} — AI cannot override quote-freshness safeguard`,
      };
    }
    if (spEval.classification === 'ABNORMAL' || spEval.classification === 'EXCESSIVE') {
      return {
        hardStatus: 'REJECTED',
        reason: `Spread classified as ${spEval.classification} (${spEval.spreadPoints?.toFixed(1) ?? '?'}p) — AI cannot override spread protection`,
      };
    }
    if (!spEval.tradePermitted) {
      return {
        hardStatus: 'REJECTED',
        reason: `Dynamic spread filter blocked trade [${spEval.classification}]: ${spEval.reason}`,
      };
    }
    if (
      spEval.costBreakdown &&
      spEval.costBreakdown.netRr !== null &&
      spEval.costBreakdown.netRr < cfg.minNetRewardRisk
    ) {
      return {
        hardStatus: 'REJECTED',
        reason: `Net R:R (${spEval.costBreakdown.netRr.toFixed(2)}:1) after transaction costs is below minimum (${cfg.minNetRewardRisk}:1)`,
      };
    }
  } else if (params.emaPro && !params.emaPro.spreadAllowed) {
    return {
      hardStatus: 'REJECTED',
      reason: `Spread (${params.emaPro.spreadPips}p) exceeds maximum ${cfg.maxSpreadPips}p`,
    };
  }
  if (params.emaPro && params.emaPro.marketCondition === 'LOW_DATA') {
    return {
      hardStatus: 'WAITING FOR CONFIRMATION',
      reason: 'Insufficient closed higher-timeframe candles (waiting for EMA-200 warmup)',
    };
  }
  return { hardStatus: null, reason: null };
}

export async function reviewTradeWithGeminiApprover(
  params: ReviewTradeWithGeminiParams
): Promise<ReviewTradeResult> {
  const nowIso = new Date().toISOString();
  const id = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
  const cfg = mergeEmaProConfig(params.settings.emaPro);
  const threshold = cfg.aiConfidenceThreshold;

  const slDistancePips =
    params.entry !== null && params.stop !== null
      ? round2(Math.abs(params.entry - params.stop) * 10)
      : null;

  // Hard non-overridable risk gate first
  const hardCheck = enforceHardRiskChecks(params);
  if (hardCheck.hardStatus) {
    return {
      ok: true,
      approval: {
        id,
        model: GEMINI_APPROVER_MODEL,
        timestamp: nowIso,
        lusakaTime: params.lusakaTime,
        side: params.proposedSide,
        symbol: params.symbol,
        entry: params.entry,
        stop: params.stop,
        tp1: params.tp1,
        tp2: params.tp2,
        tp3: params.tp3 ?? null,
        slDistancePips,
        status: hardCheck.hardStatus,
        approved: false,
        confidencePct: 0,
        summary: `${hardCheck.hardStatus}: ${hardCheck.reason}`,
        ruleAudit: [
          `Hard Risk Gate: ${hardCheck.reason}`,
          'Policy: AI cannot override risk, spread, news, or missing-data controls',
        ],
        errorMessage: null,
      },
    };
  }

  const client = getGeminiClient();
  if (!client) {
    return {
      ok: false,
      errorCode: 'MISSING_API_KEY',
      approval: {
        id,
        model: GEMINI_APPROVER_MODEL,
        timestamp: nowIso,
        lusakaTime: params.lusakaTime,
        side: params.proposedSide,
        symbol: params.symbol,
        entry: params.entry,
        stop: params.stop,
        tp1: params.tp1,
        tp2: params.tp2,
        tp3: params.tp3 ?? null,
        slDistancePips,
        status: 'ERROR',
        approved: false,
        confidencePct: 0,
        summary:
          'Gemini AI Trade Approver is unavailable because GEMINI_API_KEY is not configured in server secrets. Trade blocked (fail-closed).',
        ruleAudit: [
          'Gate Status: GEMINI_API_KEY missing in server environment',
          'Fail-Closed Policy: No trade executed without Gemini AI approval',
        ],
        errorMessage:
          'GEMINI_API_KEY is not configured on the server. Add GEMINI_API_KEY in AI Studio Secrets or disable Gemini AI Approver in Settings.',
      },
    };
  }

  const promptPayload = {
    strategyModule: 'EMA_STOCHASTIC_PRO',
    setupType: params.activeSignal.setupType ?? params.emaPro?.activeSetupType ?? null,
    setupLabel: params.activeSignal.setupLabel ?? null,
    executionContext: params.executionContext,
    confidenceThreshold: threshold,
    clock: {
      lusakaDate: params.lusakaDate,
      lusakaTime: params.lusakaTime,
      lusakaWeekday: params.lusakaWeekday,
      isWeekend: params.isWeekend,
      phase: params.phase,
    },
    news: {
      clear: params.newsStatus.clear,
      clearanceMinutes: params.settings.newsClearanceMins,
      blockingEvent: params.newsStatus.blockingEvent,
      minutesUntil: params.newsStatus.minutesUntil,
      newsFeedStatus: params.emaPro?.newsFeedStatus ?? 'CALENDAR_CONFIGURED',
    },
    accountAndLimits: {
      accountEquityUsd: params.accountBalance,
      riskPercent: params.settings.riskPercent,
      maxRiskPercent: cfg.maxRiskPercent,
      proposedLots: params.lots,
      openPositionsCount: params.openPositionsCount ?? 0,
      maxSimultaneousPositions: cfg.maxSimultaneousPositions,
      tradesToday: params.levels.totalTradesToday,
      maxTradesPerDay: params.settings.maxTradesPerDay || 10,
      consecutiveLossesToday: params.levels.consecutiveLossesToday,
      maxConsecutiveLosses: params.settings.maxConsecutiveLosses,
      dailyPnlPct: params.dailyPnlPct,
      dailyGuardHit: params.dailyGuardHit,
    },
    proposedOrder: {
      symbol: params.symbol,
      side: params.proposedSide,
      entry: params.entry,
      stop: params.stop,
      tp1: params.tp1,
      tp2: params.tp2,
      tp3: params.tp3 ?? null,
      slDistancePips,
      notes: params.notes || '',
    },
    emaStochasticProEvaluation: {
      overallTrend: params.emaPro?.overallTrend,
      marketCondition: params.emaPro?.marketCondition,
      activeSetupType: params.emaPro?.activeSetupType ?? null,
      h1: params.emaPro?.h1,
      m15: params.emaPro?.m15,
      m5: params.emaPro?.m5,
      m1: params.emaPro?.m1,
      stochNote: params.emaPro?.stochNote ?? null,
      m5Smc: params.emaPro?.smc,
      m15Smc: params.emaPro?.m15Smc ?? null,
      pullbackToEma: params.emaPro?.pullbackToEma,
      confirmationCandle: params.emaPro?.confirmationCandle,
      spreadPips: params.emaPro?.spreadPips,
      dynamicSpread: params.emaPro?.spreadEvaluation
        ? {
            classification: params.emaPro.spreadEvaluation.classification,
            spreadPoints: params.emaPro.spreadEvaluation.spreadPoints,
            bid: params.emaPro.spreadEvaluation.bid,
            ask: params.emaPro.spreadEvaluation.ask,
            digits: params.emaPro.symbolSpec?.digits ?? 2,
            pointSize: params.emaPro.symbolSpec?.pointSize ?? 0.01,
            stats1h: params.emaPro.spreadEvaluation.stats1h,
            stats24h: params.emaPro.spreadEvaluation.stats24h,
            costBreakdown: params.emaPro.spreadEvaluation.costBreakdown,
          }
        : null,
      atrPips: params.emaPro?.atrPips,
      engineSignalReason: params.activeSignal.reason,
      engineConditions: params.activeSignal.conditions,
    },
    currentCandle: params.currentCandle,
    recentClosedCandlesNewestFirst: params.recentClosedCandles.slice(0, 8),
  };

  try {
    const response = await client.models.generateContent({
      model: GEMINI_APPROVER_MODEL,
      contents: `Evaluate this XAUUSD EMA STOCHASTIC PRO trade candidate and return APPROVED, REJECTED, or WAITING FOR CONFIRMATION:\n${JSON.stringify(promptPayload, null, 2)}`,
      config: {
        systemInstruction: EMA_PRO_SYSTEM_INSTRUCTION,
        responseMimeType: 'application/json',
        responseSchema: APPROVAL_RESPONSE_SCHEMA,
        thinkingConfig: {
          thinkingLevel: ThinkingLevel.MEDIUM,
        },
        abortSignal: AbortSignal.timeout(25_000),
      },
    });

    const rawText = (response.text?.trim() || '')
      .replace(/^```(?:json)?\s*/i, '')
      .replace(/\s*```$/i, '')
      .trim();
    if (!rawText) {
      return {
        ok: false,
        errorCode: 'INVALID_RESPONSE',
        approval: {
          id,
          model: GEMINI_APPROVER_MODEL,
          timestamp: nowIso,
          lusakaTime: params.lusakaTime,
          side: params.proposedSide,
          symbol: params.symbol,
          entry: params.entry,
          stop: params.stop,
          tp1: params.tp1,
          tp2: params.tp2,
          tp3: params.tp3 ?? null,
          slDistancePips,
          status: 'ERROR',
          approved: false,
          confidencePct: 0,
          summary: 'Gemini AI Approver returned an empty response. Trade blocked (fail-closed).',
          ruleAudit: ['AI Response Error: Empty model output'],
          errorMessage: 'Empty response from Gemini AI Approver.',
        },
      };
    }

    const parsed = JSON.parse(rawText) as {
      decision?: unknown;
      approved?: unknown;
      confidencePct?: unknown;
      summary?: unknown;
      ruleAudit?: unknown;
    };

    const confidencePct =
      typeof parsed.confidencePct === 'number' && Number.isFinite(parsed.confidencePct)
        ? Math.max(0, Math.min(100, Math.round(parsed.confidencePct)))
        : 0;

    const rawDec = String(parsed.decision ?? '').toUpperCase().trim();
    let decision: AiApprovalDecision =
      rawDec === 'WAITING FOR CONFIRMATION'
        ? 'WAITING FOR CONFIRMATION'
        : rawDec === 'APPROVED' || parsed.approved === true
          ? 'APPROVED'
          : 'REJECTED';

    // Threshold enforcement
    if (decision === 'APPROVED' && confidencePct < threshold) {
      decision = 'WAITING FOR CONFIRMATION';
    }
    const approved = decision === 'APPROVED' && params.proposedSide !== 'WAIT';

    const summary =
      typeof parsed.summary === 'string' && parsed.summary.trim()
        ? parsed.summary.trim()
        : approved
          ? `Approved (${confidencePct}/100) — exceeds ${threshold}/100 threshold.`
          : `${decision} (${confidencePct}/100 vs ${threshold}/100 threshold).`;

    const ruleAudit = Array.isArray(parsed.ruleAudit)
      ? parsed.ruleAudit
          .filter((item): item is string => typeof item === 'string' && item.trim().length > 0)
          .slice(0, 8)
      : [];

    if (decision === 'WAITING FOR CONFIRMATION' && confidencePct < threshold && rawDec === 'APPROVED') {
      ruleAudit.unshift(`Confidence ${confidencePct}/100 below configured threshold ${threshold}/100`);
    }

    return {
      ok: true,
      approval: {
        id,
        model: GEMINI_APPROVER_MODEL,
        timestamp: nowIso,
        lusakaTime: params.lusakaTime,
        side: params.proposedSide,
        symbol: params.symbol,
        entry: params.entry,
        stop: params.stop,
        tp1: params.tp1,
        tp2: params.tp2,
        tp3: params.tp3 ?? null,
        slDistancePips,
        status: decision,
        approved,
        confidencePct,
        summary,
        ruleAudit,
        errorMessage: null,
      },
    };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : 'Unknown Gemini API error';
    return {
      ok: false,
      errorCode: 'UPSTREAM_ERROR',
      approval: {
        id,
        model: GEMINI_APPROVER_MODEL,
        timestamp: nowIso,
        lusakaTime: params.lusakaTime,
        side: params.proposedSide,
        symbol: params.symbol,
        entry: params.entry,
        stop: params.stop,
        tp1: params.tp1,
        tp2: params.tp2,
        tp3: params.tp3 ?? null,
        slDistancePips,
        status: 'ERROR',
        approved: false,
        confidencePct: 0,
        summary: `Gemini AI Approver request failed (${errMsg}). Trade blocked (fail-closed).`,
        ruleAudit: [`Upstream Gemini Error: ${errMsg}`],
        errorMessage: errMsg,
      },
    };
  }
}
