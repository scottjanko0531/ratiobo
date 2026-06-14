"use client";
import { useEffect, useState } from "react";
import { useRouter } from "next/navigation";
import { supabase } from "../lib/supabase";
import Nav from "./Nav";

export default function Shell({ children }) {
  const router = useRouter();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      if (!session) router.replace("/login");
      else setReady(true);
    });
    const { data: sub } = supabase.auth.onAuthStateChange((_e, session) => {
      if (!session) router.replace("/login");
    });
    return () => sub.subscription.unsubscribe();
  }, [router]);

  if (!ready) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <span className="flex items-center gap-1.5" aria-label="Loading">
          <span className="bead animate-pulse" />
          <span className="bead animate-pulse [animation-delay:150ms]" />
          <span className="bead animate-pulse [animation-delay:300ms]" />
        </span>
      </div>
    );
  }

  return (
    <>
      <Nav />
      <main className="max-w-6xl mx-auto px-4 sm:px-6 py-8">{children}</main>
    </>
  );
}
