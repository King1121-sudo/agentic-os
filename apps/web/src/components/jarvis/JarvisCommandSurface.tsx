'use client';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, post } from '@/lib/api';
import { useExecutionStore, useLatestExecution, type LiveExecution } from '@/lib/execution-store';
import { LiveExecutionPanel } from './LiveExecutionPanel';

/**
 * The JARVIS command surface. Text and voice share ONE routing path
 * (POST /api/command → runtime → SSE events → ExecutionStore → UI).
 *
 * Flow (§0): command → immediate ack (from the API response, honest intent) →
 * execution registered in the store → LiveExecutionPanel streams the real
 * activity → result/panel coexist inline. Complexity-aware (§21): local
 * `kind:'result'` answers render as a quiet result card; agent executions get
 * the full live panel. Navigating away is never required.
 */
type VoiceState =
  | { status: 'idle' }
  | { status: 'unsupported' }
  | { status: 'listening'; interim: string }
  | { status: 'processing'; text: string }
  | { status: 'error'; message: string };

const ROUTES = [
  { label: 'Open agents', href: '/agents' },
  { label: 'Open memory', href: '/memory' },
  { label: 'Open projects', href: '/projects' },
  { label: 'Open flows', href: '/flows' },
  { label: 'Open automations', href: '/automations' },
  { label: 'Open integrations', href: '/integrations' },
  { label: 'Open activity', href: '/activity' },
  { label: 'Open links graph', href: '/links' },
];

const SUGGESTIONS = [
  "what's important today?",
  'show my active agents',
  'status of my projects',
  'plan a sprint for the next milestone',
];

export function JarvisCommandSurface({ compact = false }: { compact?: boolean }) {
  const [text, setText] = useState('');
  const [mode, setMode] = useState<'command' | 'search'>('command');
  const [busy, setBusy] = useState(false);
  const [ack, setAck] = useState<string | null>(null);
  const [resultCard, setResultCard] = useState<{ text: string } | null>(null);
  const [results, setResults] = useState<any[]>([]);
  const [voice, setVoice] = useState<VoiceState>({ status: 'idle' });
  const [dismissed, setDismissed] = useState<string | null>(null);
  const recognitionRef = useRef<any>(null);
  const store = useExecutionStore();
  const latest = useLatestExecution();

  const routeMatches = useMemo(() => {
    const q = text.trim().toLowerCase();
    return q ? ROUTES.filter(r => r.label.toLowerCase().includes(q)).slice(0, 5) : ROUTES.slice(0, 4);
  }, [text]);

  const runSearch = useCallback(async (q: string) => {
    if (!q.trim()) { setResults([]); return; }
    try {
      const res = await api(`/api/search?q=${encodeURIComponent(q)}`);
      setResults(Array.isArray(res) ? res.slice(0, 8) : []);
    } catch (e: any) {
      setAck(`Search error: ${e.message}`);
    }
  }, []);

  // §7/§31 — the ack is honest and immediate: it names what the backend will
  // actually do (agent or instant answer), from the API response itself.
  const submitCommand = useCallback(async (commandText = text) => {
    const q = commandText.trim();
    if (!q) return;
    setBusy(true);
    setResultCard(null);
    setDismissed(null);
    setAck('Acknowledged — routing…');
    store.trackCommand(q);
    try {
      const res = await post<any>('/api/command', { text: q });
      // the backend ack is authoritative — show it verbatim
      if (res?.ack) setAck(res.ack);
      if (res?.kind === 'execution' && res.execution_id) {
        // register the REAL execution; SSE drives everything from here
        store.register(res.execution_id, {
          agent: res.agent_name ?? 'Agent',
          ack: res.ack,
          input: q,
          state: 'received',
        });
      } else if (res?.text) {
        // simple/instant answer — quiet result card, no execution theater (§21/§41)
        setResultCard({ text: res.text });
      }
      setText('');
    } catch (e: any) {
      setAck(`Command failed: ${e.message}`);
      setVoice({ status: 'error', message: e.message });
    } finally {
      setBusy(false);
    }
  }, [text, store]);

  useEffect(() => {
    if (mode === 'search') runSearch(text);
  }, [mode, runSearch, text]);

  // -- voice: same command path, Web Speech API ------------------------------
  const startVoice = useCallback(() => {
    const Ctor = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!Ctor) { setVoice({ status: 'unsupported' }); setAck('Voice recognition is not supported in this browser.'); return; }
    try { recognitionRef.current?.abort?.(); } catch { /* stale */ }
    const rec = new Ctor();
    rec.continuous = false;
    rec.interimResults = true;
    rec.lang = 'en-US';
    recognitionRef.current = rec;
    setVoice({ status: 'listening', interim: '' });
    setAck('Listening… review the transcript before submitting.');
    rec.onresult = (event: any) => {
      let transcript = '';
      for (let i = event.resultIndex; i < event.results.length; i++) transcript += event.results[i][0].transcript;
      setText(transcript.trim());
      setVoice({ status: 'listening', interim: transcript.trim() });
    };
    rec.onerror = (event: any) => {
      setVoice({ status: 'error', message: event.error ?? 'unknown' });
      setAck(`Voice error: ${event.error ?? 'unknown'}`);
    };
    rec.onend = () => setVoice(s => s.status === 'listening' ? { status: 'idle' } : s);
    rec.start();
  }, []);

  const stopVoice = useCallback(() => {
    try { recognitionRef.current?.stop?.(); } catch { /* not running */ }
    setVoice({ status: 'idle' });
  }, []);

  useEffect(() => () => { try { recognitionRef.current?.abort?.(); } catch { /* */ } }, []);

  const voiceChipClass = voice.status === 'listening' ? 'is-listening' : voice.status === 'processing' ? 'is-processing' : voice.status === 'error' ? 'is-error' : '';
  const voiceLabel = voice.status === 'listening' ? 'LISTENING'
    : voice.status === 'processing' ? 'PROCESSING'
    : voice.status === 'error' ? 'ERROR'
    : voice.status === 'unsupported' ? 'UNSUPPORTED'
    : '';

  const panel: LiveExecution | null = latest && dismissed !== latest.id ? latest : null;

  return (
    <section className={`jarvis-command ${compact ? 'compact' : ''}`} aria-label="JARVIS command surface">
      <div className="jarvis-command-tabs" role="tablist" aria-label="Command mode">
        <button className={mode === 'command' ? 'primary' : ''} onClick={() => setMode('command')} role="tab" aria-selected={mode === 'command'}>Command</button>
        <button className={mode === 'search' ? 'primary' : ''} onClick={() => setMode('search')} role="tab" aria-selected={mode === 'search'}>Search</button>
        <span style={{ flex: 1 }} />
        {voiceLabel && <span className={`voice-chip ${voiceChipClass}`} role="status">{voiceLabel}</span>}
        <button aria-label={voice.status === 'listening' ? 'Stop voice input' : 'Start voice input'}
          onClick={voice.status === 'listening' ? stopVoice : startVoice}>
          {voice.status === 'listening' ? '■ Voice' : '◉ Voice'}
        </button>
      </div>
      <div className="jarvis-command-input-row">
        <input
          placeholder="Ask JARVIS, launch a mission, or search the OS…"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') submitCommand(); }}
          aria-label="JARVIS command input"
        />
        <button className="primary" disabled={busy || !text.trim()} onClick={() => submitCommand()}>{busy ? 'Sending…' : 'Run'}</button>
      </div>

      {ack && (
        <div className="jarvis-ack" role="status">
          <span className="jarvis-ack-glyph" aria-hidden="true">❯</span>
          <span>{ack}</span>
        </div>
      )}

      {voice.status === 'listening' && voice.interim && (
        <div className="xs mono" style={{ marginTop: 6, color: 'var(--cyan-bright)' }} role="status">
          heard: “{voice.interim}”
        </div>
      )}

      {/* the live execution — real state only, inline, no navigation */}
      {panel && <LiveExecutionPanel exec={panel} onClose={() => setDismissed(panel.id)} />}

      {/* instant answers — quiet card, never execution theater */}
      {resultCard && (
        <div className="jarvis-result-card" role="status">
          <pre className="code" style={{ margin: 0, maxHeight: 260, overflowY: 'auto' }}>{resultCard.text}</pre>
        </div>
      )}

      {mode === 'command' && routeMatches.length > 0 && !panel && !resultCard && (
        <div className="jarvis-command-suggestions">
          {routeMatches.map(route => (
            <button key={route.href} onClick={() => { window.location.href = route.href; }}>↳ {route.label}</button>
          ))}
        </div>
      )}
      {mode === 'command' && !text && !panel && !resultCard && (
        <div className="jarvis-command-suggestions" aria-label="Suggested commands">
          {SUGGESTIONS.map(s => (
            <button key={s} onClick={() => { setText(s); submitCommand(s); }}>❯ {s}</button>
          ))}
        </div>
      )}
      {mode === 'search' && results.length > 0 && (
        <div className="jarvis-command-results">
          {results.map((r, i) => (
            <div className="jarvis-result-row" key={`${r.type}-${r.id ?? i}`}>
              <span className="badge b-gray">{r.type}</span>
              <span className="grow">{r.title ?? r.label ?? r.id}</span>
              <span className="xs faint">{r.subtitle}</span>
            </div>
          ))}
        </div>
      )}
      {!store.connected && (
        <div className="xs" style={{ marginTop: 8, color: 'var(--orange)' }} role="status">Reconnecting to live stream…</div>
      )}
    </section>
  );
}
