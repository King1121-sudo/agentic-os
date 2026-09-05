'use client';
import Shell from '@/components/Shell';
import { useState } from 'react';
import { api, post, usePoll } from '@/lib/api';

export default function SkillsPage() {
  const skills = usePoll(() => api('/api/skills'), 8000) as any[] | null;
  const tools = usePoll(() => api('/api/tools'), 8000) as any[] | null;
  const metrics = usePoll(() => api('/api/skills/metrics'), 8000) as any[] | null;
  const versions = usePoll(() => api('/api/skills/versions'), 8000) as any[] | null;
  const [reloadMsg, setReloadMsg] = useState<string | null>(null);

  // group by category → skill tree
  const cats: Record<string, any[]> = {};
  for (const s of skills ?? []) (cats[s.category] ??= []).push(s);
  const byId = new Map((skills ?? []).map(s => [s.id, s]));
  const nameOf = (id: string | null) => (id ? byId.get(id)?.name ?? id.slice(0, 8) : null);

  async function reload() {
    setReloadMsg('reloading…');
    try {
      const r = await post<any>('/api/skills/reload', {});
      setReloadMsg(`loaded ${r.loaded} · created ${r.created} · version-bumped ${r.bumped}${r.errors?.length ? ' · errors: ' + r.errors.join('; ') : ''}`);
    } catch (e: any) { setReloadMsg('error: ' + e.message); }
  }

  return (
    <Shell title="Skills">
      <div className="between" style={{ marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700 }}>Skills & Tools</h1>
          <div className="xs faint">
            Composable capabilities — inheritance chains, versioning, hot-loadable JSON/YAML from <span className="mono">skills/</span>
          </div>
        </div>
        <button className="primary" onClick={reload}>⟳ Reload skills</button>
      </div>
      {reloadMsg && <div className="notice" style={{ marginBottom: 12 }}>{reloadMsg}</div>}

      <div className="grid cols-2">
        <div className="card">
          <h3>Skill Tree <span className="count">{skills?.length ?? 0}</span></h3>
          {Object.entries(cats).map(([cat, list]) => (
            <div key={cat} style={{ marginBottom: 10 }}>
              <div className="xs" style={{ fontWeight: 700, color: 'var(--fg-dim)', marginBottom: 3 }}>├ {cat}</div>
              {list.map((s: any) => {
                const parent = nameOf(s.parent_id);
                const m = (metrics ?? []).find((x: any) => x.skill_id === s.id);
                return (
                  <div key={s.id} className="item" style={{ display: 'block' }}>
                    <div className="row between">
                      <div className="row">
                        <span className="badge b-green">v{s.version}</span>
                        <span style={{ fontWeight: 600 }} className="small">{s.name}</span>
                      </div>
                      {parent && <span className="badge b-purple">⇧ {parent}</span>}
                    </div>
                    <div className="xs faint" style={{ marginTop: 3 }}>{s.description}</div>
                    <div className="xs mono dim" style={{ marginTop: 3 }}>
                      {s.steps.map((st: any, i: number) => (
                        <span key={i}>{i > 0 && ' → '}{st.tool ?? st.capability ?? st.kind}</span>
                      ))}
                    </div>
                    {m && (
                      <div className="xs faint" style={{ marginTop: 3 }}>
                        runs {m.runs} · ✓ {m.completed} ✗ {m.failed} ⊘ {m.denied} · {m.success_rate}% ok · avg {m.avg_latency_ms}ms
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          ))}
          {skills && skills.length === 0 && <div className="empty">No skills loaded. Place JSON/YAML files in skills/ and hit Reload.</div>}
        </div>

        <div className="grid">
          <div className="card">
            <h3>Tool Registry <span className="count">{tools?.length ?? 0}</span></h3>
            {(tools ?? []).map((t: any) => (
              <div key={t.name} className="item">
                <span className={`badge ${t.risk === 'high' ? 'b-red' : t.risk === 'medium' ? 'b-amber' : 'b-gray'}`}>{t.risk}</span>
                <div className="grow">
                  <div className="row between">
                    <span className="mono small" style={{ fontWeight: 600 }}>{t.name}</span>
                    <span className="xs mono faint">{t.scope}</span>
                  </div>
                  <div className="xs faint">{t.description}</div>
                </div>
              </div>
            ))}
          </div>

          <div className="card">
            <h3>Skill Metrics <span className="count">execution history</span></h3>
            <table className="tbl">
              <thead><tr><th>Skill</th><th>Ver</th><th>Runs</th><th>✓/✗/⊘</th><th>Success</th><th>Avg</th></tr></thead>
              <tbody>
                {(metrics ?? []).map((m: any) => (
                  <tr key={m.skill_id}>
                    <td className="xs">{m.name ?? m.skill_id.slice(0, 8)}</td>
                    <td className="xs mono">{m.version}</td>
                    <td className="xs mono">{m.runs}</td>
                    <td className="xs mono">{m.completed}/{m.failed}/{m.denied}</td>
                    <td className="xs mono">{m.success_rate ?? '—'}%</td>
                    <td className="xs mono">{m.avg_latency_ms}ms</td>
                  </tr>
                ))}
                {(metrics ?? []).length === 0 && <tr><td colSpan={6} className="empty">No skill runs yet.</td></tr>}
              </tbody>
            </table>
          </div>

          <div className="card">
            <h3>Version History <span className="count">{versions?.length ?? 0}</span></h3>
            {(versions ?? []).slice(0, 12).map((v: any) => (
              <div key={v.id} className="item">
                <span className="badge b-gray">v{v.version}</span>
                <div className="grow">
                  <div className="small">{v.name} <span className="faint xs">→ superseded</span></div>
                  <div className="xs faint mono">{v.created_at?.slice(0, 19).replace('T', ' ')}</div>
                </div>
              </div>
            ))}
            {(versions ?? []).length === 0 && <div className="empty">No superseded versions yet — edit a skill file and Reload to create history.</div>}
          </div>
        </div>
      </div>
    </Shell>
  );
}
