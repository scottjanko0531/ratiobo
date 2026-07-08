"use client";
import { useEffect, useRef, useState } from "react";
import { supabase } from "../lib/supabase";

function BellIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="currentColor">
      <path d="M10 2a6 6 0 0 0-6 6v2.586l-.707.707A1 1 0 0 0 4 13h12a1 1 0 0 0 .707-1.707L16 10.586V8a6 6 0 0 0-6-6z" />
      <path d="M10 18a2 2 0 0 1-2-2h4a2 2 0 0 1-2 2z" />
    </svg>
  );
}

const IMPORTANCE_STYLES = {
  high:   "border-l-2 border-loss",
  medium: "border-l-2 border-brass",
  low:    "border-l-2 border-ink-line",
};

const IMPORTANCE_DOT = {
  high:   "bg-loss",
  medium: "bg-brass",
  low:    "bg-paper-dim",
};

function timeAgo(iso) {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

export default function NotificationBell({ variant = "desktop" }) {
  const [notifs, setNotifs] = useState([]);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef(null);
  const channelRef = useRef(null);

  useEffect(() => {
    supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(50)
      .then(({ data }) => { if (data) setNotifs(data); })
      .catch(() => {});

    try {
      const ch = supabase
        .channel(`notifications-bell-${variant}`)
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, (payload) => {
          if (payload?.new) setNotifs((prev) => [payload.new, ...prev].slice(0, 50));
        })
        .subscribe();
      channelRef.current = ch;
    } catch (_) {}

    return () => {
      if (channelRef.current) {
        supabase.removeChannel(channelRef.current).catch(() => {});
        channelRef.current = null;
      }
    };
  }, [variant]);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    function handle(e) {
      if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false);
    }
    document.addEventListener("mousedown", handle);
    return () => document.removeEventListener("mousedown", handle);
  }, [open]);

  const unreadCount = notifs.filter((n) => !n.read_at).length;

  async function markRead(id) {
    const now = new Date().toISOString();
    setNotifs((prev) => prev.map((n) => n.id === id ? { ...n, read_at: now } : n));
    await supabase.from("notifications").update({ read_at: now }).eq("id", id);
  }

  async function markAllRead() {
    const now = new Date().toISOString();
    const unreadIds = notifs.filter((n) => !n.read_at).map((n) => n.id);
    if (!unreadIds.length) return;
    setNotifs((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? now })));
    await supabase.from("notifications").update({ read_at: now }).in("id", unreadIds);
  }

  const trigger = variant === "desktop" ? (
    <button
      onClick={() => setOpen((o) => !o)}
      className="relative w-full px-3 py-2 text-sm text-left rounded-lg text-paper-dim hover:text-paper transition-colors flex items-center gap-2"
      aria-label="Notifications"
    >
      <span className="relative flex-shrink-0">
        <BellIcon className="w-4 h-4" />
        {unreadCount > 0 && (
          <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-0.5 bg-loss text-paper text-[10px] font-bold rounded-full flex items-center justify-center leading-none">
            {unreadCount > 99 ? "99+" : unreadCount}
          </span>
        )}
      </span>
      <span>Notifications</span>
    </button>
  ) : (
    <button
      onClick={() => setOpen((o) => !o)}
      className="relative p-1.5 text-paper-dim hover:text-paper transition-colors flex-shrink-0"
      aria-label="Notifications"
    >
      <BellIcon className="w-5 h-5" />
      {unreadCount > 0 && (
        <span className="absolute top-0 right-0 min-w-[16px] h-4 px-0.5 bg-loss text-paper text-[10px] font-bold rounded-full flex items-center justify-center leading-none">
          {unreadCount > 99 ? "99+" : unreadCount}
        </span>
      )}
    </button>
  );

  return (
    <div ref={wrapRef} className="relative">
      {trigger}

      {open && (
        <div
          className={`absolute z-50 bg-ink-soft border border-ink-line rounded-xl shadow-xl overflow-hidden flex flex-col
            ${variant === "desktop"
              ? "bottom-full mb-2 left-0 w-80"
              : "top-full mt-2 right-0 w-80"
            }`}
          style={{ maxHeight: "420px" }}
        >
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-ink-line flex-shrink-0">
            <span className="text-sm font-semibold text-paper">Notifications</span>
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs text-brass hover:text-brass-soft transition-colors"
              >
                Mark all read
              </button>
            )}
          </div>

          {/* List */}
          <div className="overflow-y-auto flex-1">
            {notifs.length === 0 ? (
              <p className="px-4 py-8 text-sm text-paper-dim text-center">No notifications yet</p>
            ) : (
              notifs.map((n) => (
                <button
                  key={n.id}
                  onClick={() => markRead(n.id)}
                  className={`w-full text-left px-4 py-3 border-b border-ink-line last:border-b-0 transition-colors
                    ${n.read_at ? "opacity-50" : "hover:bg-ink"}
                    ${IMPORTANCE_STYLES[n.importance] ?? IMPORTANCE_STYLES.low}`}
                >
                  <div className="flex items-start gap-2">
                    <span className={`mt-1.5 w-1.5 h-1.5 rounded-full flex-shrink-0 ${IMPORTANCE_DOT[n.importance] ?? IMPORTANCE_DOT.low}`} />
                    <div className="flex-1 min-w-0">
                      <p className="text-sm text-paper leading-snug truncate">{n.title}</p>
                      {n.description && (
                        <p className="text-xs text-paper-dim mt-0.5 leading-snug">{n.description}</p>
                      )}
                      <p className="text-[11px] text-paper-dim mt-1 opacity-70">{timeAgo(n.created_at)}</p>
                    </div>
                    {!n.read_at && (
                      <span className="mt-1.5 w-1.5 h-1.5 rounded-full bg-brass flex-shrink-0" />
                    )}
                  </div>
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
}
