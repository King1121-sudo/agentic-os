export type JarvisMode = 'idle' | 'listening' | 'thinking' | 'executing' | 'approval_required' | 'reviewing' | 'error';

export type JarvisFocus =
  | { kind: 'none' }
  | { kind: 'agent'; id: string }
  | { kind: 'execution'; id: string }
  | { kind: 'memory'; id: string }
  | { kind: 'project'; id: string }
  | { kind: 'task'; id: string }
  | { kind: 'graph-node'; id: string }
  | { kind: 'flow-run'; id: string }
  | { kind: 'automation'; id: string }
  | { kind: 'integration'; id: string };

export type VoiceState =
  | { status: 'unsupported' }
  | { status: 'idle' }
  | { status: 'permission_needed' }
  | { status: 'listening'; interim: string; finalText: string }
  | { status: 'submitting'; text: string }
  | { status: 'error'; message: string };
