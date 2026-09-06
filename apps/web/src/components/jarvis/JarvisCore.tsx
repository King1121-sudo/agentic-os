'use client';
import type { JarvisMode } from '@/lib/jarvis-types';
import { JarvisMetric } from './JarvisMetric';
import { JarvisStatusDot, toneForAgentStatus } from './JarvisStatusDot';

const MODE_COPY: Record<JarvisMode, { label: string; detail: string }> = {
  idle: { label: 'STANDBY', detail: 'Kernel is online and awaiting intent' },
  listening: { label: 'LISTENING', detail: 'Voice channel open' },
  thinking: { label: 'THINKING', detail: 'Planning and context synthesis active' },
  executing: { label: 'EXECUTING', detail: 'Agents are acting through the kernel' },
  approval_required: { label: 'APPROVAL REQUIRED', detail: 'Human decision is blocking execution' },
  reviewing: { label: 'REVIEWING', detail: 'Focused workspace analysis' },
  error: { label: 'ATTENTION', detail: 'A system component needs review' },
};

export function JarvisCore({
  mode,
  agents,
  counts,
  connected,
  onActivate,
}: {
  mode: JarvisMode;
  agents: any[];
  counts: Record<string, unknown>;
  connected: boolean;
  onActivate?: () => void;
}) {
  const activeAgents = agents.filter(a => a.status !== 'idle');
  const copy = MODE_COPY[mode];
  const visibleAgents = agents.slice(0, 10);

  return (
    <section className={`jarvis-core mode-${mode}`} aria-label={`JARVIS Core ${copy.label}`}>
      <div className="jarvis-orbit-field" aria-hidden="true">
        {visibleAgents.map((agent, index) => {
          const angle = (index / Math.max(visibleAgents.length, 1)) * Math.PI * 2 - Math.PI / 2;
          const radius = 43;
          const x = 50 + Math.cos(angle) * radius;
          const y = 50 + Math.sin(angle) * radius;
          return (
            <span
              key={agent.id ?? agent.name}
              className={`jarvis-agent-satellite ${agent.status !== 'idle' ? 'is-active' : ''}`}
              style={{ left: `${x}%`, top: `${y}%` }}
              title={`${agent.name}: ${agent.status}`}
            />
          );
        })}
      </div>

      <button className="jarvis-core-button" onClick={onActivate} aria-label="Open JARVIS command surface">
        <span className="jarvis-core-ring ring-a" />
        <span className="jarvis-core-ring ring-b" />
        <span className="jarvis-core-ring ring-c" />
        <span className="jarvis-core-nucleus">
          <span className="jarvis-core-mark">J</span>
        </span>
      </button>

      <div className="jarvis-core-readout">
        <div className="jarvis-eyebrow">JARVIS CORE</div>
        <h1>{copy.label}</h1>
        <p>{copy.detail}</p>
        <div className="jarvis-core-status-row">
          <JarvisStatusDot tone={connected ? 'live' : 'danger'} label={connected ? 'LIVE BUS' : 'OFFLINE'} />
          <JarvisStatusDot tone={mode === 'approval_required' ? 'waiting' : mode === 'error' ? 'danger' : 'thinking'} label={mode.replaceAll('_', ' ')} />
        </div>
      </div>

      <div className="jarvis-core-metrics">
        <JarvisMetric label="Agents" value={`${activeAgents.length}/${agents.length}`} tone={activeAgents.length ? 'live' : 'default'} />
        <JarvisMetric label="Tasks" value={String(counts.tasks ?? '—')} />
        <JarvisMetric label="Memory" value={String(counts.memories ?? '—')} />
        <JarvisMetric label="Events" value={String(counts.events ?? '—')} />
      </div>

      {agents.length > 0 && (
        <div className="jarvis-agent-strip" aria-label="Agent presence">
          {agents.slice(0, 6).map(agent => (
            <div key={agent.id ?? agent.name} className="jarvis-agent-chip">
              <JarvisStatusDot tone={toneForAgentStatus(agent.status)} />
              <span>{agent.name}</span>
              <span className="mono faint">{agent.status}</span>
            </div>
          ))}
        </div>
      )}
    </section>
  );
}
