'use client';
import Link from 'next/link';
import { JarvisPanel } from './JarvisPanel';
import { JarvisCore } from './JarvisCore';
import { JarvisCommandSurface } from './JarvisCommandSurface';
import { JarvisMetric } from './JarvisMetric';
import { JarvisStatusDot, toneForAgentStatus } from './JarvisStatusDot';
import { selectAttentionItems, selectJarvisMode } from '@/lib/jarvis-selectors';
import { useExecutionStore } from '@/lib/execution-store';

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
  const execStore = useExecutionStore();
  // Live execution state takes precedence (real runtime, ≤poll-latency);
  // the polled selector remains the fallback (idle system, approval queue…).
  const liveStates = execStore.order
    .map(id => execStore.executions[id]?.state)
    .filter(Boolean) as string[];
  const liveMode = liveStates.some(s => s === 'approval_required') ? 'approval_required'
    : liveStates.some(s => s === 'failed') ? 'error'
    : liveStates.some(s => s === 'executing' || s === 'completing') ? 'executing'
    : liveStates.some(s => s === 'planning' || s === 'understanding') ? 'thinking'
    : liveStates.some(s => s === 'waiting') ? 'waiting'
    : null;
  const mode = liveMode ?? selectJarvisMode({ health, approvals, agents, events });
  const attention = selectAttentionItems({ approvals, notes, events });
  const activeAgents = agents.filter(a => a.status !== 'idle');
  const nextTasks = openTasks.slice(0, 5);
  const recentEvents = events.slice(0, 7);
  // deadlines: tasks with a due date within 48h, or overdue
  const now = Date.now();
  const deadlines = openTasks
    .filter((t: any) => t.deadline)
    .map((t: any) => ({ ...t, due: Date.parse(String(t.deadline)) }))
    .filter((t: any) => t.due - now < 48 * 3600 * 1000)
    .sort((a: any, b: any) => a.due - b.due)
    .slice(0, 4);
  const attentionApprovals = (approvals ?? []);
  // dashboard counts carry executions/memories/generations/tool_runs; health
  // counts carry tasks/events/entities — merge so every metric has data.
  const mergedCounts = { ...(health?.counts ?? {}), ...counts };

  return (
    <div className="jarvis-cockpit" aria-label="JARVIS command center">
      <div className="jarvis-cockpit-grid">
        <aside className="jarvis-stack jarvis-left-bank" aria-label="Attention and schedule">
          <JarvisPanel
            title={attentionApprovals.length ? "Attention Required" : "All Quiet"}
            eyebrow={attentionApprovals.length ? `${attentionApprovals.length} decision${attentionApprovals.length > 1 ? 's' : ''} pending` : 'System state'}
            count={attention.length || undefined}
          >
            {attention.length === 0 ? (
              <div className="empty">No approvals or urgent alerts. The OS is operating normally.</div>
            ) : (
              <div className="jarvis-list compact-list">
                {attention.slice(0, 6).map((item, i) => (
                  <div key={`${item.kind}-${i}`} className="jarvis-row-link" style={{ cursor: 'default' }}>
                    <JarvisStatusDot tone={item.kind === 'approval' ? 'waiting' : item.kind === 'event' ? 'danger' : 'live'} />
                    <span className="grow">{item.title}</span>
                    <span className="xs faint mono">{item.kind}</span>
                    {item.kind === 'approval' && (
                      <span className="row" style={{ gap: 4 }}>
                        <button className="xs" onClick={() => decideApproval(item.item.id, 'approve')}>✓</button>
                        <button className="xs danger" onClick={() => decideApproval(item.item.id, 'deny')}>✕</button>
                      </span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </JarvisPanel>

          <JarvisPanel title="Mission Queue" eyebrow="Deadlines" count={deadlines.length || undefined}>
            {deadlines.length === 0 ? (
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
            ) : (
              <div className="jarvis-list compact-list">
                {deadlines.map(task => {
                  const overdue = task.due < now;
                  const hours = Math.round((task.due - now) / 3600000);
                  return (
                    <Link className="jarvis-row-link" href={`/projects/${task.project_id}`} key={task.id}>
                      <JarvisStatusDot tone={overdue ? 'danger' : 'waiting'} />
                      <span className="grow">{task.title}</span>
                      <span className="xs mono" style={{ color: overdue ? 'var(--red)' : 'var(--orange)' }}>
                        {overdue ? `overdue ${Math.abs(hours)}h` : `due in ${hours}h`}
                      </span>
                    </Link>
                  );
                })}
              </div>
            )}
          </JarvisPanel>

          <JarvisPanel title="Context Field" eyebrow="Workspace">
            <div className="jarvis-metric-grid">
              <JarvisMetric label="Open Tasks" value={openTasks.length} tone={openTasks.length ? 'live' : 'default'} />
              <JarvisMetric label="Projects" value={projects.length} />
              <JarvisMetric label="Memories" value={String(mergedCounts.memories ?? '—')} />
              <JarvisMetric label="Entities" value={String(mergedCounts.extracted_entities ?? '—')} />
            </div>
          </JarvisPanel>
        </aside>

        <main className="jarvis-center-bank" aria-label="Core and command">
          <JarvisCore mode={mode} agents={agents} counts={mergedCounts} connected={true} onActivate={() => document.getElementById('jarvis-command-input-anchor')?.scrollIntoView({ block: 'center', behavior: 'smooth' })} />
          <div id="jarvis-command-input-anchor">
            <JarvisCommandSurface />
          </div>
        </main>

        <aside className="jarvis-stack jarvis-right-bank" aria-label="Agents and automations">
          <JarvisPanel
            title="Agent Presence"
            eyebrow="Swarm"
            count={`${activeAgents.length}/${agents.length}`}
            actions={<Link href="/agents" className="btn">Open</Link>}
          >
            <div className="jarvis-list">
              {agents.slice(0, 7).map(agent => (
                <Link href={`/agents/${agent.id}`} key={agent.id} className="jarvis-row-link">
                  <JarvisStatusDot tone={toneForAgentStatus(agent.status)} />
                  <span className="grow">{agent.name}</span>
                  <span className="xs faint mono">{agent.status}</span>
                </Link>
              ))}
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

          <JarvisPanel title="Realtime Feed" eyebrow="Kernel Events" count={recentEvents.length}>
            <div className="jarvis-event-rail">
              {recentEvents.map(ev => (
                <div className="jarvis-event-row" key={ev.id}>
                  <span className={`jarvis-event-pin ${eventTone(ev.type)}`} />
                  <div className="grow">
                    <div className="mono xs" style={{ color: 'var(--fg-dim)' }}>{ev.type}</div>
                    <div className="xs faint">{summarizeEvent(ev)}</div>
                  </div>
                </div>
              ))}
              {recentEvents.length === 0 && <div className="empty">The event bus is quiet.</div>}
            </div>
          </JarvisPanel>
        </aside>
      </div>

      <div className="jarvis-hud-strip" aria-label="System status">
        <JarvisMetric label="Kernel" value={`v${health?.version ?? d?.version ?? '0.13'}`} tone={health?.db === 'up' ? 'live' : 'warn'} />
        <JarvisMetric label="Database" value={health?.db ?? '…'} tone={health?.db === 'up' ? 'live' : 'danger'} />
        <JarvisMetric label="Broker" value={health ? 'up' : '…'} tone="live" />
        <JarvisMetric label="Notifications" value={notes.length} tone={notes.length ? 'warn' : 'default'} />
        {onEditDashboard && <button onClick={onEditDashboard}>Configure widgets</button>}
      </div>
    </div>
  );
}

function eventTone(type: string): string {
  if (String(type).includes('failed') || String(type).includes('denied')) return 'tone-danger';
  if (String(type).startsWith('approval')) return 'tone-warn';
  if (String(type).startsWith('agent') || String(type).startsWith('tool')) return 'tone-info';
  if (String(type).startsWith('memory')) return 'tone-info';
  return '';
}

async function decideApproval(id: string, decision: 'approve' | 'deny') {
  try {
    await fetch(`/api/approvals/${id}/decision`, {
      method: 'POST', credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ decision }),
    });
  } catch { /* the bell refreshes on next poll */ }
}

function summarizeEvent(ev: any): string {
  const data = ev?.data ?? {};
  if (data.input) return `${data.agent ? `${data.agent}: ` : ''}${String(data.input).slice(0, 92)}`;
  if (data.tool) return `${data.tool}${data.summary ? ` → ${data.summary}` : data.error ? ` ✗ ${data.error}` : ''}`;
  if (data.summary) return data.summary;
  if (data.agent) return `${data.agent}${data.phase ? ` · ${data.phase}` : ''}`;
  return JSON.stringify(data).slice(0, 96);
}
