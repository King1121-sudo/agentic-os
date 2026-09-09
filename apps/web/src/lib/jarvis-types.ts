export type JarvisMode =
  | 'idle'
  | 'listening'
  | 'thinking'
  | 'executing'
  | 'waiting'
  | 'approval_required'
  | 'reviewing'
  | 'error';

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

/**
 * Voice interaction states. IDLE / LISTENING / PROCESSING / ERROR are live
 * today (Web Speech API + the shared command route). SPEAKING and INTERRUPTED
 * are reserved for TTS output — never rendered until a real TTS channel exists
 * (no fake states).
 */
export type VoiceState =
  | { status: 'unsupported' }
  | { status: 'idle' }
  | { status: 'permission_needed' }
  | { status: 'listening'; interim: string; finalText: string }
  | { status: 'submitting'; text: string }
  | { status: 'speaking'; text: string }
  | { status: 'interrupted' }
  | { status: 'error'; message: string };
