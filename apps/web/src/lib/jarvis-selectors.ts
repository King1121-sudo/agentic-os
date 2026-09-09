import type { JarvisMode } from './jarvis-types';

export function selectJarvisMode(input: {
  health?: any;
  approvals?: any[] | null;
  agents?: any[] | null;
  events?: any[] | null;
}): JarvisMode {
  if (input.health && input.health.db && input.health.db !== 'up') return 'error';
  if ((input.approvals ?? []).length > 0) return 'approval_required';
  const agents = input.agents ?? [];
  if (agents.some(a => a.status === 'executing')) return 'executing';
  if (agents.some(a => a.status === 'thinking' || a.status === 'planning')) return 'thinking';
  const last = (input.events ?? [])[0];
  if (last?.type === 'agent.token' || last?.type === 'agent.thinking') return 'thinking';
  if (last?.type?.includes?.('failed')) return 'error';
  if (agents.some(a => a.status === 'waiting' || a.status === 'paused')) return 'waiting';
  return 'idle';
}

export function selectAttentionItems(input: { approvals?: any[] | null; notes?: any[] | null; events?: any[] | null }) {
  const approvals = (input.approvals ?? []).map(item => ({ kind: 'approval', title: item.tool ?? 'Approval required', item }));
  const notes = (input.notes ?? [])
    .filter(n => n.priority === 'high' || n.priority === 'urgent')
    .map(item => ({ kind: 'notification', title: item.title ?? 'Notification', item }));
  const failures = (input.events ?? [])
    .filter(e => String(e.type ?? '').includes('failed'))
    .slice(0, 3)
    .map(item => ({ kind: 'event', title: item.type, item }));
  return [...approvals, ...notes, ...failures];
}
