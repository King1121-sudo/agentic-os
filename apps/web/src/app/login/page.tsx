'use client';
import { useState } from 'react';
import { post } from '@/lib/api';

export default function LoginPage() {
  const [username, setUsername] = useState('admin');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function login(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      await post('/api/auth/login', { username, password });
      location.href = '/';
    } catch (err: any) {
      setError(err.message ?? 'login failed');
    } finally { setBusy(false); }
  }

  return (
    <main style={{ minHeight: '100vh', display: 'grid', placeItems: 'center', background: 'var(--bg)' }}>
      <div className="card" style={{ width: 360, padding: 28 }}>
        <div className="row" style={{ gap: 10, marginBottom: 18 }}>
          <div style={{
            width: 34, height: 34, borderRadius: 9, fontWeight: 700, fontSize: 14, color: '#fff',
            background: 'linear-gradient(135deg, var(--accent), var(--purple))', display: 'grid', placeItems: 'center',
          }}>Æ</div>
          <div>
            <div style={{ fontWeight: 700, fontSize: 16 }}>Agentic OS</div>
            <div className="xs faint">kernel v0.1 · boot console</div>
          </div>
        </div>
        <form onSubmit={login} style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          <div>
            <label>Username</label>
            <input value={username} onChange={e => setUsername(e.target.value)} autoFocus />
          </div>
          <div>
            <label>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} />
          </div>
          {error && <div className="xs" style={{ color: 'var(--red)' }}>{error}</div>}
          <button className="primary" disabled={busy || !password}>{busy ? 'Authenticating…' : 'Boot session'}</button>
          <div className="xs faint" style={{ textAlign: 'center' }}>
            default credentials: admin / admin123
          </div>
        </form>
      </div>
    </main>
  );
}
