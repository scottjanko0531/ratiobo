"use client";
import Markdown from "./Markdown";

export default function WatchAnalysisPanel({ analysis, busy, error, progress, onClose, onRegenerate }) {
  if (!analysis) return null;

  return (
    <div className="fixed inset-0 z-[60]">
      <div className="absolute inset-0 bg-ink/70" onClick={onClose} />
      <div className="absolute right-0 top-0 h-full w-full max-w-[820px] bg-ink-soft border-l border-ink-line overflow-y-auto">
        <div className="flex items-start justify-between px-5 py-4 border-b border-ink-line sticky top-0 bg-ink-soft z-10">
          <div className="flex-1 min-w-0 pr-4">
            <p className="font-semibold text-base">{analysis.title}</p>
            {analysis.generated_at && (
              <p className="text-xs text-paper-dim mt-0.5">
                Generated {new Date(analysis.generated_at).toLocaleString()}
              </p>
            )}
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <button
              onClick={onRegenerate}
              disabled={busy}
              className="px-3 py-1.5 rounded-lg text-xs border border-ink-line text-paper-dim hover:text-paper transition-colors disabled:opacity-50"
            >
              {busy ? "Working…" : "Regenerate"}
            </button>
            <button onClick={onClose} className="text-paper-dim hover:text-paper ml-1" aria-label="Close">✕</button>
          </div>
        </div>

        <div className="px-5 py-5">
          {error && (
            <p className="text-sm text-loss mb-4">{error}</p>
          )}
          {busy && !analysis.content ? (
            <div className="space-y-3">
              <p className="text-sm text-paper-dim">
                {progress || "Researching — this pulls live financial data…"}
              </p>
              <p className="text-xs text-paper-dim/60">
                A full sector research pass can take a few minutes the first time; it's cached and reused for other stocks in the same sector after that.
              </p>
              <div className="h-2 w-full bg-ink rounded overflow-hidden">
                <div className="h-full w-1/3 bg-brass/60 animate-pulse" />
              </div>
            </div>
          ) : analysis.content ? (
            <Markdown>{analysis.content}</Markdown>
          ) : null}
        </div>
      </div>
    </div>
  );
}
