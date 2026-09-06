'use client';
import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { api } from './api';
import type { JarvisMode } from './jarvis-types';
import { selectAttentionItems, selectJarvisMode } from './jarvis-selectors';

type JarvisState = {
  connected: boolean;
  events: any[];
  dashboard: any | null;
  health: any | null;
  approvals: any[];
  notifications: any[];
  mode: JarvisMode;
  attentionItems: any[];
};

const JarvisContext = createContext<JarvisState | null>(null);

export function JarvisDataProvider({ children }: { children: React.ReactNode }) {
  const [connected, setConnected] = useState(false);
  const [events, setEvents] = useState<any[]>([]);
  const [dashboard, setDashboard] = useState<any | null>(null);
  const [health, setHealth] = useState<any | null>(null);
  const [approvals, setApprovals] = useState<any[]>([]);
  const [notifications, setNotifications] = useState<any[]>([]);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    const poll = async () => {
      try {
        const [d, h, a, n] = await Promise.all([
          api('/api/dashboard').catch(() => null),
          api('/api/health').catch(() => null),
          api('/api/approvals?status=pending').catch(() => []),
          api('/api/notifications?status=unread').catch(() => []),
        ]);
        if (!alive.current) return;
        setDashboard(d);
        setHealth(h);
        setApprovals(Array.isArray(a) ? a : []);
        setNotifications(Array.isArray(n) ? n : []);
      } catch {
        // Route-level auth redirects and transient errors are handled by api().
      }
    };
    poll();
    const t = setInterval(poll, 5000);
    return () => { alive.current = false; clearInterval(t); };
  }, []);

  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => {
      try {
        const ev = JSON.parse(e.data);
        setEvents(prev => [ev, ...prev].slice(0, 120));
      } catch {
        // skip malformed events
      }
    };
    return () => es.close();
  }, []);

  const value = useMemo<JarvisState>(() => {
    const agents = dashboard?.agents ?? [];
    const mode = selectJarvisMode({ health, approvals, agents, events });
    return {
      connected,
      events,
      dashboard,
      health,
      approvals,
      notifications,
      mode,
      attentionItems: selectAttentionItems({ approvals, notes: notifications, events }),
    };
  }, [connected, events, dashboard, health, approvals, notifications]);

  return <JarvisContext.Provider value={value}>{children}</JarvisContext.Provider>;
}

export function useJarvisState() {
  return useContext(JarvisContext);
}
