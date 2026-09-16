"""Remove the unused imports/destructured deps the split's coarse detection left."""
import re

# (file, 1-based line, must-contain) — full-line removals
LINE_DROPS = [
    ('apps/api/src/routes/agents.ts', 7, 'memory'),
    ('apps/api/src/routes/agents.ts', 8, 'graph'),
    ('apps/api/src/routes/auth.ts', 9, 'projects'),
    ('apps/api/src/routes/command.ts', 8, 'automations'),
    ('apps/api/src/routes/command.ts', 9, 'graph'),
    ('apps/api/src/routes/flows.ts', 7, 'graph'),
    ('apps/api/src/routes/integrations.ts', 7, 'config'),
    ('apps/api/src/routes/memory.ts', 9, 'graph'),
    ('apps/api/src/routes/projects.ts', 9, 'automations'),
    ('apps/api/src/routes/supervision.ts', 6, 'projects'),
    ('apps/api/src/routes/supervision.ts', 7, 'flows'),
    ('apps/api/src/routes/telemetry.ts', 7, 'projects'),
]

by_file = {}
for f, n, must in LINE_DROPS:
    by_file.setdefault(f, []).append((n, must))

for f, items in by_file.items():
    lines = open(f, encoding='utf-8').read().split('\n')
    for n, must in sorted(items, reverse=True):
        line = lines[n-1]
        assert must in line and line.startswith('import '), f'{f}:{n} got {line!r}'
        del lines[n-1]
        print(f'  drop import  {f}:{n}  {line.strip()[:60]}')
    open(f, 'w', encoding='utf-8').write('\n'.join(lines))

# destructured deps that no longer appear in the module body
DESTRUCTURE_DROPS = [
    ('apps/api/src/routes/auth.ts', 'broker'),
    ('apps/api/src/routes/integrations.ts', 'tools'),
    ('apps/api/src/routes/notifications.ts', 'router'),
]
for f, name in DESTRUCTURE_DROPS:
    src = open(f, encoding='utf-8').read()
    m = re.search(r'^  const \{ ([^}]+) \} = ctx;$', src, re.M)
    assert m, f'{f}: no destructure found'
    names = [n.strip() for n in m.group(1).split(',')]
    assert name in names, f'{f}: {name} not in {names}'
    names.remove(name)
    src = src[:m.start()] + f"  const {{ {', '.join(names)} }} = ctx;" + src[m.end():]
    open(f, 'w', encoding='utf-8').write(src)
    print(f'  drop dep     {f}  ({name})')
print('\ndone')
