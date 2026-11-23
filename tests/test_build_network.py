"""Checks scripts/build_network.py on a hand-made OSM file (tests/fixtures/tiny.osm):
motorways and private roads are dropped, ways split where they share a node, a footpath along an
NParks park connector is marked as one and named, steps and crossings keep their kinds."""
import json, os, subprocess, sys, tempfile

here = os.path.dirname(os.path.abspath(__file__))
out = tempfile.mkdtemp()
subprocess.run([sys.executable, os.path.join(here, '..', 'scripts', 'build_network.py'),
                '--osm', os.path.join(here, 'fixtures', 'tiny.osm'), '--pcn', os.path.join(here, 'fixtures', 'tiny-pcn.geojson'),
                '--out', os.path.join(out, 'net.json'), '--stats', os.path.join(out, 'stats.json')], check=True, capture_output=True)
rows = json.load(open(os.path.join(out, 'net.json'))); meta = rows[0]
got = sorted((meta['kinds'][r[0]], meta['names'][r[1]] if r[1] >= 0 else '') for r in rows[1:])
want = sorted([('road', 'Test Street'), ('road', 'Test Street'), ('crossing', ''), ('crossing', ''),
               ('park connector', 'Test Park Connector'), ('steps', '')])
stats = json.load(open(os.path.join(out, 'stats.json')))
checks = [('edges and kinds', got == want), ('one connected network', stats['components'] == 1),
          ('no expressway', all('Expressway' not in n for n in meta['names'])), ('format tag', meta['format'] == 'run-net-2')]
for name, ok in checks: print(('PASS ' if ok else 'FAIL ') + name)
if not all(ok for _, ok in checks): print('got', got); sys.exit(1)
print('ALL PASSED')
