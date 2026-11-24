import { AlertTriangle, CheckCircle2, Info, ShieldAlert } from 'lucide-react';
import type { BrokerAccountSetup, BrokerAccountVariant } from '../types/connectivity';

interface BrokerAccountSetupChecklistProps {
  setup: BrokerAccountSetup;
  onChange: (next: BrokerAccountSetup) => void;
  compact?: boolean;
}

const VARIANT_OPTIONS: Array<{
  id: BrokerAccountVariant;
  label: string;
  sublabel: string;
}> = [
  {
    id: 'STANDARD',
    label: 'Standard MT5 (USD)',
    sublabel: '1.00 lot = 100 oz · XM / Exness / Weltrade / Any MT5',
  },
  {
    id: 'CENT_USC',
    label: 'Cent MT5 (USC Cents)',
    sublabel: 'Weltrade Cent / Exness Cent · Balance & lot sizing in USC',
  },
  {
    id: 'CENT_USD',
    label: 'Cent / Micro MT5 (USD)',
    sublabel: '1.00 lot = 1 oz · XM Micro / Cent USD display',
  },
  {
    id: 'ECN_RAW',
    label: 'ECN / Raw / Zero / Pro (USD)',
    sublabel: '1.00 lot = 100 oz · Tight spread + commission/lot',
  },
];

export function isSetupValidClient(setup: BrokerAccountSetup): boolean {
  const hasWrong = Boolean(setup.hasWrongMt4OrCtrader || setup.hasWrongZmwOrEur);
  if (hasWrong) return false;
  return Boolean(
    setup.platformMt5 &&
      setup.accountStandard &&
      setup.currencyUsd &&
      setup.leverageValid
  );
}

export function BrokerAccountSetupChecklist({
  setup,
  onChange,
  compact = false,
}: BrokerAccountSetupChecklistProps) {
  const activeVariant: BrokerAccountVariant = setup.accountVariant ?? 'STANDARD';
  const hasWrongAccount = Boolean(setup.hasWrongMt4OrCtrader || setup.hasWrongZmwOrEur);
  const isComplete = isSetupValidClient(setup);

  const toggleValidField = (
    field: 'platformMt5' | 'accountStandard' | 'currencyUsd' | 'leverageValid',
    checked: boolean
  ) => {
    const next: BrokerAccountSetup = {
      ...setup,
      [field]: checked,
      hasWrongCentOrEcn: false,
    };
    if (checked) {
      if (field === 'platformMt5') next.hasWrongMt4OrCtrader = false;
      if (field === 'currencyUsd') next.hasWrongZmwOrEur = false;
    }
    onChange(next);
  };

  const selectVariant = (variant: BrokerAccountVariant) => {
    onChange({
      ...setup,
      accountVariant: variant,
      accountStandard: true,
      hasWrongCentOrEcn: false,
    });
  };

  const toggleWrongField = (
    field: 'hasWrongMt4OrCtrader' | 'hasWrongZmwOrEur',
    checked: boolean
  ) => {
    const next: BrokerAccountSetup = {
      ...setup,
      [field]: checked,
      hasWrongCentOrEcn: false,
    };
    if (checked) {
      if (field === 'hasWrongMt4OrCtrader') next.platformMt5 = false;
      if (field === 'hasWrongZmwOrEur') next.currencyUsd = false;
    }
    onChange(next);
  };

  return (
    <div className="p-4 rounded-lg border border-[#D4A853]/30 bg-[#0B0F17] space-y-3.5">
      <div className="flex flex-wrap items-center justify-between gap-2 border-b border-white/8 pb-2.5">
        <div>
          <h3 className="text-xs sm:text-sm font-semibold text-[#E5B85C]">
            MT5 Broker Account Setup (Required Before AUTO TRADE ON)
          </h3>
          <p className="text-[11px] text-slate-400 mt-0.5">
            Supports Demo &amp; Live accounts on XM, Exness, Weltrade (including Cent), and other MT5 brokers.
          </p>
        </div>
        <span
          className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded border text-[11px] font-semibold ${
            hasWrongAccount
              ? 'border-red-500/40 bg-red-950/30 text-red-300'
              : isComplete
                ? 'border-emerald-500/35 bg-emerald-500/10 text-emerald-300'
                : 'border-amber-500/35 bg-amber-500/10 text-amber-200'
          }`}
        >
          {hasWrongAccount ? (
            <>
              <ShieldAlert className="w-3.5 h-3.5" />
              Unsupported Platform / Currency
            </>
          ) : isComplete ? (
            <>
              <CheckCircle2 className="w-3.5 h-3.5" />
              Setup Complete
            </>
          ) : (
            <>
              <AlertTriangle className="w-3.5 h-3.5" />
              Setup Incomplete
            </>
          )}
        </span>
      </div>

      {/* Multi-Broker Compatibility Banner */}
      <div className="p-3 rounded-md border border-[#D4A853]/30 bg-[#D4A853]/10 flex items-start gap-2.5 text-xs text-[#E5B85C]">
        <Info className="w-4 h-4 shrink-0 mt-0.5" />
        <span>
          <strong>Supported MT5 Brokers:</strong> XM, Exness, Weltrade (Standard, Cent/Micro, Pro/Raw), and any MT5 broker in <strong>USD</strong> or <strong>USC Cents</strong>. Both <strong>Demo</strong> and <strong>Live</strong> accounts are supported.
        </span>
      </div>

      {hasWrongAccount && (
        <div
          role="alert"
          className="p-3 rounded-md border border-red-500/50 bg-red-950/40 flex items-start gap-2.5 text-xs text-red-200 font-semibold"
        >
          <ShieldAlert className="w-4 h-4 text-red-400 shrink-0 mt-0.5" />
          <span>
            Unsupported Platform or Currency — Please use an MT5 account (Standard, Cent/Micro, or ECN/Raw) denominated in USD or USC Cents.
          </span>
        </div>
      )}

      {/* 4-Item Checklist */}
      <div className={`grid grid-cols-1 ${compact ? '' : 'md:grid-cols-2'} gap-3 text-xs`}>
        {/* 1. Platform */}
        <div
          className={`p-3 rounded-md border space-y-2 ${
            setup.hasWrongMt4OrCtrader
              ? 'border-red-500/45 bg-red-950/20'
              : setup.platformMt5
                ? 'border-emerald-500/30 bg-emerald-950/10'
                : 'border-white/10 bg-[#111722]'
          }`}
        >
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={setup.platformMt5}
              onChange={(e) => toggleValidField('platformMt5', e.target.checked)}
              className="mt-0.5 accent-[#D4A853]"
            />
            <div>
              <div className="font-semibold text-slate-100">
                Platform: MT5 (MetaTrader 5)
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                MT4 / cTrader terminals are not supported
              </div>
            </div>
          </label>
          <label className="flex items-center gap-2 pl-6 text-[11px] text-slate-400 cursor-pointer hover:text-red-300">
            <input
              type="checkbox"
              checked={setup.hasWrongMt4OrCtrader}
              onChange={(e) => toggleWrongField('hasWrongMt4OrCtrader', e.target.checked)}
              className="accent-red-500"
            />
            <span>My account is MT4 / cTrader</span>
          </label>
        </div>

        {/* 2. Account Tier (Standard, Cent USC, Cent USD, ECN/Raw) */}
        <div
          className={`p-3 rounded-md border space-y-2 ${
            setup.accountStandard
              ? 'border-emerald-500/30 bg-emerald-950/10'
              : 'border-white/10 bg-[#111722]'
          }`}
        >
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={setup.accountStandard}
              onChange={(e) => toggleValidField('accountStandard', e.target.checked)}
              className="mt-0.5 accent-[#D4A853]"
            />
            <div className="flex-1">
              <div className="font-semibold text-slate-100">
                MT5 Account Type (Standard / Cent / ECN)
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                Contract size &amp; lot scaling automatically match your selected tier
              </div>
            </div>
          </label>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5 pl-6">
            {VARIANT_OPTIONS.map((opt) => {
              const selected = activeVariant === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => selectVariant(opt.id)}
                  className={`text-left px-2 py-1.5 rounded border transition-colors ${
                    selected
                      ? 'border-[#D4A853]/70 bg-[#D4A853]/15 text-[#E5B85C]'
                      : 'border-white/10 bg-[#0B0F17] text-slate-300 hover:border-white/25'
                  }`}
                >
                  <div className="text-[11px] font-semibold">{opt.label}</div>
                  <div className="text-[10px] text-slate-400 leading-tight">{opt.sublabel}</div>
                </button>
              );
            })}
          </div>
        </div>

        {/* 3. Currency */}
        <div
          className={`p-3 rounded-md border space-y-2 ${
            setup.hasWrongZmwOrEur
              ? 'border-red-500/45 bg-red-950/20'
              : setup.currencyUsd
                ? 'border-emerald-500/30 bg-emerald-950/10'
                : 'border-white/10 bg-[#111722]'
          }`}
        >
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={setup.currencyUsd}
              onChange={(e) => toggleValidField('currencyUsd', e.target.checked)}
              className="mt-0.5 accent-[#D4A853]"
            />
            <div>
              <div className="font-semibold text-slate-100">
                Currency: {activeVariant === 'CENT_USC' ? 'USC (US Cents) or USD' : 'USD (or USC on Cent)'}
              </div>
              <div className="text-[11px] text-slate-400 mt-0.5">
                USD Standard/ECN or USC Cents on Weltrade/Exness Cent accounts
              </div>
            </div>
          </label>
          <label className="flex items-center gap-2 pl-6 text-[11px] text-slate-400 cursor-pointer hover:text-red-300">
            <input
              type="checkbox"
              checked={setup.hasWrongZmwOrEur}
              onChange={(e) => toggleWrongField('hasWrongZmwOrEur', e.target.checked)}
              className="accent-red-500"
            />
            <span>My account base currency is ZMW / EUR / Other</span>
          </label>
        </div>

        {/* 4. Leverage */}
        <div
          className={`p-3 rounded-md border space-y-2 ${
            setup.leverageValid
              ? 'border-emerald-500/30 bg-emerald-950/10'
              : 'border-white/10 bg-[#111722]'
          }`}
        >
          <label className="flex items-start gap-2.5 cursor-pointer">
            <input
              type="checkbox"
              checked={setup.leverageValid}
              onChange={(e) => toggleValidField('leverageValid', e.target.checked)}
              className="mt-0.5 accent-[#D4A853]"
            />
            <div>
              <div className="font-semibold text-slate-100">
                Leverage: 1:200 to 1:2000+ (Recommended ≥ 1:500)
              </div>
              <div className="text-[11px] text-slate-300 mt-0.5">
                Sufficient margin leverage for Gold lot sizing across Standard &amp; Cent accounts.
              </div>
            </div>
          </label>
        </div>
      </div>

      {/* Balance Risk Note */}
      <div className="px-3 py-2 rounded border border-white/10 bg-[#111722] text-[11px] text-slate-300">
        {activeVariant === 'CENT_USC' || activeVariant === 'CENT_USD'
          ? 'Cent / Micro Mode: Small deposits ($5–$50 USD or 500–5,000 USC) can trade safely at low risk per trade.'
          : 'Recommended Standard account balance at 1% risk is $100+ USD (smaller balances can use a Cent account on Weltrade/Exness or risk-capped 0.01 lots).'}
      </div>

      {/* Explicit 4-Box Confirmation Strip */}
      <div className="p-3 rounded-md border border-white/10 bg-[#111722] space-y-2">
        <div className="text-xs font-semibold text-slate-200">
          I Confirm My Account Setup (All 4 must be ticked):
        </div>
        <div className="flex flex-wrap items-center gap-3 text-xs font-mono">
          <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-white/12 bg-[#0B0F17] cursor-pointer">
            <input
              type="checkbox"
              checked={setup.platformMt5}
              onChange={(e) => toggleValidField('platformMt5', e.target.checked)}
              className="accent-[#D4A853]"
            />
            <span className={setup.platformMt5 ? 'text-emerald-300 font-semibold' : 'text-slate-300'}>
              MT5
            </span>
          </label>
          <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-white/12 bg-[#0B0F17] cursor-pointer">
            <input
              type="checkbox"
              checked={setup.accountStandard}
              onChange={(e) => toggleValidField('accountStandard', e.target.checked)}
              className="accent-[#D4A853]"
            />
            <span className={setup.accountStandard ? 'text-emerald-300 font-semibold' : 'text-slate-300'}>
              {activeVariant === 'CENT_USC'
                ? 'Cent (USC)'
                : activeVariant === 'CENT_USD'
                  ? 'Cent (USD)'
                  : activeVariant === 'ECN_RAW'
                    ? 'ECN / Raw'
                    : 'Standard'}
            </span>
          </label>
          <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-white/12 bg-[#0B0F17] cursor-pointer">
            <input
              type="checkbox"
              checked={setup.currencyUsd}
              onChange={(e) => toggleValidField('currencyUsd', e.target.checked)}
              className="accent-[#D4A853]"
            />
            <span className={setup.currencyUsd ? 'text-emerald-300 font-semibold' : 'text-slate-300'}>
              {activeVariant === 'CENT_USC' ? 'USC / USD' : 'USD'}
            </span>
          </label>
          <label className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded border border-white/12 bg-[#0B0F17] cursor-pointer">
            <input
              type="checkbox"
              checked={setup.leverageValid}
              onChange={(e) => toggleValidField('leverageValid', e.target.checked)}
              className="accent-[#D4A853]"
            />
            <span className={setup.leverageValid ? 'text-emerald-300 font-semibold' : 'text-slate-300'}>
              Leverage ≥ 1:200
            </span>
          </label>
        </div>
      </div>
    </div>
  );
}
