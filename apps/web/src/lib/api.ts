'use client';
/** API client + SSE hook. Same-origin via Next rewrites → cookie auth flows. */

export async function api<T = any>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    credentials: 'include',
  });
  if (res.status === 401 && typeof window !== 'undefined' && !location.pathname.startsWith('/login')) {
    location.href = '/login';
    throw new Error('unauthorized');
  }
  const text = await res.text();
  let json: any = null;
  try { json = text ? JSON.parse(text) : null; } catch { json = { raw: text }; }
  if (!res.ok) throw new Error(json?.error ?? `HTTP ${res.status}`);
  return json as T;
}

export function post<T = any>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'POST', body: JSON.stringify(body) });
}
export function patch<T = any>(path: string, body: unknown): Promise<T> {
  return api<T>(path, { method: 'PATCH', body: JSON.stringify(body) });
}

/** Live event stream hook — the OS heartbeat. */
export function useEventStream(onEvent: (ev: any) => void): { connected: boolean } {
  let connected = false;
  const ref = useRef(onEvent);
  ref.current = onEvent;
  const [conn, setConn] = useState(false);
  useEffect(() => {
    const es = new EventSource('/api/stream');
    es.onopen = () => setConn(true);
    es.onerror = () => setConn(false);
    es.onmessage = (e) => {
      try { ref.current(JSON.parse(e.data)); } catch { /* skip */ }
    };
    return () => es.close();
  }, []);
  connected = conn;
  return { connected };
}

// tiny local state helpers (avoid a state lib for this scale)
import { useEffect, useRef, useState } from 'react';

export function usePoll<T>(fn: () => Promise<T>, ms: number, deps: unknown[] = []): T | null {
  const [data, setData] = useState<T | null>(null);
  const ref = useRef(fn);
  ref.current = fn;
  useEffect(() => {
    let alive = true;
    const tick = async () => { try { const d = await ref.current(); if (alive) setData(d); } catch { /* transient */ } };
    tick();
    const t = setInterval(tick, ms);
    return () => { alive = false; clearInterval(t); };
  }, deps);
  return data;
}

export function fmtTime(iso: string): string {
  if (!iso) return '';
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  } catch { return iso; }
}
export function fmtAgo(iso: string): string {
  const s = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (s < 60) return `${Math.floor(s)}s ago`;
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
