"""Checks scripts/build_network.py on a hand-made OSM file (tests/fixtures/tiny.osm):
motorways and private roads are dropped, a road outside the land polygon is dropped, ways split where
they share a node, a footpath along an NParks park connector is marked as one and named, steps and
crossings keep their kinds, an unnamed service road is a service road, a footpath inside a housing estate
is flagged "estate", a footpath inside a school is dropped, and the estate steps that join the park
connector to the street are flagged as a link the default mode may still use."""
import json, os, subprocess, sys, tempfile

here = os.path.dirname(os.path.abspath(__file__))
fx = lambda name: os.path.join(here, 'fixtures', name)
out = tempfile.mkdtemp()
subprocess.run([sys.executable, os.path.join(here, '..', 'scripts', 'build_network.py'),
                '--osm', fx('tiny.osm'), '--pcn', fx('tiny-pcn.geojson'), '--land', fx('tiny-land.geojson'),
                '--out', os.path.join(out, 'net.json'), '--stats', os.path.join(out, 'stats.json')], check=True)
rows = json.load(open(os.path.join(out, 'net.json'))); meta = rows[0]
F = meta['flags']; flags = lambda r: ','.join(k for k in sorted(F) if r[0] & F[k])
got = sorted((meta['kinds'][r[0] & 15], meta['names'][r[1]] if r[1] >= 0 else '', flags(r)) for r in rows[1:])
want = sorted([('road', 'Test Street', ''), ('road', 'Test Street', ''), ('crossing', '', ''), ('crossing', '', ''),
               ('park connector', 'Test Park Connector', ''), ('steps', '', 'estate,link'), ('service road', '', ''),
               ('path', '', 'estate')])
stats = json.load(open(os.path.join(out, 'stats.json')))
checks = [('edges, kinds and link flag', got == want),
          ('one connected network', stats['components'] == 1),
          ('no expressway', all('Expressway' not in n for n in meta['names'])),
          ('road outside the land polygon dropped', all('Strait' not in n for n in meta['names']) and stats['outside_land_km_dropped'] > 0.5),
          ('park connector reachable in roads mode', stats['roads_mode_pcn_reachable_pct'] == 100.0),
          ('coverage measured', stats['pcn_with_osm_way_within_12m_pct'] == 100.0 and stats['pcn_marked_as_park_connector_pct'] == 100.0),
          ('school footpath dropped', stats['closed_land_km_dropped'] > 0 and stats['closed_areas'] == 1 and stats['estate_areas'] == 1),
          ('format tag', meta['format'] == 'run-net-2')]
# pack to run-net-3 and read both files back with core.js
subprocess.run([sys.executable, os.path.join(here, '..', 'scripts', 'pack_network.py'), os.path.join(out, 'net.json'), os.path.join(out, 'net.bin.gz')], check=True)
js = r'''
const fs = require('fs'), zlib = require('zlib'), RC = require(process.argv[1] + '/core.js');
const a = RC.Network.fromText(fs.readFileSync(process.argv[2], 'utf8')), b = RC.Network.fromBinary(zlib.gunzipSync(fs.readFileSync(process.argv[3])));
const sig = (n) => Array.from({ length: n.E }, (_, e) => `${n.eKind[e]}|${n.eFlag[e]}|${n.nameOf(e) || ''}|${Math.round(n.eLen[e])}`).sort().join(';');
console.log(JSON.stringify({ same: a.E === b.E && a.N === b.N && sig(a) === sig(b), format: b.meta.format, E: b.E }));
'''
res = json.loads(subprocess.run(['node', '-e', js, os.path.join(here, '..'), os.path.join(out, 'net.json'), os.path.join(out, 'net.bin.gz')],
                                check=True, capture_output=True, text=True).stdout)
checks.append(('binary run-net-3 reads back the same network', res['same'] and res['format'] == 'run-net-3'))
for name, ok in checks: print(('PASS ' if ok else 'FAIL ') + name)
if not all(ok for _, ok in checks): print('got', got); print(json.dumps(stats)); sys.exit(1)
print('ALL PASSED')
