'use client';
import Shell from '@/components/Shell';
import { api, usePoll } from '@/lib/api';

export default function SkillsPage() {
  const skills = usePoll(() => api('/api/skills'), 8000) as any[] | null;
  const tools = usePoll(() => api('/api/tools'), 8000) as any[] | null;

  // group by category → skill tree
  const cats: Record<string, any[]> = {};
  for (const s of skills ?? []) (cats[s.category] ??= []).push(s);

  return (
    <Shell title="Skills">
      <div className="between" style={{ marginBottom: 14 }}>
        <div>
          <h1 style={{ fontSize: 18, fontWeight: 700 }}>Skills & Tools</h1>
          <div className="xs faint">Composable capabilities — skills chain tools + model steps; tools are permission-gated</div>
        </div>
      </div>

      <div className="grid cols-2">
        <div className="card">
          <h3>Skill Tree <span className="count">{skills?.length ?? 0}</span></h3>
          {Object.entries(cats).map(([cat, list]) => (
            <div key={cat} style={{ marginBottom: 10 }}>
              <div className="xs" style={{ fontWeight: 700, color: 'var(--fg-dim)', marginBottom: 3 }}>├ {cat}</div>
              {list.map((s: any) => (
                <div key={s.id} className="item">
                  <span className="badge b-green">v{s.version}</span>
                  <div className="grow">
                    <div className="small" style={{ fontWeight: 600 }}>{s.name}</div>
                    <div className="xs faint">{s.description}</div>
                    <div className="xs mono dim" style={{ marginTop: 3 }}>
                      {s.steps.map((st: any, i: number) => (
                        <span key={i}>{i > 0 && ' → '}{st.tool ?? st.capability ?? st.kind}</span>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          ))}
          {skills && skills.length === 0 && <div className="empty">No skills yet.</div>}
        </div>

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
      </div>
    </Shell>
  );
}
