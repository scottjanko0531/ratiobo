"use client";

// Small round "i" toggle button used to expand an inline definition panel —
// shared by the Big Cycle stage tracker (app/big-cycle/page.jsx) and the
// Debt Cycle Position Check trip-wires (components/DebtCyclePositionCheck.jsx),
// pulled out to its own file so a component doesn't have to import from the
// page that renders it.
export default function StageInfoIcon({ isCurrent, active, onClick, label = "About this" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      title={label}
      className={`w-[13px] h-[13px] rounded-full border text-[8px] font-bold flex items-center justify-center shrink-0 transition-colors ${
        active
          ? "border-brass text-brass bg-brass/10"
          : isCurrent
          ? "border-ink/40 text-ink/70 hover:border-ink hover:text-ink"
          : "border-paper-dim/40 text-paper-dim/70 hover:border-paper-dim hover:text-paper-dim"
      }`}
    >
      i
    </button>
  );
}
