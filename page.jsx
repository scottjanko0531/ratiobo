"use client";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";

// Sample allocation for the hero abacus — proportion is the whole point
const ALLOCATION = [
  { label: "Equities", pct: 46, value: "$184,200" },
  { label: "Crypto", pct: 22, value: "$88,100" },
  { label: "Metals", pct: 24, value: "$96,400" },
  { label: "Cash", pct: 8, value: "$32,000" }
];

function Wordmark({ className = "" }) {
  return (
    <span className={`flex items-center gap-2.5 ${className}`}>
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="bead" />
        <span className="bead opacity-70" />
        <span className="bead opacity-40" />
      </span>
      <span className="text-lg font-semibold tracking-tight">Ratiobo</span>
    </span>
  );
}

// The signature: an abacus where bead position encodes each asset class's share
function RatioAbacus() {
  const [armed, setArmed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setArmed(true), 250);
    return () => clearTimeout(t);
  }, []);

  return (
    <div className="card p-6 sm:p-8 relative overflow-hidden">
      <div className="flex items-center justify-between mb-7">
        <p className="label">Allocation, by proportion</p>
        <p className="num text-sm text-paper-dim">$400,700</p>
      </div>

      <div className="space-y-6">
        {ALLOCATION.map((a, i) => (
          <div key={a.label}>
            <div className="flex items-baseline justify-between mb-2">
              <span className="text-sm text-paper">{a.label}</span>
              <span className="num text-sm text-paper-dim">
                {a.value}
                <span className="text-brass-soft ml-2">{a.pct}%</span>
              </span>
            </div>
            <div className="relative h-[2px] bg-ink-line rounded-full">
              <div
                className="rail-fill absolute inset-y-0 left-0 bg-brass/50 rounded-full"
                style={{
                  width: armed ? `${a.pct}%` : "0%",
                  transition: `width 0.9s cubic-bezier(0.22,1,0.36,1) ${i * 120}ms`
                }}
              />
              <div
                className="rail-bead absolute top-1/2 w-3.5 h-3.5 rounded-full bg-brass shadow-[0_0_0_4px_rgba(201,162,39,0.12)]"
                style={{
                  left: armed ? `${a.pct}%` : "0%",
                  transform: "translate(-50%, -50%)",
                  transition: `left 0.9s cubic-bezier(0.22,1,0.36,1) ${i * 120}ms`
                }}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="mt-8 pt-5 border-t border-ink-line flex items-center justify-between">
        <span className="label">Unrealized gain</span>
        <span className="num text-sm text-gain">+$71,540 +21.7%</span>
      </div>
    </div>
  );
}

function useReveal() {
  const ref = useRef(null);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Opt into the hidden-then-animate behavior only now that JS is live.
    el.classList.add("reveal-on");
    const items = Array.from(el.querySelectorAll(".reveal"));
    const io = new IntersectionObserver(
      (entries) => {
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("in");
            io.unobserve(e.target);
          }
        });
      },
      { threshold: 0.12 }
    );
    items.forEach((n) => io.observe(n));
    // Safety net: if anything hasn't revealed shortly after load
    // (observer misfire, fast scroll), show it anyway.
    const failsafe = setTimeout(() => {
      items.forEach((n) => n.classList.add("in"));
    }, 2500);
    return () => {
      io.disconnect();
      clearTimeout(failsafe);
    };
  }, []);
  return ref;
}

export default function Landing() {
  const scope = useReveal();

  return (
    <div ref={scope} className="min-h-screen">
      <header className="border-b border-ink-line">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center justify-between">
          <Wordmark />
          <div className="flex items-center gap-2">
            <Link href="/login" className="px-3 py-1.5 text-sm text-paper-dim hover:text-paper">
              Sign in
            </Link>
            <Link href="/login" className="btn text-sm !py-1.5">
              Start your ledger
            </Link>
          </div>
        </div>
      </header>

      <section className="max-w-6xl mx-auto px-4 sm:px-6 pt-16 pb-20 sm:pt-24 sm:pb-28">
        <div className="grid lg:grid-cols-[1.05fr_0.95fr] gap-12 lg:gap-16 items-center">
          <div>
            <p className="label reveal mb-5">Portfolio intelligence</p>
            <h1 className="font-display text-[2.6rem] leading-[1.05] sm:text-6xl sm:leading-[1.04] font-semibold tracking-[-0.02em] reveal">
              Wealth is a matter of proportion<span className="text-brass">.</span>
            </h1>
            <p className="mt-6 text-lg text-paper-dim max-w-md reveal">
              Ratiobo reads your equities, crypto, and precious metals as a single
              ledger — then shows you the ratios that actually move your net worth.
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3 reveal">
              <Link href="/login" className="btn">Start your ledger</Link>
              <Link href="/login" className="btn-ghost">Sign in</Link>
            </div>
            <p className="mt-6 text-sm text-paper-dim/80 reveal">
              Equities · ETFs · Crypto · Precious metals — priced automatically.
            </p>
          </div>

          <div className="reveal">
            <RatioAbacus />
          </div>
        </div>
      </section>

      <section className="border-t border-ink-line">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
          <h2 className="font-display text-3xl sm:text-4xl font-semibold tracking-[-0.01em] reveal max-w-xl">
            Built on ratios, not chat.
          </h2>
          <p className="mt-4 text-paper-dim max-w-lg reveal">
            Most tools bury the answer in a conversation. Ratiobo puts the
            proportions on the table, where you can read them at a glance.
          </p>

          <div className="grid sm:grid-cols-3 gap-px mt-12 bg-ink-line rounded-xl overflow-hidden">
            {[
              {
                t: "One ledger, every asset",
                d: "Stocks, ETFs, crypto, and physical metal tracked side by side — each priced from its own live source."
              },
              {
                t: "Ratios over readouts",
                d: "Allocation, cost basis, and gain expressed as the proportions that drive a decision, not just balances."
              },
              {
                t: "Quiet by design",
                d: "No assistant to interrogate, no prompts to phrase. The numbers are already laid out for you."
              }
            ].map((c) => (
              <div key={c.t} className="bg-ink p-6 reveal">
                <span className="bead mb-4" />
                <h3 className="font-medium text-paper mb-2">{c.t}</h3>
                <p className="text-sm text-paper-dim leading-relaxed">{c.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-ink-line">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-16 sm:py-20">
          <p className="label reveal mb-10">How it works</p>
          <div className="grid sm:grid-cols-3 gap-10 sm:gap-8">
            {[
              { n: "01", t: "Add your accounts", d: "Bank, brokerage, exchange, or vault — however your wealth is actually held." },
              { n: "02", t: "Log what you hold", d: "Enter positions and transactions. Cost basis assembles itself from the record." },
              { n: "03", t: "Read the proportions", d: "Live prices refresh every fifteen minutes; your ratios update with them." }
            ].map((s) => (
              <div key={s.n} className="reveal">
                <p className="num text-brass-soft text-sm mb-3">{s.n}</p>
                <h3 className="font-display text-xl font-semibold mb-2">{s.t}</h3>
                <p className="text-sm text-paper-dim leading-relaxed">{s.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      <section className="border-t border-ink-line">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-20 sm:py-28 text-center">
          <h2 className="font-display text-3xl sm:text-5xl font-semibold tracking-[-0.01em] reveal">
            See your portfolio in proportion<span className="text-brass">.</span>
          </h2>
          <div className="mt-8 flex justify-center reveal">
            <Link href="/login" className="btn">Start your ledger</Link>
          </div>
        </div>
      </section>

      <footer className="border-t border-ink-line">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 py-8 flex flex-col sm:flex-row items-center justify-between gap-4">
          <Wordmark />
          <p className="text-xs text-paper-dim">
            © {new Date().getFullYear()} Ratiobo · Portfolio intelligence
          </p>
        </div>
      </footer>
    </div>
  );
}
