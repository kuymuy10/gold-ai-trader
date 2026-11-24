import { useState, useMemo } from 'react';
import { Download, Search, Trash2 } from 'lucide-react';
import type { ConnectionSnapshot, DiagnosticLog } from '../types/connectivity';

interface DiagnosticsLogViewProps {
  snapshot: ConnectionSnapshot;
  onClearLogs: () => Promise<void>;
  onRunProbe: () => Promise<void>;
}

type SeverityFilter = 'all' | DiagnosticLog['level'];

export function DiagnosticsLogView({
  snapshot,
  onClearLogs,
  onRunProbe,
}: DiagnosticsLogViewProps) {
  const [filter, setFilter] = useState<SeverityFilter>('all');
  const [query, setQuery] = useState('');

  const filteredLogs = useMemo(() => {
    const q = query.trim().toLowerCase();
    return snapshot.logs.filter((log) => {
      if (filter !== 'all' && log.level !== filter) return false;
      if (!q) return true;
      return (
        log.event.toLowerCase().includes(q) ||
        log.detail.toLowerCase().includes(q) ||
        log.endpoint.toLowerCase().includes(q)
      );
    });
  }, [snapshot.logs, filter, query]);

  const handleExportProfile = () => {
    const exportBundle = {
      exportedAt: new Date().toISOString(),
      platform: 'Gold Master',
      connectionConfig: snapshot.config,
      metrics: {
        packetsReceived: snapshot.packetsReceived,
        failedProbes: snapshot.failedProbes,
        avgLatencyMs: snapshot.avgLatencyMs,
      },
      recentLogs: snapshot.logs.slice(0, 40),
    };
    const blob = new Blob([JSON.stringify(exportBundle, null, 2)], {
      type: 'application/json',
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `gold-master-connection-${snapshot.config.adapterId}.json`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const levelMeta: Record<
    DiagnosticLog['level'],
    { label: string; colorClass: string }
  > = {
    info: { label: 'Info', colorClass: 'text-slate-300' },
    success: { label: 'Verified', colorClass: 'text-emerald-400' },
    warning: { label: 'Warning', colorClass: 'text-amber-400' },
    error: { label: 'Error', colorClass: 'text-red-400' },
  };

  return (
    <section className="border border-white/8 bg-[#111722] rounded-lg overflow-hidden">
      <div className="p-5 border-b border-white/8 flex flex-wrap items-center justify-between gap-4">
        <div>
          <h2 className="text-base font-semibold text-slate-100">
            Handshake & Transport Diagnostics
          </h2>
          <p className="mt-0.5 text-xs text-slate-400">
            Server-side HTTP probe audit trail, status codes, and normalization events.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <button
            type="button"
            onClick={handleExportProfile}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-white/15 bg-[#0E131D] text-slate-200 hover:bg-white/5 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Download className="w-3.5 h-3.5" />
            Export Profile JSON
          </button>
          <button
            type="button"
            onClick={onClearLogs}
            disabled={snapshot.logs.length === 0}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium border border-white/15 bg-[#0E131D] text-slate-300 hover:text-red-300 hover:border-red-500/30 disabled:opacity-40 rounded-md transition-colors whitespace-nowrap shrink-0"
          >
            <Trash2 className="w-3.5 h-3.5" />
            Clear Log
          </button>
        </div>
      </div>

      {/* Filter & Search Toolbar */}
      <div className="px-5 py-3 bg-[#0E131D] border-b border-white/8 flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-1 p-1 bg-[#0B0F17] border border-white/8 rounded-md">
          {(['all', 'success', 'warning', 'error', 'info'] as SeverityFilter[]).map(
            (sev) => (
              <button
                key={sev}
                type="button"
                onClick={() => setFilter(sev)}
                className={`px-2.5 py-1 text-xs font-medium rounded transition-colors capitalize whitespace-nowrap shrink-0 ${
                  filter === sev
                    ? 'bg-[#D4A853] text-[#0B0F17]'
                    : 'text-slate-400 hover:text-slate-200'
                }`}
              >
                {sev}
              </button>
            )
          )}
        </div>

        <div className="relative w-full sm:w-64">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2 pointer-events-none" />
          <input
            type="search"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter endpoint or event..."
            className="w-full pl-8 pr-3 py-1.5 text-xs bg-[#0B0F17] border border-white/10 rounded-md text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-[#D4A853]"
          />
        </div>
      </div>

      {filteredLogs.length === 0 ? (
        <div className="p-12 text-center">
          <p className="text-sm font-medium text-slate-200">
            {snapshot.logs.length === 0
              ? 'No diagnostic events recorded yet'
              : 'No events match your current filter'}
          </p>
          <p className="mt-1 text-xs text-slate-400">
            {snapshot.logs.length === 0
              ? 'Execute a handshake probe to inspect server HTTP timings and responses.'
              : 'Reset the severity filter or clear the search query.'}
          </p>
          {snapshot.logs.length === 0 && (
            <button
              type="button"
              onClick={onRunProbe}
              className="mt-4 px-4 py-2 text-xs font-medium rounded-md bg-[#D4A853] text-[#0B0F17] hover:bg-[#E0B866] transition-colors whitespace-nowrap shrink-0"
            >
              Run Handshake Probe
            </button>
          )}
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="border-b border-white/8 text-[11px] font-medium text-slate-400 bg-[#0E131D]">
                <th className="py-2.5 px-4">Timestamp</th>
                <th className="py-2.5 px-4">Severity</th>
                <th className="py-2.5 px-4">Event</th>
                <th className="py-2.5 px-4 text-right">HTTP</th>
                <th className="py-2.5 px-4 text-right">Latency</th>
                <th className="py-2.5 px-4">Detail</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/6 text-xs">
              {filteredLogs.map((log) => (
                <tr
                  key={log.id}
                  className="h-[40px] hover:bg-white/[0.03] transition-colors"
                >
                  <td className="px-4 font-mono tabular-nums text-slate-400 whitespace-nowrap">
                    {new Date(log.timestamp).toLocaleTimeString([], {
                      hour12: false,
                    })}
                  </td>
                  <td
                    className={`px-4 font-medium whitespace-nowrap ${
                      levelMeta[log.level].colorClass
                    }`}
                  >
                    {levelMeta[log.level].label}
                  </td>
                  <td className="px-4 font-medium text-slate-200 whitespace-nowrap">
                    {log.event}
                  </td>
                  <td className="px-4 text-right font-mono tabular-nums text-slate-300">
                    {log.httpStatus ?? '—'}
                  </td>
                  <td className="px-4 text-right font-mono tabular-nums text-slate-300 whitespace-nowrap">
                    {log.latencyMs !== null ? `${log.latencyMs.toFixed(1)} ms` : '—'}
                  </td>
                  <td
                    className="px-4 text-slate-400 max-w-md truncate"
                    title={log.detail}
                  >
                    {log.detail}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
