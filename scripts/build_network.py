"""Build the walk/run network (net-v2.json) from OpenStreetMap + NParks park connectors.

Usage:
  python scripts/build_network.py --osm singapore.osm.pbf --pcn pcn.geojson --land regions.geojson \
      --out data/net-v2.json --stats data/stats.json

v2 uses OSM's own topology: ways that share a node are connected, bridges and tunnels are not. It keeps
footpaths, park paths, steps, sidewalks and crossings, and marks the paths that follow NParks park
connectors. --land (URA region boundaries, no sea) cuts the network to Singapore's land, so roads in
Johor that are inside the download's bounding box are left out.

Output format "run-net-2": one JSON array, one record per line.
  record 0: meta {format, kinds, flags, names, built, sources, stats}
  record i: [kindByte, nameIdx, lat0E6, lon0E6, dlat1, dlon1, ...]
kindByte = kind | flags.  Kinds (low 4 bits): 0 road · 1 park connector · 2 crossing · 3 path · 4 steps ·
5 sidewalk · 6 service road.  Flags: 32 "estate" = a path, steps or service road inside a housing estate
(OSM landuse=residential: HDB estates, condos), which the default "avoid housing estates" mode leaves out;
16 "link" = one of those that the default mode may still use, because it is the way from a park connector
to the street network. Paths inside schools, military land and prisons are dropped.
"""
import argparse, collections, datetime, gzip, heapq, json, os, sys, time

import numpy as np
import osmium
import shapely
from pyproj import Transformer
from shapely.geometry import LineString, shape
from shapely.strtree import STRtree

ROADS = {'primary', 'primary_link', 'secondary', 'secondary_link', 'tertiary', 'tertiary_link', 'unclassified',
         'residential', 'living_street', 'service', 'road', 'trunk', 'trunk_link'}
PATHS = {'footway', 'path', 'pedestrian', 'cycleway', 'track', 'bridleway', 'steps'}
FOOT_OK = {'yes', 'designated', 'permissive'}
KINDS = ['road', 'park connector', 'crossing', 'path', 'steps', 'sidewalk', 'service road']
LINK, ESTATE = 16, 32
MINOR = {3, 4, 6}                 # kinds that get the estate flag when they lie in a housing estate
TO_M = Transformer.from_crs('EPSG:4326', 'EPSG:3414', always_xy=True)   # SVY21 metres
SIMPLIFY_M = 1.0
PCN_NEAR_M, PCN_SHARE = 12.0, 0.6  # a path is a park connector if >=60% of it lies within 12 m of the NParks line
LAND_BUFFER_M = 150.0              # keep coastal paths, piers and bridge ends; Johor is >=600 m across the strait
MIN_COMPONENT_M = 300.0            # drop pieces of network that connect to nothing and are shorter than this
DEAD_END_LINK_M = 150.0            # join a park connector's dead end to the nearest street within this distance
COMPONENT_LINK_M = 600.0           # join a park connector cut off from the streets within this distance
SAMPLE_M = 10.0


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
    if hw == 'service' and not tags.get('name'):
        return 6
    return 0


def zone(tags):
    """'estate' for housing, 'closed' for land the public cannot walk through, else None."""
    if tags.get('landuse') == 'residential':
        return 'estate'
    if tags.get('amenity') in ('school', 'kindergarten', 'prison') or tags.get('landuse') == 'military':
        return 'closed'
    return None


class Ways(osmium.SimpleHandler):
    def __init__(self):
        super().__init__()
        self.ways = []          # (kind, name, [(ref, lat, lon), ...])
        self.zones = {'estate': [], 'closed': []}   # shapely polygons (WGS84)
        self.newest = 0
        self._wkb = osmium.geom.WKBFactory()

    def area(self, a):
        z = zone(a.tags)
        if z:
            try:
                self.zones[z].append(shapely.from_wkb(self._wkb.create_multipolygon(a)))
            except Exception:       # broken multipolygon in OSM: skip it
                pass

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


def to_m(g):
    return shapely.transform(g, lambda c: np.column_stack(TO_M.transform(c[:, 0], c[:, 1])))


def load_pcn(path):
    lines, names = [], []
    for f in json.load(open(path))['features']:
        g = shape(f['geometry'])
        for p in ([g] if g.geom_type == 'LineString' else list(getattr(g, 'geoms', []))):
            lines.append(to_m(p)); names.append((f.get('properties') or {}).get('PARK') or '')
    return lines, names


def load_land(path):
    polys = [to_m(shape(f['geometry'])) for f in json.load(open(path))['features']]
    land = shapely.union_all(polys).buffer(LAND_BUFFER_M)
    shapely.prepare(land)
    return land


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
                edges.append([kind, name, cur]); cur = [nd]
        if len(cur) > 1:
            edges.append([kind, name, cur])
    return edges


def samples(geoms, step=SAMPLE_M):
    """Points every ~step metres along each line; returns (points, owner index)."""
    n = np.array([max(2, int(g.length // step) + 1) for g in geoms])
    owner = np.repeat(np.arange(len(geoms)), n)
    frac = np.concatenate([np.linspace(0, 1, k) for k in n]) if len(n) else np.zeros(0)
    pts = shapely.line_interpolate_point(np.array(geoms, dtype=object)[owner], frac, normalized=True) if len(n) else []
    return pts, owner


class Graph:
    """Endpoints -> node ids, adjacency lists, union-find helpers."""
    def __init__(self, edges):
        self.nid = {}; self.ends = []
        for e in edges:
            a = self.nid.setdefault(e['ends'][0], len(self.nid)); b = self.nid.setdefault(e['ends'][1], len(self.nid))
            self.ends.append((a, b))
        self.adj = [[] for _ in range(len(self.nid))]
        for i, (a, b) in enumerate(self.ends):
            self.adj[a].append(i)
            if b != a:
                self.adj[b].append(i)

    def components(self, use):
        parent = list(range(len(self.nid)))
        def find(a):
            while parent[a] != a:
                parent[a] = parent[parent[a]]; a = parent[a]
            return a
        for i, (a, b) in enumerate(self.ends):
            if use(i):
                ra, rb = find(a), find(b)
                if ra != rb:
                    parent[ra] = rb
        return [find(v) for v in range(len(self.nid))]


def prune_small(edges):
    g = Graph(edges); comp = g.components(lambda i: True)
    total = collections.Counter()
    for i, (a, _) in enumerate(g.ends):
        total[comp[a]] += edges[i]['len']
    keep = [e for i, e in enumerate(edges) if total[comp[g.ends[i][0]]] >= MIN_COMPONENT_M]
    return keep, sum(e['len'] for e in edges) - sum(e['len'] for e in keep)


def road_mode_ok(e):
    """Can the default mode (avoid housing estates) use this edge? Mirrors Network.allowed() in core.js."""
    return not (e['flags'] & ESTATE) or bool(e['flags'] & LINK)


def add_links(edges):
    """Flag the estate paths, steps and service roads that join park connectors to the street network."""
    g = Graph(edges)
    def road_mode(i): return road_mode_ok(edges[i])
    def via(i): return not road_mode_ok(edges[i])
    def r_degree(v): return sum(1 for i in g.adj[v] if road_mode(i))

    def search(sources, is_target, max_m):
        """Dijkstra over link-able edges; returns the edges of the path to the first target, or None."""
        dist = {s: 0.0 for s in sources}; prev = {}
        pq = [(0.0, s) for s in sources]; heapq.heapify(pq)
        while pq:
            d, v = heapq.heappop(pq)
            if d > dist[v]:
                continue
            if v not in sources and is_target(v):
                path = []
                while v in prev:
                    i, v = prev[v]; path.append(i)
                return path
            for i in g.adj[v]:
                if not via(i):
                    continue
                a, b = g.ends[i]; w = b if a == v else a; nd = d + edges[i]['len']
                if nd <= max_m and nd < dist.get(w, 1e18):
                    dist[w] = nd; prev[w] = (i, v); heapq.heappush(pq, (nd, w))
        return None

    n_dead = 0
    # 1. a park connector that stops short of a street (dead end) -> shortest path on to the nearest street node
    for v in range(len(g.nid)):
        pcn_here = any(edges[i]['kind'] == 1 for i in g.adj[v])
        if pcn_here and r_degree(v) == 1:
            path = search({v}, lambda u: r_degree(u) > 0, DEAD_END_LINK_M)
            if path:
                n_dead += 1
                for i in path:
                    edges[i]['flags'] |= LINK
    # 2. park connector pieces still cut off from the main street network -> grow out from the main network
    comp = g.components(road_mode)
    clen, cpcn = collections.Counter(), collections.Counter()
    for i, (a, _) in enumerate(g.ends):
        if road_mode(i):
            clen[comp[a]] += edges[i]['len']
            if edges[i]['kind'] == 1:
                cpcn[comp[a]] += edges[i]['len']
    main = clen.most_common(1)[0][0] if clen else None
    members = collections.defaultdict(list)
    for v in range(len(g.nid)):
        if any(road_mode(i) for i in g.adj[v]):
            members[comp[v]].append(v)
    pending = {c for c, l in cpcn.items() if c != main and l >= 100}
    n_comp = 0
    if main is not None and pending:
        dist = {v: 0.0 for v in members[main]}; prev = {}
        pq = [(0.0, v) for v in members[main]]; heapq.heapify(pq)
        while pq and pending:
            d, v = heapq.heappop(pq)
            if d > dist[v]:
                continue
            c = comp[v] if any(road_mode(i) for i in g.adj[v]) else None
            if c in pending:
                pending.discard(c); n_comp += 1
                u = v
                while u in prev:
                    i, u = prev[u]; edges[i]['flags'] |= LINK
                for w in members[c]:
                    if dist.get(w, 1e18) > 0:
                        dist[w] = 0.0; prev.pop(w, None); heapq.heappush(pq, (0.0, w))
                continue
            for i in g.adj[v]:
                if not via(i):
                    continue
                a, b = g.ends[i]; w = b if a == v else a; nd = d + edges[i]['len']
                if nd <= COMPONENT_LINK_M and nd < dist.get(w, 1e18):
                    dist[w] = nd; prev[w] = (i, v); heapq.heappush(pq, (nd, w))
    # report how much of the park connector network the "Roads & park connectors" mode can reach
    comp = g.components(road_mode)
    clen, cpcn = collections.Counter(), collections.Counter()
    for i, (a, _) in enumerate(g.ends):
        if road_mode(i):
            clen[comp[a]] += edges[i]['len']
            if edges[i]['kind'] == 1:
                cpcn[comp[a]] += edges[i]['len']
    main = clen.most_common(1)[0][0] if clen else None
    total_pcn = sum(cpcn.values())
    return {'link_dead_ends_joined': n_dead, 'link_pieces_joined': n_comp,
            'link_km': round(sum(e['len'] for e in edges if e['flags'] & LINK) / 1000, 1),
            'roads_mode_pcn_reachable_pct': round(100 * cpcn[main] / total_pcn, 1) if total_pcn else None}


def build(osm_path, pcn_path, land_path=None):
    t0 = time.time()
    h = Ways(); h.apply_file(osm_path, locations=True, idx='flex_mem')
    print(f'ways kept: {len(h.ways)} ({time.time() - t0:.0f}s)', flush=True)
    raw = split_into_edges(h.ways)
    edges = []
    for kind, name, nodes in raw:
        xs, ys = TO_M.transform([n[2] for n in nodes], [n[1] for n in nodes])
        g = LineString(list(zip(xs, ys)))
        if g.length > 0:
            edges.append({'kind': kind, 'name': name, 'nodes': nodes, 'xy': (xs, ys), 'g': g, 'len': g.length, 'flags': 0,
                          'ends': ((round(nodes[0][1] * 1e6), round(nodes[0][2] * 1e6)),
                                   (round(nodes[-1][1] * 1e6), round(nodes[-1][2] * 1e6)))})
    print(f'edges: {len(edges)} ({time.time() - t0:.0f}s)', flush=True)
    stats = {}

    if land_path:
        land = load_land(land_path)
        mids = shapely.line_interpolate_point(np.array([e['g'] for e in edges], dtype=object), 0.5, normalized=True)
        inside = shapely.contains(land, mids)
        stats['outside_land_km_dropped'] = round(sum(e['len'] for e, ok in zip(edges, inside) if not ok) / 1000, 1)
        edges = [e for e, ok in zip(edges, inside) if ok]
        print(f'on land: {len(edges)} ({time.time() - t0:.0f}s)', flush=True)

    # housing estates and closed land (schools, military, prisons): flag or drop minor ways inside them
    zones = {k: [to_m(g) for g in v] for k, v in h.zones.items()}
    stats['estate_areas'] = len(zones['estate']); stats['closed_areas'] = len(zones['closed'])
    minor = [i for i, e in enumerate(edges) if e['kind'] in MINOR]
    if minor:
        mids = shapely.line_interpolate_point(np.array([edges[i]['g'] for i in minor], dtype=object), 0.5, normalized=True)
        def inside(polys):
            hit = np.zeros(len(minor), bool)
            if polys:
                hit[STRtree(polys).query(mids, predicate='within')[0]] = True
            return hit
        closed, estate = inside(zones['closed']), inside(zones['estate'])
        for j, i in enumerate(minor):
            if estate[j]:
                edges[i]['flags'] |= ESTATE
        drop = {minor[j] for j in np.flatnonzero(closed)}
        stats['closed_land_km_dropped'] = round(sum(edges[i]['len'] for i in drop) / 1000, 1)
        edges = [e for i, e in enumerate(edges) if i not in drop]
        stats['estate_km'] = round(sum(e['len'] for e in edges if e['flags'] & ESTATE) / 1000, 1)

    # park connectors: paths and sidewalks that run along the NParks line for most of their length
    pcn_lines, pcn_names = load_pcn(pcn_path)
    pcn_tree = STRtree(pcn_lines)
    cand = [i for i, e in enumerate(edges) if e['kind'] in (3, 5)]
    if cand:
        pts, owner = samples([edges[i]['g'] for i in cand])
        hit = pcn_tree.query(pts, predicate='dwithin', distance=PCN_NEAR_M)
        near = np.zeros(len(pts), bool); near[hit[0]] = True
        counts = np.bincount(owner, minlength=len(cand))
        share = np.bincount(owner, weights=near, minlength=len(cand)) / counts
        pcn_j = [j for j in range(len(cand)) if share[j] >= PCN_SHARE]
        if pcn_j:
            # name an unnamed park connector after the NParks line nearest its middle
            mid = (np.cumsum(counts) - counts + counts // 2)[pcn_j]
            q = pcn_tree.query_nearest(pts[mid])           # (2, k): query index, line index (ties repeat)
            line = {}
            for qi, li in zip(q[0], q[1]):
                line.setdefault(int(qi), int(li))
            for k, j in enumerate(pcn_j):
                e = edges[cand[j]]; e['kind'] = 1; e['flags'] &= ~ESTATE
                if not e['name'] and k in line:
                    e['name'] = pcn_names[line[k]]
    print(f'park connectors classified ({time.time() - t0:.0f}s)', flush=True)

    edges, dropped = prune_small(edges)
    stats['small_pieces_km_dropped'] = round(dropped / 1000, 1)
    stats.update(add_links(edges))
    print(f'links added ({time.time() - t0:.0f}s)', flush=True)

    # how much of the NParks park connector network has an OSM way within reach
    pcn_total = sum(l.length for l in pcn_lines)
    if pcn_lines and edges:
        p_pts, _ = samples(pcn_lines)
        any_tree = STRtree([e['g'] for e in edges])
        pc = [e['g'] for e in edges if e['kind'] == 1]
        def pct(tree, d):
            return round(100 * len(np.unique(tree.query(p_pts, predicate='dwithin', distance=d)[0])) / len(p_pts), 1)
        stats['pcn_dataset_km'] = round(pcn_total / 1000, 1)
        stats['pcn_with_osm_way_within_12m_pct'] = pct(any_tree, 12)
        stats['pcn_with_osm_way_within_25m_pct'] = pct(any_tree, 25)
        stats['pcn_marked_as_park_connector_pct'] = pct(STRtree(pc), 12) if pc else 0.0

    out, km = [], collections.Counter()
    for e in edges:
        g, nodes, (xs, ys) = e['g'], e['nodes'], e['xy']
        km[KINDS[e['kind']]] += e['len'] / 1000
        gs = g.simplify(SIMPLIFY_M, preserve_topology=False) if g.length > 2 * SIMPLIFY_M else g
        keep = set(map(tuple, gs.coords))
        q = [(round(n[1] * 1e6), round(n[2] * 1e6)) for n, x, y in zip(nodes, xs, ys) if (x, y) in keep]
        if len(q) < 2 or q[0] != e['ends'][0] or q[-1] != e['ends'][1]:
            q = [e['ends'][0], e['ends'][1]] if len(q) < 2 else [e['ends'][0]] + q[1:-1] + [e['ends'][1]]
        out.append((e['kind'] | e['flags'], e['name'], q))
    stats.update({'edges': len(out), 'km_by_kind': {k: round(v, 1) for k, v in sorted(km.items())},
                  'osm_newest_way': datetime.datetime.fromtimestamp(h.newest, datetime.timezone.utc).strftime('%Y-%m-%d') if h.newest else None,
                  'build_seconds': round(time.time() - t0)})
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
    meta = {'format': 'run-net-2', 'kinds': KINDS, 'flags': {'link': LINK, 'estate': ESTATE}, 'names': names,
            'built': datetime.date.today().isoformat(), 'stats': stats,
            'sources': ['© OpenStreetMap contributors (ODbL 1.0)',
                        'NParks Park Connector Loop, data.gov.sg (Singapore Open Data Licence 1.0)',
                        'URA Master Plan 2019 Region Boundary (No Sea), data.gov.sg (Singapore Open Data Licence 1.0)']}
    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)
    with open(path, 'w') as f:
        f.write('[' + json.dumps(meta, separators=(',', ':'), ensure_ascii=False) + ',\n')
        f.write(',\n'.join(json.dumps(r, separators=(',', ':')) for r in rows))
        f.write('\n]\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--osm', required=True); ap.add_argument('--pcn', required=True)
    ap.add_argument('--land', help='GeoJSON land polygons; edges whose midpoint is outside are dropped')
    ap.add_argument('--out', required=True); ap.add_argument('--stats', required=True)
    a = ap.parse_args()
    recs, stats = build(a.osm, a.pcn, a.land)
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
