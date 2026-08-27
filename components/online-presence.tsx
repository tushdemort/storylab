"use client";

import { useEffect, useState } from "react";
import { getBrowserSupabase } from "@/lib/supabase/browser";
import { countOnlinePresences, onlinePresenceLabel, type PresenceStateLike } from "@/lib/presence";

const presenceChannel = "assessment-lobby-presence";
const sessionKey = "storylab-presence-session";

export function OnlinePresence() {
  const [onlineCount, setOnlineCount] = useState(0);
  const [connected, setConnected] = useState(false);

  useEffect(() => {
    let supabase: ReturnType<typeof getBrowserSupabase>;
    try { supabase = getBrowserSupabase(); } catch { return; }
    let presenceId = sessionStorage.getItem(sessionKey);
    if (!presenceId) {
      presenceId = crypto.randomUUID();
      sessionStorage.setItem(sessionKey, presenceId);
    }
    const channel = supabase.channel(presenceChannel, {
      config: { presence: { key: presenceId, enabled: true } },
    });
    const synchronize = () => {
      const state = channel.presenceState() as PresenceStateLike;
      setOnlineCount(countOnlinePresences(state));
    };
    channel
      .on("presence", { event: "sync" }, synchronize)
      .on("presence", { event: "join" }, synchronize)
      .on("presence", { event: "leave" }, synchronize)
      .subscribe(async (status: "SUBSCRIBED" | "TIMED_OUT" | "CLOSED" | "CHANNEL_ERROR") => {
        if (status === "SUBSCRIBED") {
          const tracked = await channel.track({ online_at: new Date().toISOString() });
          setConnected(tracked === "ok");
          if (tracked === "ok") synchronize();
        } else if (status === "CHANNEL_ERROR" || status === "TIMED_OUT" || status === "CLOSED") {
          setConnected(false);
        }
      });
    return () => {
      void channel.untrack();
      void supabase.removeChannel(channel);
    };
  }, []);

  if (!connected) {
    return <div className="online-presence loading" aria-label="Checking online participants"><span className="presence-pulse" /><span>Checking online…</span></div>;
  }
  const visibleAvatars = Math.min(onlineCount, 3);
  return <div className="online-presence" title="Anonymous participants currently online before pairing">
    <div className="presence-avatars" aria-hidden="true">
      {Array.from({ length: visibleAvatars }, (_, index) => <span key={index}>{index + 1}</span>)}
      {onlineCount > 3 && <span className="presence-more">+{onlineCount - 3}</span>}
    </div>
    <span className="presence-label"><i />{onlinePresenceLabel(onlineCount)}</span>
  </div>;
}
