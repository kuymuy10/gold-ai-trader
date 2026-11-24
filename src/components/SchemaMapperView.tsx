import { useState, useEffect } from 'react';
import { Check, Copy, Plus, Trash2, FlaskConical, Save } from 'lucide-react';
import type {
  ConnectionConfig,
  ConnectionSnapshot,
  MappingEvaluation,
  SchemaMapping,
  SymbolBinding,
} from '../types/connectivity';

interface SchemaMapperViewProps {
  snapshot: ConnectionSnapshot;
  isSaving: boolean;
  onSaveConfig: (next: Partial<ConnectionConfig>) => Promise<void>;
  onRunProbe: () => Promise<void>;
}

const PATH_FIELDS: Array<{
  key: keyof SchemaMapping;
  label: string;
  placeholder: string;
  required?: boolean;
}> = [
  { key: 'symbolPath', label: 'Symbol Identifier Path', placeholder: 'data.symbol' },
  {
    key: 'pricePath',
    label: 'Last / Spot Price Path',
    placeholder: 'data.last',
    required: true,
  },
  { key: 'bidPath', label: 'Bid Price Path', placeholder: 'data.bid' },
  { key: 'askPath', label: 'Ask Price Path', placeholder: 'data.ask' },
  { key: 'volumePath', label: '24h Volume Path', placeholder: 'data.volume' },
  {
    key: 'change24hPath',
    label: '24h Change / Prev Close Path',
    placeholder: 'data.change_pct',
  },
  { key: 'timestampPath', label: 'Upstream Timestamp Path', placeholder: 'data.timestamp' },
];

export function SchemaMapperView({
  snapshot,
  isSaving,
  onSaveConfig,
  onRunProbe,
}: SchemaMapperViewProps) {
  const [mapping, setMapping] = useState<SchemaMapping>(
    snapshot.config.schemaMapping
  );
  const [bindings, setBindings] = useState<SymbolBinding[]>(
    snapshot.config.symbolBindings
  );
  const [evaluations, setEvaluations] = useState<MappingEvaluation[]>([]);
  const [evalError, setEvalError] = useState<string | null>(null);
  const [isEvaluating, setIsEvaluating] = useState(false);
  const [copied, setCopied] = useState(false);

  const [newInternal, setNewInternal] = useState('');
  const [newUpstream, setNewUpstream] = useState('');
  const [newUnit, setNewUnit] = useState('1 troy oz');

  useEffect(() => {
    setMapping(snapshot.config.schemaMapping);
    setBindings(snapshot.config.symbolBindings);
  }, [snapshot.config.schemaMapping, snapshot.config.symbolBindings]);

  const handleEvaluate = async () => {
    setIsEvaluating(true);
    setEvalError(null);
    try {
      const res = await fetch('/api/connections/test-mapping', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mapping }),
      });
      const data = await res.json();
      if (!res.ok || !data.ok) {
        setEvalError(data.error || 'Could not evaluate mapping.');
      } else {
        setEvaluations(data.evaluations);
      }
    } catch (err) {
      setEvalError(err instanceof Error ? err.message : 'Request failed');
    } finally {
      setIsEvaluating(false);
    }
  };

  const handleSave = async () => {
    await onSaveConfig({
      schemaMapping: mapping,
      symbolBindings: bindings,
    });
  };

  const handleToggleBinding = (index: number) => {
    setBindings((prev) =>
      prev.map((b, i) => (i === index ? { ...b, enabled: !b.enabled } : b))
    );
  };

  const handleRemoveBinding = (index: number) => {
    setBindings((prev) => prev.filter((_, i) => i !== index));
  };

  const handleAddBinding = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newInternal.trim() || !newUpstream.trim()) return;
    setBindings((prev) => [
      ...prev,
      {
        internalSymbol: newInternal.trim().toUpperCase(),
        upstreamSymbol: newUpstream.trim(),
        contractUnit: newUnit.trim() || '1 troy oz',
        tickSize: 0.01,
        enabled: true,
      },
    ]);
    setNewInternal('');
    setNewUpstream('');
  };

  const activePayloadTick = snapshot.latestTick ?? snapshot.fallbackTick;
  const rawPayloadText = activePayloadTick?.rawPayload
    ? JSON.stringify(activePayloadTick.rawPayload, null, 2)
    : null;

  const handleCopyPayload = async () => {
    if (!rawPayloadText) return;
    try {
      await navigator.clipboard.writeText(rawPayloadText);
      setCopied(true);
      setTimeout(() => setCopied(false), 1800);
    } catch {
      // Clipboard blocked in restricted context
    }
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6 items-start">
        {/* Left: JSON Path Normalization Mapping */}
        <section className="lg:col-span-6 border border-white/8 bg-[#111722] rounded-lg p-5">
          <div className="pb-4 border-b border-white/8 flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Payload Field Mapping
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                Map dot-notation JSON paths from TickerAll responses into Gold Master quote fields.
              </p>
            </div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={handleEvaluate}
                disabled={isEvaluating}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-[#D4A853]/40 bg-[#D4A853]/10 text-[#E5B85C] hover:bg-[#D4A853]/20 transition-colors whitespace-nowrap shrink-0"
              >
                <FlaskConical className="w-3.5 h-3.5" />
                {isEvaluating ? 'Testing...' : 'Test Paths'}
              </button>
              <button
                type="button"
                onClick={handleSave}
                disabled={isSaving}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-md bg-[#D4A853] text-[#0B0F17] hover:bg-[#E0B866] transition-colors whitespace-nowrap shrink-0"
              >
                <Save className="w-3.5 h-3.5" />
                {isSaving ? 'Saving...' : 'Save Schema'}
              </button>
            </div>
          </div>

          <div className="mt-4 space-y-3">
            {PATH_FIELDS.map((field) => (
              <div
                key={field.key}
                className="grid grid-cols-1 sm:grid-cols-12 gap-2 items-center"
              >
                <label
                  htmlFor={`path-${field.key}`}
                  className="sm:col-span-5 text-xs text-slate-300"
                >
                  {field.label}
                  {field.required && (
                    <span className="text-[#D4A853] ml-1">*</span>
                  )}
                </label>
                <input
                  id={`path-${field.key}`}
                  type="text"
                  value={mapping[field.key]}
                  placeholder={field.placeholder}
                  onChange={(e) =>
                    setMapping((prev) => ({
                      ...prev,
                      [field.key]: e.target.value,
                    }))
                  }
                  className="sm:col-span-7 px-3 py-1.5 text-xs font-mono bg-[#0B0F17] border border-white/10 rounded-md text-slate-100 focus:outline-none focus:border-[#D4A853]"
                />
              </div>
            ))}
          </div>

          {evalError && (
            <div className="mt-4 p-3 rounded-md border border-amber-500/30 bg-amber-950/20 text-xs text-amber-200 flex items-center justify-between gap-3">
              <span>{evalError}</span>
              <button
                type="button"
                onClick={onRunProbe}
                className="px-2.5 py-1 text-xs font-medium bg-amber-500/20 hover:bg-amber-500/30 rounded text-amber-100 whitespace-nowrap shrink-0"
              >
                Run Probe
              </button>
            </div>
          )}

          {evaluations.length > 0 && (
            <div className="mt-5 border-t border-white/8 pt-4">
              <h3 className="text-xs font-semibold text-slate-200 mb-2.5">
                Live Path Extraction Verification
              </h3>
              <div className="overflow-x-auto border border-white/8 rounded-md">
                <table className="w-full text-left border-collapse text-xs">
                  <thead>
                    <tr className="bg-[#0E131D] border-b border-white/8 text-[11px] text-slate-400">
                      <th className="py-2 px-3">Field</th>
                      <th className="py-2 px-3">Extracted Value</th>
                      <th className="py-2 px-3 text-right">Validation</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-white/6 font-mono tabular-nums">
                    {evaluations.map((ev) => (
                      <tr key={ev.field} className="h-[36px]">
                        <td className="px-3 font-sans text-slate-300">
                          {ev.label}
                        </td>
                        <td className="px-3 text-slate-200 max-w-[200px] truncate">
                          {ev.parsedValue !== null ? String(ev.parsedValue) : '—'}
                        </td>
                        <td
                          className={`px-3 text-right font-sans font-medium ${
                            ev.valid ? 'text-emerald-400' : 'text-red-400'
                          }`}
                        >
                          {ev.valid ? 'Valid' : 'Missing'}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </section>

        {/* Right: Raw Captured Payload Inspector */}
        <section className="lg:col-span-6 border border-white/8 bg-[#111722] rounded-lg overflow-hidden">
          <div className="px-5 py-4 border-b border-white/8 flex items-center justify-between gap-4">
            <div>
              <h2 className="text-base font-semibold text-slate-100">
                Upstream Raw Payload Inspector
              </h2>
              <p className="mt-0.5 text-xs text-slate-400">
                {activePayloadTick
                  ? `Packet #${activePayloadTick.seq} · ${activePayloadTick.sourceLabel}${activePayloadTick.isFallback ? ' (Fallback)' : ''} · HTTP ${activePayloadTick.httpStatus}`
                  : 'Inspect exact JSON keys returned by the upstream API.'}
              </p>
            </div>
            {rawPayloadText && (
              <button
                type="button"
                onClick={handleCopyPayload}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-white/10 rounded-md text-slate-300 hover:text-white hover:bg-white/5 transition-colors whitespace-nowrap shrink-0"
              >
                {copied ? (
                  <>
                    <Check className="w-3.5 h-3.5 text-emerald-400" />
                    Copied
                  </>
                ) : (
                  <>
                    <Copy className="w-3.5 h-3.5" />
                    Copy JSON
                  </>
                )}
              </button>
            )}
          </div>

          {rawPayloadText ? (
            <pre className="p-4 text-xs font-mono text-slate-300 bg-[#0B0F17] overflow-auto max-h-[380px] leading-relaxed">
              {rawPayloadText}
            </pre>
          ) : (
            <div className="p-10 text-center">
              <p className="text-xs text-slate-400">
                No upstream response payload captured yet.
              </p>
              <button
                type="button"
                onClick={onRunProbe}
                className="mt-3 px-4 py-2 text-xs font-medium rounded-md bg-[#D4A853] text-[#0B0F17] hover:bg-[#E0B866] transition-colors whitespace-nowrap shrink-0"
              >
                Capture Sample Payload
              </button>
            </div>
          )}
        </section>
      </div>

      {/* Symbol Bindings Registry */}
      <section className="border border-white/8 bg-[#111722] rounded-lg overflow-hidden">
        <div className="px-5 py-4 border-b border-white/8 flex flex-wrap items-center justify-between gap-4">
          <div>
            <h2 className="text-base font-semibold text-slate-100">
              Gold Instrument Symbol Bindings
            </h2>
            <p className="mt-0.5 text-xs text-slate-400">
              Translate upstream TickerAll symbols into canonical Gold Master contract identifiers.
            </p>
          </div>
          <form
            onSubmit={handleAddBinding}
            className="flex flex-wrap items-center gap-2"
          >
            <input
              type="text"
              placeholder="Internal (e.g. XAU/EUR)"
              value={newInternal}
              onChange={(e) => setNewInternal(e.target.value)}
              className="px-3 py-1.5 text-xs font-mono bg-[#0B0F17] border border-white/10 rounded-md text-slate-100 w-36 focus:outline-none focus:border-[#D4A853]"
            />
            <input
              type="text"
              placeholder="Upstream (e.g. XAUEUR)"
              value={newUpstream}
              onChange={(e) => setNewUpstream(e.target.value)}
              className="px-3 py-1.5 text-xs font-mono bg-[#0B0F17] border border-white/10 rounded-md text-slate-100 w-36 focus:outline-none focus:border-[#D4A853]"
            />
            <input
              type="text"
              placeholder="Unit"
              value={newUnit}
              onChange={(e) => setNewUnit(e.target.value)}
              className="px-3 py-1.5 text-xs bg-[#0B0F17] border border-white/10 rounded-md text-slate-100 w-28 focus:outline-none focus:border-[#D4A853]"
            />
            <button
              type="submit"
              className="inline-flex items-center gap-1 px-3 py-1.5 text-xs font-medium rounded-md border border-white/15 bg-[#0E131D] text-slate-200 hover:bg-white/5 whitespace-nowrap shrink-0"
            >
              <Plus className="w-3.5 h-3.5" />
              Add Binding
            </button>
          </form>
        </div>

        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-[#0E131D] border-b border-white/8 text-[11px] font-medium text-slate-400">
                <th className="py-2.5 px-4">Canonical Symbol</th>
                <th className="py-2.5 px-4">Upstream TickerAll Key</th>
                <th className="py-2.5 px-4">Contract Unit</th>
                <th className="py-2.5 px-4 text-right">Min Tick</th>
                <th className="py-2.5 px-4 text-right">Routing State</th>
                <th className="py-2.5 px-4 text-right">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/6 text-xs">
              {bindings.map((binding, idx) => (
                <tr
                  key={`${binding.internalSymbol}-${idx}`}
                  className="h-[40px] hover:bg-white/[0.03]"
                >
                  <td className="px-4 font-mono font-medium text-slate-100">
                    {binding.internalSymbol}
                  </td>
                  <td className="px-4 font-mono text-slate-300">
                    {binding.upstreamSymbol}
                  </td>
                  <td className="px-4 text-slate-400">{binding.contractUnit}</td>
                  <td className="px-4 text-right font-mono tabular-nums text-slate-300">
                    {binding.tickSize.toFixed(2)}
                  </td>
                  <td className="px-4 text-right">
                    <button
                      type="button"
                      onClick={() => handleToggleBinding(idx)}
                      className={`text-xs font-medium ${
                        binding.enabled ? 'text-emerald-400' : 'text-slate-500'
                      }`}
                    >
                      {binding.enabled ? 'Active' : 'Paused'}
                    </button>
                  </td>
                  <td className="px-4 text-right">
                    <button
                      type="button"
                      aria-label={`Remove ${binding.internalSymbol}`}
                      onClick={() => handleRemoveBinding(idx)}
                      className="text-slate-400 hover:text-red-400 transition-colors p-1"
                    >
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>
    </div>
  );
}
