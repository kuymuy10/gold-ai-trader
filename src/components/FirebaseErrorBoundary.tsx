import { Component, type ErrorInfo, type ReactNode } from 'react';
import { AlertTriangle, RefreshCw } from 'lucide-react';

interface Props {
  children: ReactNode;
}

interface State {
  hasError: boolean;
  errorMessage: string | null;
}

export class FirebaseErrorBoundary extends Component<Props, State> {
  state: State = {
    hasError: false,
    errorMessage: null,
  };

  static getDerivedStateFromError(error: Error): State {
    return {
      hasError: true,
      errorMessage: error.message || 'An unexpected application error occurred.',
    };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Gold AI Trader ErrorBoundary caught:', error, info);
  }

  render() {
    if (this.state.hasError) {
      let friendly = this.state.errorMessage || 'Unable to complete operation.';
      try {
        const parsed = JSON.parse(friendly) as { error?: string; operationType?: string; path?: string };
        if (parsed?.error) {
          friendly = `Database access error (${parsed.operationType || 'read/write'} on ${parsed.path || 'record'}): ${parsed.error}`;
        }
      } catch {
        // Non-JSON error message
      }

      return (
        <div className="min-h-screen bg-[#0B0F17] text-slate-100 flex items-center justify-center p-4">
          <div className="max-w-lg w-full border border-red-500/35 bg-[#111722] rounded-xl p-6 space-y-4">
            <div className="flex items-center gap-2.5 text-red-300 font-semibold text-sm">
              <AlertTriangle className="w-5 h-5 text-red-400 shrink-0" />
              Gold AI Trader — Recovery Notice
            </div>
            <p className="text-xs text-slate-300 leading-relaxed break-words">{friendly}</p>
            <button
              type="button"
              onClick={() => window.location.reload()}
              className="inline-flex items-center gap-2 px-4 py-2 rounded-md bg-[#D4A853] text-[#0B0F17] text-xs font-bold hover:bg-[#E0B866]"
            >
              <RefreshCw className="w-3.5 h-3.5" />
              Reload Application
            </button>
          </div>
        </div>
      );
    }

    return this.props.children;
  }
}
