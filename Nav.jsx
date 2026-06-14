"use client";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "../lib/supabase";

const links = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/accounts", label: "Accounts" },
  { href: "/holdings/new", label: "Add holding" },
  { href: "/transactions/new", label: "Add transaction" }
];

export default function Nav() {
  const pathname = usePathname();
  const router = useRouter();

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  return (
    <header className="border-b border-ink-line">
      <div className="max-w-6xl mx-auto px-4 sm:px-6 py-4 flex items-center gap-6">
        <Link href="/dashboard" className="flex items-center gap-2.5 shrink-0">
          <span className="flex items-center gap-1" aria-hidden="true">
            <span className="bead" />
            <span className="bead opacity-70" />
            <span className="bead opacity-40" />
          </span>
          <span className="text-lg font-semibold tracking-tight">Ratiobo</span>
          <span className="hidden sm:inline label mt-0.5">Portfolio intelligence</span>
        </Link>
        <nav className="flex items-center gap-1 ml-auto overflow-x-auto">
          {links.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className={`px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
                pathname === l.href
                  ? "bg-ink-soft text-brass-soft"
                  : "text-paper-dim hover:text-paper"
              }`}
            >
              {l.label}
            </Link>
          ))}
          <button onClick={signOut} className="px-3 py-1.5 text-sm text-paper-dim hover:text-paper">
            Sign out
          </button>
        </nav>
      </div>
    </header>
  );
}
