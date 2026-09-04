'use client';
import Shell from '@/components/Shell';
import Link from 'next/link';
import { useState } from 'react';
import { api, post, usePoll } from '@/lib/api';

export default function ProjectsPage() {
  const projects = usePoll(() => api('/api/projects'), 5000) as any[] | null;
  const [name, setName] = useState('');
  const [desc, setDesc] = useState('');

  async function create() {
    if (!name.trim()) return;
    await post('/api/projects', { name, description: desc });
    setName(''); setDesc('');
  }

  return (
    <Shell title="Projects">
      <div className="between" style={{ marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700 }}>Project Workspaces</h1>
          <div className="xs faint">Each project is a mini OS: tasks, sprints, agents, memory, links</div>
        </div>
      </div>

      <div className="card" style={{ marginBottom: 14 }}>
        <h3>New Project</h3>
        <div className="row">
          <input placeholder="Project name" value={name} onChange={e => setName(e.target.value)} style={{ flex: 2 }} />
          <input placeholder="Description (optional)" value={desc} onChange={e => setDesc(e.target.value)} style={{ flex: 3 }} />
          <button className="primary" onClick={create}>Create</button>
        </div>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(300px, 1fr))' }}>
        {(projects ?? []).map((p: any) => (
          <Link key={p.id} href={`/projects/${p.id}`} className="card" style={{ display: 'block' }}>
            <div className="between">
              <span style={{ fontWeight: 700 }}>{p.name}</span>
              <span className="badge b-green">{p.status}</span>
            </div>
            <div className="xs dim" style={{ marginTop: 6, minHeight: 28 }}>{p.description || '—'}</div>
          </Link>
        ))}
      </div>
    </Shell>
  );
}
