"""Pack a run-net-2 network (JSON, from build_network.py) into the compact binary run-net-3, gzipped.

Usage: python scripts/pack_network.py data/net-v2.json data/net-v3.bin.gz

run-net-3 (all integers are LEB128 varints; "zz" = zigzag-encoded signed varint):
  'RNT3'                          magic
  metaLen, meta (UTF-8 JSON)      {format:'run-net-3', scale, kinds, flags, names, built, sources, stats}
  N, E, M                         nodes, edges, intermediate vertices
  then seven sections, each as byteLength + bytes:
  nodes   N x (zz dlat, zz dlon)  node coordinates x scale, delta from the previous node; nodes follow a
                                  Hilbert curve so neighbours on the map are neighbours in the file
  du      E x (u - previous u)    edges sorted by their first node u
  dv      E x zz (v - u)          the edge's last node
  kind    E bytes                 kind | flags, as in run-net-2
  name    E x (name index + 1)    0 = no name
  cnt     E x count               intermediate vertices of the edge
  geom    M x (zz dlat, zz dlon)  intermediate vertices, each a delta from the one before, starting at u
Coordinates are rounded to 1e-5 degrees (about 1.1 m), which is finer than the 1 m simplification the
builder already applies. Nodes keep their identity from run-net-2's exact coordinates, so rounding never
joins or splits the network. The file is about a third the size of the gzipped JSON.
"""
import gzip, json, sys

SCALE = 1e5
SECTIONS = ('nodes', 'du', 'dv', 'kind', 'name', 'cnt', 'geom')


def uvarint(n, out):
    while True:
        b = n & 127; n >>= 7
        if n:
            out.append(b | 128)
        else:
            out.append(b); return


def zz(n):
    return n * 2 if n >= 0 else -n * 2 - 1


def hilbert(x, y, order=16):
    d, s = 0, 1 << (order - 1)
    while s:
        rx = 1 if x & s else 0; ry = 1 if y & s else 0
        d += s * s * ((3 * rx) ^ ry)
        if ry == 0:
            if rx:
                x, y = s - 1 - x, s - 1 - y
            x, y = y, x
        s >>= 1
    return d


def pack(rows):
    meta, recs = rows[0], rows[1:]
    if meta.get('format') != 'run-net-2':
        raise SystemExit('expected a run-net-2 file')
    k = SCALE / 1e6
    q = lambda v: round(v * k)                        # E6 integer -> scaled integer
    nodes, edges = {}, []
    for r in recs:
        la, lo = r[2], r[3]; pts = [(la, lo)]
        for j in range(4, len(r), 2):
            la += r[j]; lo += r[j + 1]; pts.append((la, lo))
        a = nodes.setdefault(pts[0], len(nodes)); b = nodes.setdefault(pts[-1], len(nodes))
        edges.append((a, b, r[0], r[1], [(q(p[0]), q(p[1])) for p in pts[1:-1]]))
    keys = list(nodes)
    la0 = min(p[0] for p in keys); lo0 = min(p[1] for p in keys)
    span = max(max(p[0] for p in keys) - la0, max(p[1] for p in keys) - lo0) + 1
    shift = max(0, span.bit_length() - 16)            # fit the curve's 16-bit grid
    order = sorted(range(len(keys)), key=lambda i: hilbert((keys[i][1] - lo0) >> shift, (keys[i][0] - la0) >> shift))
    rank = [0] * len(keys)
    for new, old in enumerate(order):
        rank[old] = new
    nla = [q(keys[i][0]) for i in order]; nlo = [q(keys[i][1]) for i in order]
    edges = sorted(((rank[a], rank[b], kb, n, mid) for a, b, kb, n, mid in edges), key=lambda e: (e[0], e[1]))

    sec = {s: bytearray() for s in SECTIONS}
    pla = plo = 0
    for la, lo in zip(nla, nlo):
        uvarint(zz(la - pla), sec['nodes']); uvarint(zz(lo - plo), sec['nodes']); pla, plo = la, lo
    pu, m = 0, 0
    for u, v, kb, n, mid in edges:
        uvarint(u - pu, sec['du']); pu = u
        uvarint(zz(v - u), sec['dv']); sec['kind'].append(kb)
        uvarint(n + 1, sec['name']); uvarint(len(mid), sec['cnt'])
        pla, plo = nla[u], nlo[u]
        for la, lo in mid:
            uvarint(zz(la - pla), sec['geom']); uvarint(zz(lo - plo), sec['geom']); pla, plo = la, lo
        m += len(mid)

    out_meta = dict(meta, format='run-net-3', scale=SCALE)
    mb = json.dumps(out_meta, separators=(',', ':'), ensure_ascii=False).encode()
    out = bytearray(b'RNT3')
    for n in (len(mb),):
        uvarint(n, out)
    out += mb
    for n in (len(nla), len(edges), m):
        uvarint(n, out)
    for s in SECTIONS:
        uvarint(len(sec[s]), out); out += sec[s]
    return bytes(out)


def main():
    src, dst = sys.argv[1], sys.argv[2]
    data = pack(json.load(open(src)))
    with open(dst, 'wb') as f:
        f.write(gzip.compress(data, 9, mtime=0))
    print(f'{dst}: {len(data) / 1e6:.2f} MB raw, {len(gzip.compress(data, 9)) / 1e6:.2f} MB gzipped')


if __name__ == '__main__':
    main()
