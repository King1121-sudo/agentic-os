'use client';
import Link from 'next/link';
import { JarvisPanel } from './JarvisPanel';
import { JarvisCore } from './JarvisCore';
import { JarvisCommandSurface } from './JarvisCommandSurface';
import { JarvisMetric } from './JarvisMetric';
import { JarvisStatusDot, toneForAgentStatus } from './JarvisStatusDot';
import { selectAttentionItems, selectJarvisMode } from '@/lib/jarvis-selectors';
import { fmtAgo } from '@/lib/api';

export function JarvisCockpitDashboard({
  d,
  health,
  approvals,
  autos,
  openTasks,
  agents,
  projects,
  notes,
  events,
  counts,
  onEditDashboard,
}: {
  d: any;
  health: any;
  approvals: any[] | null;
  autos: any[] | null;
  openTasks: any[];
  agents: any[];
  projects: any[];
  notes: any[];
  events: any[];
  counts: Record<string, unknown>;
  onEditDashboard?: () => void;
}) {
  const mode = selectJarvisMode({ health, approvals, agents, events });
  const attention = selectAttentionItems({ approvals, notes, events });
  const activeAgents = agents.filter(a => a.status !== 'idle');
  const nextTasks = openTasks.slice(0, 5);
  const recentEvents = events.slice(0, 7);
  // dashboard counts carry executions/memories/generations/tool_runs; health
  // counts carry tasks/events/entities — merge so every metric has data.
  const mergedCounts = { ...(health?.counts ?? {}), ...counts };

  return (
    <div className="jarvis-cockpit" aria-label="JARVIS command center">
      <div className="jarvis-cockpit-grid">
        <aside className="jarvis-stack jarvis-left-bank">
          <JarvisPanel title="Context Field" eyebrow="Workspace" count={projects.length}>
            <div className="jarvis-metric-grid">
              <JarvisMetric label="Open Tasks" value={openTasks.length} tone={openTasks.length ? 'live' : 'default'} />
              <JarvisMetric label="Projects" value={projects.length} />
              <JarvisMetric label="Memories" value={String(mergedCounts.memories ?? '—')} />
              <JarvisMetric label="Entities" value={String(mergedCounts.extracted_entities ?? '—')} />
            </div>
            <div className="jarvis-list compact-list">
              {nextTasks.map(task => (
                <Link className="jarvis-row-link" href={`/projects/${task.project_id}`} key={task.id}>
                  <JarvisStatusDot tone={task.status === 'in_progress' ? 'executing' : task.status === 'blocked' ? 'waiting' : 'idle'} />
                  <span className="grow">{task.title}</span>
                  <span className="xs faint">{task.priority}</span>
                </Link>
              ))}
              {nextTasks.length === 0 && <div className="empty">Mission queue clear.</div>}
            </div>
          </JarvisPanel>

          <JarvisPanel title="Realtime Feed" eyebrow="Kernel Events" count={recentEvents.length}>
            <div className="jarvis-event-rail">
              {recentEvents.map(ev => (
                <div className="jarvis-event-row" key={ev.id}>
                  <span className="jarvis-event-pin" />
                  <div className="grow">
                    <div className="mono xs">{ev.type}</div>
                    <div className="xs faint">{summarizeEvent(ev)}</div>
                  </div>
                </div>
              ))}
              {recentEvents.length === 0 && <div className="empty">The event bus is quiet.</div>}
            </div>
          </JarvisPanel>
        </aside>

        <main className="jarvis-center-bank">
          <JarvisCore mode={mode} agents={agents} counts={mergedCounts} connected={true} onActivate={() => document.getElementById('jarvis-command-input-anchor')?.scrollIntoView({ block: 'center' })} />
          <div id="jarvis-command-input-anchor">
            <JarvisCommandSurface />
          </div>
        </main>

        <aside className="jarvis-stack jarvis-right-bank">
          <JarvisPanel
            title="Agent Presence"
            eyebrow="Swarm"
            count={`${activeAgents.length}/${agents.length}`}
            actions={<Link href="/agents" className="btn">Open</Link>}
          >
            <div className="jarvis-agent-list">
              {agents.slice(0, 7).map(agent => (
                <Link href={`/agents/${agent.id}`} key={agent.id} className="jarvis-row-link">
                  <JarvisStatusDot tone={toneForAgentStatus(agent.status)} />
                  <span className="grow">{agent.name}</span>
                  <span className="xs faint mono">{agent.status}</span>
                </Link>
              ))}
            </div>
          </JarvisPanel>

          <JarvisPanel title="Attention" eyebrow="Approvals / Alerts" count={attention.length}>
            <div className="jarvis-list compact-list">
              {attention.slice(0, 6).map((item, i) => (
                <Link href={item.kind === 'approval' ? '/activity' : '/activity'} className="jarvis-row-link" key={`${item.kind}-${i}`}>
                  <JarvisStatusDot tone={item.kind === 'approval' ? 'waiting' : item.kind === 'event' ? 'danger' : 'live'} />
                  <span className="grow">{item.title}</span>
                  <span className="xs faint">{item.kind}</span>
                </Link>
              ))}
              {attention.length === 0 && <div className="empty">No approvals or urgent alerts.</div>}
            </div>
          </JarvisPanel>

          <JarvisPanel title="Autonomous Layer" eyebrow="Sentinels" count={autos?.length ?? 0}>
            {(autos ?? []).slice(0, 5).map(auto => (
              <Link href="/automations" key={auto.id} className="jarvis-row-link">
                <JarvisStatusDot tone={auto.enabled ? 'executing' : 'idle'} />
                <span className="grow">{auto.name}</span>
                <span className="xs faint">{auto.trigger} · {auto.run_count}</span>
              </Link>
            ))}
            {(autos ?? []).length === 0 && <div className="empty">No automation sentinels yet.</div>}
          </JarvisPanel>
        </aside>
      </div>

      <div className="jarvis-hud-strip">
        <JarvisMetric label="Kernel" value={`v${health?.version ?? d?.version ?? '0.11.0'}`} tone={health?.db === 'up' ? 'live' : 'warn'} />
        <JarvisMetric label="Database" value={health?.db ?? '…'} tone={health?.db === 'up' ? 'live' : 'danger'} />
        <JarvisMetric label="Broker" value={health ? 'up' : '…'} tone="live" />
        <JarvisMetric label="Notifications" value={notes.length} tone={notes.length ? 'warn' : 'default'} />
        {onEditDashboard && <button onClick={onEditDashboard}>Configure widgets</button>}
      </div>
    </div>
  );
}

function summarizeEvent(ev: any): string {
  const data = ev?.data ?? {};
  if (data.input) return `${data.agent ? `${data.agent}: ` : ''}${String(data.input).slice(0, 92)}`;
  if (data.tool) return `${data.tool}${data.summary ? ` → ${data.summary}` : data.error ? ` ✗ ${data.error}` : ''}`;
  if (data.summary) return data.summary;
  if (data.agent) return `${data.agent}${data.phase ? ` · ${data.phase}` : ''}`;
  return JSON.stringify(data).slice(0, 96);
}
