"use client";

// Distinguishes model-synthesized commentary from sourced FRED/BLS/World Gold
// Council data elsewhere on the page — same visual authority otherwise made it
// easy to mistake one for the other. Shared by Clio Musings (Macro page) and
// the Debt Cycle Position Check narrative (Big Cycle page).
export default function ProvenanceBadge() {
  return (
    <span
      className="text-[9px] font-medium px-1.5 py-0.5 rounded border border-brass/30 text-brass-soft bg-brass/5 shrink-0"
      title="This commentary is generated and interpreted by an AI model from the page's live data — it is cross-checked against the underlying figures for internal consistency, but it is not itself a sourced data feed like the indicators on this page."
    >
      Model-synthesized
    </span>
  );
}
