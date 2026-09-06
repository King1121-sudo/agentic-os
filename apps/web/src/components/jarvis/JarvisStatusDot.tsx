export type JarvisStatusTone = 'idle' | 'live' | 'thinking' | 'executing' | 'waiting' | 'success' | 'danger';

const TONE_CLASS: Record<JarvisStatusTone, string> = {
  idle: 'is-idle',
  live: 'is-live',
  thinking: 'is-thinking',
  executing: 'is-executing',
  waiting: 'is-waiting',
  success: 'is-success',
  danger: 'is-danger',
};

export function JarvisStatusDot({ tone = 'idle', label }: { tone?: JarvisStatusTone; label?: string }) {
  return (
    <span className="jarvis-status-wrap">
      <span className={`jarvis-status-dot ${TONE_CLASS[tone]}`} aria-hidden="true" />
      {label && <span>{label}</span>}
    </span>
  );
}

export function toneForAgentStatus(status: string): JarvisStatusTone {
  if (status === 'failed') return 'danger';
  if (status === 'approval_required' || status === 'paused' || status === 'waiting') return 'waiting';
  if (status === 'completed') return 'success';
  if (status === 'thinking' || status === 'planning') return 'thinking';
  if (status === 'executing') return 'executing';
  return 'idle';
}
