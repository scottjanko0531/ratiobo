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

function XIcon({ className }) {
  return (
    <svg className={className} viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <path d="M5 5l10 10M15 5L5 15" />
    </svg>
  );
}

const IMPORTANCE_DOT = {
  high:   "bg-loss",
  medium: "bg-brass",
  low:    "bg-paper-dim",
};

const IMPORTANCE_BORDER = {
  high:   "border-l-2 border-loss",
  medium: "border-l-2 border-brass",
  low:    "border-l-2 border-ink-line",
};

const CATEGORY_LABEL = {
  gauge:     "Gauge",
  indicator: "Indicator",
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

function groupNotifications(notifs) {
  const sorted = [...notifs].sort((a, b) =>
    new Date(b.created_at) - new Date(a.created_at)
  );
  const unread = sorted.filter((n) => !n.read_at);
  const read   = sorted.filter((n) =>  n.read_at);

  const byCategory = (items) => {
    const map = {};
    for (const n of items) {
      const cat = n.category ?? "other";
      if (!map[cat]) map[cat] = [];
      map[cat].push(n);
    }
    return map;
  };

  return [
    unread.length ? { label: "Unread", items: unread, byCategory: byCategory(unread) } : null,
    read.length   ? { label: "Read",   items: read,   byCategory: byCategory(read)   } : null,
  ].filter(Boolean);
}

export default function NotificationBanner() {
  const [notifs, setNotifs] = useState([]);
  const [open, setOpen]     = useState(false);
  const channelRef          = useRef(null);

  useEffect(() => {
    supabase
      .from("notifications")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(100)
      .then(({ data }) => { if (data) setNotifs(data); })
      .catch(() => {});

    try {
      const ch = supabase
        .channel("notifications-dashboard-banner")
        .on("postgres_changes", { event: "INSERT", schema: "public", table: "notifications" }, (payload) => {
          if (payload?.new) setNotifs((prev) => [payload.new, ...prev].slice(0, 100));
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
  }, []);

  const unreadCount = notifs.filter((n) => !n.read_at).length;
  const mostRecent  = notifs[0];
  const groups      = groupNotifications(notifs);

  async function markRead(id) {
    const now = new Date().toISOString();
    setNotifs((prev) => prev.map((n) => n.id === id ? { ...n, read_at: now } : n));
    await supabase.from("notifications").update({ read_at: now }).eq("id", id);
  }

  async function markAllRead() {
    const now      = new Date().toISOString();
    const ids      = notifs.filter((n) => !n.read_at).map((n) => n.id);
    if (!ids.length) return;
    setNotifs((prev) => prev.map((n) => ({ ...n, read_at: n.read_at ?? now })));
    await supabase.from("notifications").update({ read_at: now }).in("id", ids);
  }

  return (
    <>
      {/* ── Banner ── */}
      <button
        onClick={() => setOpen(true)}
        className="w-full card px-4 py-3 mb-8 flex items-center gap-3 hover:bg-ink transition-colors text-left group"
      >
        <span className="relative flex-shrink-0">
          <BellIcon className="w-4 h-4 text-paper-dim group-hover:text-paper transition-colors" />
          {unreadCount > 0 && (
            <span className="absolute -top-1.5 -right-1.5 min-w-[16px] h-4 px-0.5 bg-loss text-paper text-[10px] font-bold rounded-full flex items-center justify-center leading-none">
              {unreadCount > 99 ? "99+" : unreadCount}
            </span>
          )}
        </span>

        <div className="flex-1 min-w-0">
          {unreadCount > 0 ? (
            <span className="text-sm">
              <span className="font-semibold text-paper">{unreadCount} unread</span>
              {mostRecent && (
                <span className="text-paper-dim ml-2 truncate">· {mostRecent.title}</span>
              )}
            </span>
          ) : (
            <span className="text-sm text-paper-dim">No new notifications</span>
          )}
        </div>

        <span className="text-xs text-paper-dim group-hover:text-brass-soft transition-colors flex-shrink-0">
          View all →
        </span>
      </button>

      {/* ── Backdrop ── */}
      {open && (
        <div
          className="fixed inset-0 bg-black/40 z-40"
          onClick={() => setOpen(false)}
        />
      )}

      {/* ── Drawer ── */}
      <div
        className={`fixed top-0 right-0 h-full w-[420px] max-w-full bg-ink-soft border-l border-ink-line z-50 flex flex-col shadow-2xl transition-transform duration-300 ${
          open ? "translate-x-0" : "translate-x-full"
        }`}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-4 border-b border-ink-line flex-shrink-0">
          <div className="flex items-center gap-2.5">
            <BellIcon className="w-4 h-4 text-paper-dim" />
            <span className="font-semibold text-paper">Notifications</span>
            {unreadCount > 0 && (
              <span className="text-[11px] bg-loss/20 text-loss border border-loss/30 px-1.5 py-0.5 rounded-full font-medium leading-none">
                {unreadCount} unread
              </span>
            )}
          </div>
          <div className="flex items-center gap-3">
            {unreadCount > 0 && (
              <button
                onClick={markAllRead}
                className="text-xs text-brass hover:text-brass-soft transition-colors"
              >
                Mark all read
              </button>
            )}
            <button
              onClick={() => setOpen(false)}
              className="p-1 text-paper-dim hover:text-paper transition-colors rounded"
            >
              <XIcon className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-y-auto">
          {notifs.length === 0 ? (
            <p className="text-paper-dim text-sm text-center py-12">No notifications yet.</p>
          ) : (
            groups.map(({ label, byCategory }) => (
              <div key={label}>
                {/* Read-status section header */}
                <div className="sticky top-0 bg-ink-soft/95 backdrop-blur-sm px-5 py-2 border-b border-ink-line/50 z-10">
                  <p className="label text-[10px] uppercase tracking-wider">{label}</p>
                </div>

                {Object.entries(byCategory).map(([cat, items]) => (
                  <div key={cat}>
                    {/* Category sub-header */}
                    <div className="px-5 pt-3 pb-1">
                      <p className="text-[10px] font-semibold uppercase tracking-widest text-paper-dim/60">
                        {CATEGORY_LABEL[cat] ?? cat}
                      </p>
                    </div>

                    {items.map((n) => (
                      <button
                        key={n.id}
                        onClick={() => markRead(n.id)}
                        className={`w-full text-left px-5 py-3 border-b border-ink-line/40 last:border-b-0 transition-colors
                          ${n.read_at ? "opacity-50" : "hover:bg-ink/60"}
                          ${IMPORTANCE_BORDER[n.importance] ?? IMPORTANCE_BORDER.low}`}
                      >
                        <div className="flex items-start gap-2.5">
                          <span
                            className={`mt-[5px] w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                              IMPORTANCE_DOT[n.importance] ?? IMPORTANCE_DOT.low
                            }`}
                          />
                          <div className="flex-1 min-w-0">
                            <p className="text-sm text-paper leading-snug">{n.title}</p>
                            {n.description && (
                              <p className="text-xs text-paper-dim mt-0.5 leading-snug">{n.description}</p>
                            )}
                            <p className="text-[11px] text-paper-dim/70 mt-1">{timeAgo(n.created_at)}</p>
                          </div>
                          {!n.read_at && (
                            <span className="mt-[5px] w-1.5 h-1.5 rounded-full bg-brass flex-shrink-0" />
                          )}
                        </div>
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ))
          )}
        </div>
      </div>
    </>
  );
}
