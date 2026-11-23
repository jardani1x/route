"""Build the walk/run network (net-v2.json) from OpenStreetMap + NParks park connectors.

Usage:
  python scripts/build_network.py --osm singapore.osm.pbf --pcn pcn.geojson --out data/net-v2.json --stats data/stats.json

Unlike v1 (named-street polylines noded geometrically), v2 uses OSM's own topology: ways that share a
node are connected, bridges and tunnels are not. It keeps footpaths, park paths, steps, sidewalks and
crossings, and marks the paths that follow NParks park connectors.

Output format "run-net-2": one JSON array, one record per line.
  record 0: meta {format, kinds, names, built, sources, stats}
  record i: [kind, nameIdx, lat0E6, lon0E6, dlat1, dlon1, ...]
Kinds: 0 road · 1 park connector · 2 crossing · 3 path · 4 steps · 5 sidewalk
"""
import argparse, collections, datetime, gzip, json, math, os, sys, time

import osmium
from pyproj import Transformer
from shapely.geometry import LineString, Point, shape
from shapely.strtree import STRtree

ROADS = {'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
         'residential', 'living_street', 'service', 'road', 'trunk', 'trunk_link'}
PATHS = {'footway', 'path', 'pedestrian', 'cycleway', 'track', 'bridleway', 'steps'}
FOOT_OK = {'yes', 'designated', 'permissive'}
KINDS = ['road', 'park connector', 'crossing', 'path', 'steps', 'sidewalk']
TO_M = Transformer.from_crs('EPSG:4326', 'EPSG:3414', always_xy=True)   # SVY21 metres
SIMPLIFY_M = 1.0
PCN_NEAR_M, PCN_SHARE = 12.0, 0.6


def walkable(tags):
    """Return the kind for a way, or None if people on foot cannot or may not use it."""
    hw = tags.get('highway')
    if hw not in ROADS and hw not in PATHS:
        return None
    foot, access = tags.get('foot'), tags.get('access')
    if foot in ('no', 'private') or (access in ('no', 'private') and foot not in FOOT_OK):
        return None
    if tags.get('area') == 'yes' or tags.get('indoor') == 'yes':
        return None
    if hw == 'service' and tags.get('service') in ('parking_aisle', 'drive-through'):
        return None
    if hw == 'steps':
        return 4
    if hw in PATHS:
        fw = tags.get('footway')
        if fw == 'crossing' or tags.get('path') == 'crossing' or tags.get('cycleway') == 'crossing':
            return 2
        if fw == 'sidewalk' or tags.get('path') == 'sidewalk':
            return 5
        return 3
    return 0


class Ways(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = []          # (kind, name, [(ref, lat, lon), ...])
        self.newest = 0

    def way(self, w):
        kind = walkable(w.tags)
        if kind is None:
            return
        try:
            nodes = [(n.ref, n.lat, n.lon) for n in w.nodes]
        except osmium.InvalidLocationError:
            nodes = [(n.ref, n.lat, n.lon) for n in w.nodes if n.location.valid()]
        if len(nodes) < 2:
            return
        self.ways.append((kind, w.tags.get('name') or '', nodes))
        ts = w.timestamp.timestamp() if w.timestamp else 0
        self.newest = max(self.newest, ts)


def load_pcn(path):
    feats = json.load(open(path))['features']
    lines, names = [], []
    for f in feats:
        g = shape(f['geometry'])
        parts = [g] if g.geom_type == 'LineString' else list(getattr(g, 'geoms', []))
        for p in parts:
            xs, ys = TO_M.transform([c[0] for c in p.coords], [c[1] for c in p.coords])
            lines.append(LineString(list(zip(xs, ys))))
            names.append((f.get('properties') or {}).get('PARK') or '')
    return lines, names


def split_into_edges(ways):
    """Cut ways at shared nodes (OSM topology) -> edges with endpoints as graph nodes."""
    use = collections.Counter()
    for _, _, nodes in ways:
        for i, (ref, _, _) in enumerate(nodes):
            use[ref] += 2 if i in (0, len(nodes) - 1) else 1
    edges = []
    for kind, name, nodes in ways:
        cur = [nodes[0]]
        for nd in nodes[1:]:
            cur.append(nd)
            if use[nd[0]] > 1 and nd is not nodes[-1]:
                edges.append((kind, name, cur)); cur = [nd]
        if len(cur) > 1:
            edges.append((kind, name, cur))
    return edges


def build(osm_path, pcn_path):
    t0 = time.time()
    h = Ways(); h.apply_file(osm_path, locations=True, idx='flex_mem')
    print(f'ways kept: {len(h.ways)} ({time.time() - t0:.0f}s)', flush=True)
    edges = split_into_edges(h.ways)
    print(f'edges: {len(edges)}', flush=True)
    pcn_lines, pcn_names = load_pcn(pcn_path)
    tree = STRtree(pcn_lines)
    out, km = [], collections.Counter()
    covered = [0.0] * len(pcn_lines)
    for kind, name, nodes in edges:
        xs, ys = TO_M.transform([n[2] for n in nodes], [n[1] for n in nodes])
        g = LineString(list(zip(xs, ys)))
        if g.length == 0:
            continue
        if kind in (3, 5):
            # a path that runs along an NParks park connector for most of its length is a park connector
            n = max(2, int(g.length // 10) + 1)
            pts = [g.interpolate(i / (n - 1), normalized=True) for i in range(n)]
            near = 0; best = None
            for p in pts:
                idx = tree.query(p.buffer(PCN_NEAR_M))
                d = min(((pcn_lines[i].distance(p), i) for i in idx), default=(1e9, None))
                if d[0] <= PCN_NEAR_M:
                    near += 1; best = d[1]
            if near / n >= PCN_SHARE:
                kind = 1
                if not name and best is not None:
                    name = pcn_names[best]
        if kind in (1, 3, 5):
            for i in tree.query(g.buffer(PCN_NEAR_M)):
                covered[i] = max(covered[i], pcn_lines[i].intersection(g.buffer(PCN_NEAR_M)).length)
        km[KINDS[kind]] += g.length / 1000
        gs = g.simplify(SIMPLIFY_M, preserve_topology=False) if g.length > 2 * SIMPLIFY_M else g
        keep = set(map(tuple, gs.coords))
        q = [(round(n[1] * 1e6), round(n[2] * 1e6)) for n, x, y in zip(nodes, xs, ys) if (x, y) in keep]
        if len(q) < 2:
            q = [(round(nodes[0][1] * 1e6), round(nodes[0][2] * 1e6)), (round(nodes[-1][1] * 1e6), round(nodes[-1][2] * 1e6))]
        out.append((kind, name, q))
    pcn_total = sum(l.length for l in pcn_lines)
    stats = {
        'edges': len(out), 'km_by_kind': {k: round(v, 1) for k, v in km.items()},
        'pcn_dataset_km': round(pcn_total / 1000, 1),
        'pcn_dataset_covered_by_osm_pct': round(100 * sum(covered) / pcn_total, 1) if pcn_total else None,
        'osm_newest_way': datetime.datetime.fromtimestamp(h.newest, datetime.timezone.utc).strftime('%Y-%m-%d') if h.newest else None,
        'build_seconds': round(time.time() - t0),
    }
    return out, stats


def components(recs):
    parent = {}
    def find(a):
        while parent.setdefault(a, a) != a:
            parent[a] = parent[parent[a]]; a = parent[a]
        return a
    for _, _, q in recs:
        a, b = find(q[0]), find(q[-1])
        if a != b:
            parent[a] = b
    sizes = collections.Counter(find(n) for _, _, q in recs for n in (q[0], q[-1]))
    return len(sizes), (max(sizes.values()) / sum(sizes.values()) if sizes else 0)


def write(recs, stats, path):
    names, idx = [], {}
    def nid(n):
        if not n:
            return -1
        if n not in idx:
            idx[n] = len(names); names.append(n)
        return idx[n]
    rows = []
    for kind, name, q in recs:
        r = [kind, nid(name), q[0][0], q[0][1]]
        for (pa, po), (ca, co) in zip(q[:-1], q[1:]):
            r += [ca - pa, co - po]
        rows.append(r)
    meta = {'format': 'run-net-2', 'kinds': KINDS, 'names': names,
            'built': datetime.date.today().isoformat(), 'stats': stats,
            'sources': ['© OpenStreetMap contributors (ODbL 1.0)',
                        'NParks Park Connector Loop, data.gov.sg (Singapore Open Data Licence 1.0)']}
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w') as f:
        f.write('[' + json.dumps(meta, separators=(',', ':'), ensure_ascii=False) + ',\n')
        f.write(',\n'.join(json.dumps(r, separators=(',', ':')) for r in rows))
        f.write('\n]\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--osm', required=True); ap.add_argument('--pcn', required=True)
    ap.add_argument('--out', required=True); ap.add_argument('--stats', required=True)
    a = ap.parse_args()
    recs, stats = build(a.osm, a.pcn)
    n_comp, main_share = components(recs)
    stats['components'] = n_comp; stats['largest_component_share_of_endpoints'] = round(main_share, 3)
    write(recs, stats, a.out)
    raw = os.path.getsize(a.out)
    stats['file_mb'] = round(raw / 1e6, 2)
    stats['file_gzip_mb'] = round(len(gzip.compress(open(a.out, 'rb').read(), 6)) / 1e6, 2)
    json.dump(stats, open(a.stats, 'w'), indent=1)
    print(json.dumps(stats, indent=1))


if __name__ == '__main__':
    sys.exit(main())
