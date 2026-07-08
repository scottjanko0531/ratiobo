"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { supabase } from "../lib/supabase";
import NotificationBell from "./NotificationBell";

const links = [
  { href: "/dashboard", label: "Dashboard" },
  { href: "/accounts", label: "Accounts" },
  { href: "/holdings", label: "Holdings" },
  { href: "/macro", label: "Macro" },
  { href: "/simulator", label: "Simulator" },
  { href: "/transactions", label: "Transactions" },
];

function Brand() {
  return (
    <span className="flex items-center gap-2.5">
      <span className="flex items-center gap-1" aria-hidden="true">
        <span className="bead" />
        <span className="bead opacity-70" />
        <span className="bead opacity-40" />
      </span>
      <span className="text-lg font-semibold tracking-tight">Ratiobo</span>
    </span>
  );
}

export default function Nav() {
  const pathname = usePathname();
  const router = useRouter();
  const [email, setEmail] = useState("");

  useEffect(() => {
    supabase.auth.getUser().then(({ data: { user } }) => setEmail(user?.email ?? ""));
  }, []);

  async function signOut() {
    await supabase.auth.signOut();
    router.push("/login");
  }

  const linkClass = (href) =>
    `px-3 py-1.5 rounded-lg text-sm whitespace-nowrap transition-colors ${
      pathname === href
        ? "bg-ink-soft text-brass-soft"
        : "text-paper-dim hover:text-paper"
    }`;

  const sidebarLinkClass = (href) =>
    `px-3 py-2 rounded-lg text-sm transition-colors ${
      pathname === href
        ? "bg-ink-soft text-brass-soft"
        : "text-paper-dim hover:text-paper"
    }`;

  return (
    <>
      {/* Mobile top bar */}
      <header className="md:hidden border-b border-ink-line">
        <div className="px-4 sm:px-6 py-4 flex items-center gap-6">
          <Link href="/dashboard" className="shrink-0">
            <Brand />
          </Link>
          <div className="flex items-center gap-1 ml-auto">
            <nav className="flex items-center gap-1 overflow-x-auto">
              {links.map((l) => (
                <Link key={l.href} href={l.href} className={linkClass(l.href)}>
                  {l.label}
                </Link>
              ))}
              <Link href="/profile" className={linkClass("/profile")}>
                Profile
              </Link>
              <button onClick={signOut} className="px-3 py-1.5 text-sm text-paper-dim hover:text-paper">
                Sign out
              </button>
            </nav>
            <NotificationBell variant="mobile" />
          </div>
        </div>
      </header>

      {/* Desktop sidebar */}
      <aside className="hidden md:flex md:flex-col md:w-56 md:shrink-0 md:border-r md:border-ink-line md:min-h-screen md:sticky md:top-0">
        <Link href="/dashboard" className="px-5 py-5 border-b border-ink-line block">
          <Brand />
          <span className="label mt-1.5 block">Portfolio intelligence</span>
        </Link>
        <nav className="flex flex-col gap-1 p-3">
          {links.map((l) => (
            <Link key={l.href} href={l.href} className={sidebarLinkClass(l.href)}>
              {l.label}
            </Link>
          ))}
        </nav>
        <div className="mt-auto border-t border-ink-line p-3 space-y-1">
          {email && (
            <p className="px-3 pb-1 text-xs text-paper-dim truncate" title={email}>
              {email}
            </p>
          )}
          <Link href="/profile" className={sidebarLinkClass("/profile")}>
            Profile
          </Link>
          <NotificationBell variant="desktop" />
          <button
            onClick={signOut}
            className="w-full px-3 py-2 text-sm text-left rounded-lg text-paper-dim hover:text-paper border border-ink-line hover:border-brass/60 transition-colors"
          >
            Sign out
          </button>
        </div>
      </aside>
    </>
  );
}
