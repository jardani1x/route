/* RunCore — network loading, snapping, A* routing, route assembly, cue sheet, GPX + ZIP.
 * Pure logic, no DOM: runs in the browser (window.RunCore) and in Node (require) for testing. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.RunCore = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const KY = 110574.0;                 // metres per degree latitude near 1.3°N (WGS84)
  const KX0 = 111319.49;               // metres per degree longitude at the equator
  const CELL = 0.002;                  // spatial grid cell (~220 m)
  // Kinds (run-net-2): 0 road · 1 park connector · 2 crossing · 3 path · 4 steps · 5 sidewalk · 6 service road.
  // Flags: ESTATE = a path, steps or service road inside a housing estate (OSM landuse=residential);
  // LINK = one of those that is the way from a park connector to the streets, so the default profile keeps it.
  // A v1 file's kind 2 ("access" path to a park connector) is read as a path flagged LINK.
  const KIND_LABEL = ['Road', 'Park connector', 'Crossing', 'Path', 'Steps', 'Sidewalk', 'Service road'];
  const LINK = 16, ESTATE = 32;
  const STEPS_FACTOR = 1.3;             // steps cost a little more than their length

  function mDist(lat1, lon1, lat2, lon2) {
    const kx = KX0 * Math.cos(((lat1 + lat2) / 2) * Math.PI / 180);
    const dx = (lon2 - lon1) * kx, dy = (lat2 - lat1) * KY;
    return Math.sqrt(dx * dx + dy * dy);
  }

  // ---------- binary min-heap keyed by priority ----------
  class Heap {
    constructor() { this.k = []; this.v = []; }
    get size() { return this.k.length; }
    push(key, val) {
      const k = this.k, v = this.v; let i = k.length; k.push(key); v.push(val);
      while (i > 0) { const p = (i - 1) >> 1; if (k[p] <= key) break; k[i] = k[p]; v[i] = v[p]; i = p; }
      k[i] = key; v[i] = val;
    }
    peekKey() { return this.k[0]; }
    pop() {
      const k = this.k, v = this.v, top = v[0], lk = k.pop(), lv = v.pop(), n = k.length;
      if (n) {
        let i = 0;
        for (;;) {
          let c = 2 * i + 1; if (c >= n) break;
          if (c + 1 < n && k[c + 1] < k[c]) c++;
          if (k[c] >= lk) break;
          k[i] = k[c]; v[i] = v[c]; i = c;
        }
        k[i] = lk; v[i] = lv;
      }
      return top;
    }
  }

  // ---------- network ----------
  class Network {
    constructor(records) {
      const meta = records[0];
      this.names = meta.names; this.meta = meta;
      const E = records.length - 1;
      let nv = 0; for (let i = 1; i <= E; i++) nv += (records[i].length - 2) / 2;
      const lat = new Float64Array(nv), lon = new Float64Array(nv);
      const eStart = new Int32Array(E + 1), eKind = new Uint8Array(E), eFlag = new Uint8Array(E), eName = new Int32Array(E);
      const v1 = meta.format !== 'run-net-2';
      const eLen = new Float64Array(E), eU = new Int32Array(E), eV = new Int32Array(E);
      const nodeIdx = new Map(); const nLat = [], nLon = [];
      const nodeOf = (la, lo) => {
        const key = la * 1e9 + lo;     // E6 ints: unique and exact in a double for SG ranges
        let id = nodeIdx.get(key);
        if (id === undefined) { id = nLat.length; nodeIdx.set(key, id); nLat.push(la / 1e6); nLon.push(lo / 1e6); }
        return id;
      };
      let p = 0;
      for (let e = 0; e < E; e++) {
        const r = records[e + 1];
        if (v1 && r[0] === 2) { eKind[e] = 3; eFlag[e] = LINK; } else { eKind[e] = r[0] & 15; eFlag[e] = r[0] & 0xf0; }
        eName[e] = r[1]; eStart[e] = p;
        let la = r[2], lo = r[3]; const la0 = la, lo0 = lo;
        lat[p] = la / 1e6; lon[p] = lo / 1e6; p++;
        let len = 0;
        for (let j = 4; j < r.length; j += 2) {
          la += r[j]; lo += r[j + 1];
          lat[p] = la / 1e6; lon[p] = lo / 1e6;
          len += mDist(lat[p - 1], lon[p - 1], lat[p], lon[p]); p++;
        }
        eLen[e] = len; eU[e] = nodeOf(la0, lo0); eV[e] = nodeOf(la, lo);
      }
      eStart[E] = p;
      Object.assign(this, { lat, lon, eStart, eKind, eFlag, eName, eLen, eU, eV, E });
      this.hasPaths = !v1;
      this.N = nLat.length; this.nLat = Float64Array.from(nLat); this.nLon = Float64Array.from(nLon);
      // CSR adjacency
      const deg = new Int32Array(this.N + 1);
      for (let e = 0; e < E; e++) { deg[eU[e] + 1]++; if (eV[e] !== eU[e]) deg[eV[e] + 1]++; }
      for (let i = 0; i < this.N; i++) deg[i + 1] += deg[i];
      const adj = new Int32Array(deg[this.N]); const fill = deg.slice(0, this.N);
      for (let e = 0; e < E; e++) { adj[fill[eU[e]]++] = e; if (eV[e] !== eU[e]) adj[fill[eV[e]]++] = e; }
      this.adjStart = deg; this.adj = adj;
      // spatial grid of edges + bbox
      this.bbox = new Float64Array(E * 4);
      this.grid = new Map();
      for (let e = 0; e < E; e++) {
        let a = 90, b = 180, c = -90, d = -180;
        for (let i = eStart[e]; i < eStart[e + 1]; i++) {
          if (lat[i] < a) a = lat[i]; if (lat[i] > c) c = lat[i];
          if (lon[i] < b) b = lon[i]; if (lon[i] > d) d = lon[i];
        }
        this.bbox.set([a, b, c, d], e * 4);
        for (let gy = Math.floor(a / CELL); gy <= Math.floor(c / CELL); gy++)
          for (let gx = Math.floor(b / CELL); gx <= Math.floor(d / CELL); gx++) {
            const k = gy * 100000 + gx; let l = this.grid.get(k); if (!l) this.grid.set(k, l = []); l.push(e);
          }
      }
      this._stamp = new Uint32Array(E); this._stampN = 0;
      this.blocked = new Uint8Array(E);
    }

    static fromText(text) { return new Network(JSON.parse(text)); }

    nameOf(e) { const n = this.eName[e]; return n >= 0 ? this.names[n] : null; }
    label(e) { return this.nameOf(e) || KIND_LABEL[this.eKind[e]]; }

    /** Edges whose bbox intersects [s,w,n,e]. */
    edgesIn(s, w, n, e) {
      const out = []; const st = ++this._stampN;
      for (let gy = Math.floor(s / CELL); gy <= Math.floor(n / CELL); gy++)
        for (let gx = Math.floor(w / CELL); gx <= Math.floor(e / CELL); gx++) {
          const l = this.grid.get(gy * 100000 + gx); if (!l) continue;
          for (const id of l) {
            if (this._stamp[id] === st) continue; this._stamp[id] = st;
            const b = id * 4;
            if (this.bbox[b] <= n && this.bbox[b + 2] >= s && this.bbox[b + 1] <= e && this.bbox[b + 3] >= w) out.push(id);
          }
        }
      return out;
    }

    /** Nearest point on the network. Returns {edge, t (m from U), lat, lon, dist} or null. */
    snap(la, lo, maxM = 250, accept) {
      const dLat = maxM / KY, dLon = maxM / (KX0 * Math.cos(la * Math.PI / 180));
      const cand = this.edgesIn(la - dLat, lo - dLon, la + dLat, lo + dLon);
      const kx = KX0 * Math.cos(la * Math.PI / 180);
      let best = null;
      for (const e of cand) {
        if (accept && !accept(e)) continue;
        let acc = 0;
        for (let i = this.eStart[e]; i < this.eStart[e + 1] - 1; i++) {
          const ax = (this.lon[i] - lo) * kx, ay = (this.lat[i] - la) * KY;
          const bx = (this.lon[i + 1] - lo) * kx, by = (this.lat[i + 1] - la) * KY;
          const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
          let u = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0; u = Math.max(0, Math.min(1, u));
          const px = ax + u * dx, py = ay + u * dy, d = Math.sqrt(px * px + py * py);
          const segL = Math.sqrt(L2);
          if (d <= maxM && (!best || d < best.dist))
            best = { edge: e, t: acc + u * segL, lat: la + py / KY, lon: lo + px / kx, dist: d };
          acc += segL;
        }
      }
      if (best) best.t = Math.max(0, Math.min(this.eLen[best.edge], best.t * this.eLen[best.edge] / Math.max(this._polyLen(best.edge), 1e-9)));
      return best;
    }
    /** Closest point on each nearby edge, nearest first (at most k). Same shape as snap(). */
    candidates(la, lo, maxM, k = 4, accept) {
      const dLat = maxM / KY, dLon = maxM / (KX0 * Math.cos(la * Math.PI / 180));
      const kx = KX0 * Math.cos(la * Math.PI / 180), out = [];
      for (const e of this.edgesIn(la - dLat, lo - dLon, la + dLat, lo + dLon)) {
        if (accept && !accept(e)) continue;
        let acc = 0, best = null;
        for (let i = this.eStart[e]; i < this.eStart[e + 1] - 1; i++) {
          const ax = (this.lon[i] - lo) * kx, ay = (this.lat[i] - la) * KY;
          const bx = (this.lon[i + 1] - lo) * kx, by = (this.lat[i + 1] - la) * KY;
          const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy, segL = Math.sqrt(L2);
          let u = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0; u = Math.max(0, Math.min(1, u));
          const px = ax + u * dx, py = ay + u * dy, d = Math.sqrt(px * px + py * py);
          if (d <= maxM && (!best || d < best.dist)) best = { edge: e, t: acc + u * segL, lat: la + py / KY, lon: lo + px / kx, dist: d };
          acc += segL;
        }
        if (best) { best.t = Math.max(0, Math.min(this.eLen[e], best.t * this.eLen[e] / Math.max(acc, 1e-9))); out.push(best); }
      }
      out.sort((a, b) => a.dist - b.dist);
      return out.slice(0, k);
    }
    _polyLen(e) { // planar length with snap's local scale — used only to rescale t onto eLen
      let L = 0; for (let i = this.eStart[e]; i < this.eStart[e + 1] - 1; i++) L += mDist(this.lat[i], this.lon[i], this.lat[i + 1], this.lon[i + 1]);
      return L;
    }

    /** Coordinates of edge e between distances t0 and t1 (m from U); t0 > t1 walks backwards. */
    slice(e, t0, t1) {
      const s = this.eStart[e], n = this.eStart[e + 1] - s;
      const cum = [0];
      for (let i = 1; i < n; i++) cum.push(cum[i - 1] + mDist(this.lat[s + i - 1], this.lon[s + i - 1], this.lat[s + i], this.lon[s + i]));
      const at = (t) => {
        t = Math.max(0, Math.min(cum[n - 1], t));
        let i = 1; while (i < n - 1 && cum[i] < t) i++;
        const seg = cum[i] - cum[i - 1], u = seg > 0 ? (t - cum[i - 1]) / seg : 0;
        return [this.lat[s + i - 1] + u * (this.lat[s + i] - this.lat[s + i - 1]), this.lon[s + i - 1] + u * (this.lon[s + i] - this.lon[s + i - 1]), i];
      };
      const fwd = t0 <= t1, a = fwd ? t0 : t1, b = fwd ? t1 : t0;
      const A = at(a), B = at(b), out = [[A[0], A[1]]];
      for (let i = A[2]; i < B[2]; i++) if (cum[i] > a && cum[i] < b) out.push([this.lat[s + i], this.lon[s + i]]);
      out.push([B[0], B[1]]);
      return fwd ? out : out.reverse();
    }

    /** Can this profile use edge e? 'roads' (default) avoids housing estates: everything except the paths,
     *  steps and service roads between blocks, bar the links to park connectors. 'all' = every way on foot. */
    allowed(e, profile) {
      return profile === 'all' || (this.eFlag[e] & ESTATE) === 0 || (this.eFlag[e] & LINK) !== 0;
    }

    weight(e, opts) {
      if (this.blocked[e] || !this.allowed(e, opts.profile)) return Infinity;
      const k = this.eKind[e];
      return k === 1 ? (opts.pcnFactor || 1) : k === 4 ? STEPS_FACTOR : 1;
    }

    /** A* between two snapped points. Returns {parts:[{edge,t0,t1}], length} or null. */
    route(A, B, opts = {}) {
      const minW = Math.min(1, opts.pcnFactor || 1);
      const N = this.N, g = this._g || (this._g = new Float64Array(N).fill(Infinity));
      const prevE = this._pe || (this._pe = new Int32Array(N).fill(-1));
      const touched = [];
      const setG = (n, v, e) => { if (g[n] === Infinity) touched.push(n); g[n] = v; prevE[n] = e; };
      const h = (n) => mDist(this.nLat[n], this.nLon[n], B.lat, B.lon) * minW;
      const heap = new Heap();
      const wA = this.weight(A.edge, opts), wB = this.weight(B.edge, opts);
      let best = Infinity, bestEnd = null;
      if (A.edge === B.edge && wA < Infinity) { best = Math.abs(B.t - A.t) * wA; bestEnd = 'direct'; }
      if (wA < Infinity) {
        // leave the start edge either way: towards U (prev marker -2) or towards V (-3)
        const u = this.eU[A.edge], v = this.eV[A.edge];
        const cu = A.t * wA, cv = (this.eLen[A.edge] - A.t) * wA;
        setG(u, cu, -2); heap.push(cu + h(u), u);
        if (v !== u || cv < cu) { if (cv < g[v]) { setG(v, cv, -3); heap.push(cv + h(v), v); } }
      }
      const tU = this.eU[B.edge], tV = this.eV[B.edge];
      const closed = new Set();
      while (heap.size) {
        if (heap.peekKey() >= best) break;
        const n = heap.pop();
        if (closed.has(n)) continue; closed.add(n);
        if (wB < Infinity) {
          if (n === tU && g[n] + B.t * wB < best) { best = g[n] + B.t * wB; bestEnd = 'U'; }
          if (n === tV && g[n] + (this.eLen[B.edge] - B.t) * wB < best) { best = g[n] + (this.eLen[B.edge] - B.t) * wB; bestEnd = 'V'; }
        }
        for (let i = this.adjStart[n]; i < this.adjStart[n + 1]; i++) {
          const e = this.adj[i], w = this.weight(e, opts); if (w === Infinity) continue;
          const m = this.eU[e] === n ? this.eV[e] : this.eU[e];
          const ng = g[n] + this.eLen[e] * w;
          if (ng < g[m]) { setG(m, ng, e); heap.push(ng + h(m), m); }
        }
      }
      let result = null;
      if (bestEnd === 'direct') result = { parts: [{ edge: A.edge, t0: A.t, t1: B.t }] };
      else if (bestEnd) {
        const end = bestEnd === 'U' ? tU : tV;
        const parts = [{ edge: B.edge, t0: bestEnd === 'U' ? 0 : this.eLen[B.edge], t1: B.t }];
        let n = end;
        let guard = 0;
        while (prevE[n] >= 0 && guard++ < this.N) {
          const e = prevE[n]; const fromU = this.eV[e] === n;   // arrived at n along U -> V
          parts.push(fromU ? { edge: e, t0: 0, t1: this.eLen[e] } : { edge: e, t0: this.eLen[e], t1: 0 });
          n = fromU ? this.eU[e] : this.eV[e];
        }
        parts.push(prevE[n] === -2 ? { edge: A.edge, t0: A.t, t1: 0 } : { edge: A.edge, t0: A.t, t1: this.eLen[A.edge] });
        result = { parts: parts.reverse().filter(p => Math.abs(p.t1 - p.t0) > 1e-6) };
      }
      for (const n of touched) { g[n] = Infinity; prevE[n] = -1; }
      if (!result) return null;
      result.length = result.parts.reduce((s, p) => s + Math.abs(p.t1 - p.t0), 0);
      return result;
    }

    /** Turn part lists into named pieces with coordinates. */
    pieces(parts) {
      return parts.map(p => ({ edge: p.edge, name: this.nameOf(p.edge), kind: this.eKind[p.edge],
        length: Math.abs(p.t1 - p.t0), coords: this.slice(p.edge, p.t0, p.t1) }));
    }

    setBlockedFromPolygons(polys, kinds) {
      const hits = [];
      for (const poly of polys) {
        let s = 90, w = 180, n = -90, e = -180;
        for (const [la, lo] of poly) { s = Math.min(s, la); n = Math.max(n, la); w = Math.min(w, lo); e = Math.max(e, lo); }
        for (const id of this.edgesIn(s, w, n, e)) {
          if (kinds && !kinds.includes(this.eKind[id])) continue;
          const mid = this.slice(id, this.eLen[id] / 2, this.eLen[id] / 2)[0];
          if (pointInPoly(mid[0], mid[1], poly)) hits.push(id);
        }
      }
      return hits;
    }
  }

  function pointInPoly(la, lo, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [ai, oi] = poly[i], [aj, oj] = poly[j];
      if ((ai > la) !== (aj > la) && lo < (oj - oi) * (la - ai) / (aj - ai) + oi) inside = !inside;
    }
    return inside;
  }

  // ---------- route assembly ----------
  function concatCoords(pieces) {
    const out = [];
    for (const p of pieces) for (const c of p.coords) {
      const l = out[out.length - 1];
      if (!l || Math.abs(l[0] - c[0]) > 1e-9 || Math.abs(l[1] - c[1]) > 1e-9) out.push(c);
    }
    return out;
  }
  function lengthOf(coords) { let L = 0; for (let i = 1; i < coords.length; i++) L += mDist(coords[i - 1][0], coords[i - 1][1], coords[i][0], coords[i][1]); return L; }

  /** Cut a piece list at distance m; returns pieces up to m. */
  function truncatePieces(pieces, m) {
    const out = []; let acc = 0;
    for (const p of pieces) {
      const L = lengthOf(p.coords);
      if (acc + L <= m + 1e-6) { out.push(p); acc += L; continue; }
      const need = m - acc, cs = [p.coords[0]]; let a2 = 0;
      for (let i = 1; i < p.coords.length; i++) {
        const d = mDist(p.coords[i - 1][0], p.coords[i - 1][1], p.coords[i][0], p.coords[i][1]);
        if (a2 + d >= need) {
          const u = d > 0 ? (need - a2) / d : 0;
          cs.push([p.coords[i - 1][0] + u * (p.coords[i][0] - p.coords[i - 1][0]), p.coords[i - 1][1] + u * (p.coords[i][1] - p.coords[i - 1][1])]);
          break;
        }
        cs.push(p.coords[i]); a2 += d;
      }
      out.push(Object.assign({}, p, { coords: cs, length: need })); break;
    }
    return out;
  }
  function reversePieces(pieces) {
    return pieces.slice().reverse().map(p => Object.assign({}, p, { coords: p.coords.slice().reverse() }));
  }

  /**
   * Plan a route through snapped waypoints.
   * opts: {pcnFactor, mode: 'oneway'|'outback'|'loop', turnKm: number|null}
   * Returns {pieces, coords, distance, outboundDistance, turnaround:[lat,lon]|null, failedLeg|null, note}
   */
  function plan(net, wps, opts) {
    const res = { pieces: [], coords: [], distance: 0, outboundDistance: 0, turnaround: null, failedLeg: null, note: '' };
    if (wps.length < 2) return res;
    let out = [];
    const legs = [];
    for (let i = 0; i < wps.length - 1; i++) {
      const r = net.route(wps[i], wps[i + 1], opts);
      if (!r) { res.failedLeg = i; return res; }
      legs.push(r); out = out.concat(net.pieces(r.parts));
    }
    if (opts.mode === 'loop') {
      const r = net.route(wps[wps.length - 1], wps[0], opts);
      if (!r) { res.failedLeg = wps.length - 1; return res; }
      out = out.concat(net.pieces(r.parts));
    }
    let full = out;
    const outLen = lengthOf(concatCoords(out));
    if (opts.mode === 'outback') {
      let ob = out;
      if (opts.turnKm && opts.turnKm > 0) {
        const m = opts.turnKm * 1000;
        if (m < outLen) ob = truncatePieces(out, m);
        else res.note = `Waypoints run out at ${(outLen / 1000).toFixed(2)} km, before the ${opts.turnKm} km turnaround — turning at the last waypoint.`;
      }
      const obC = concatCoords(ob);
      res.turnaround = obC[obC.length - 1];
      res.outboundDistance = lengthOf(obC);
      res.outPieces = ob; res.retPieces = reversePieces(ob);
      full = ob.concat(res.retPieces);
    } else res.outboundDistance = outLen;
    res.pieces = full; res.coords = concatCoords(full); res.distance = lengthOf(res.coords);
    return res;
  }

  // ---------- cue sheet ----------
  function bearing(a, b) {
    const kx = KX0 * Math.cos(a[0] * Math.PI / 180);
    return Math.atan2((b[1] - a[1]) * kx, (b[0] - a[0]) * KY) * 180 / Math.PI;
  }
  function pointBack(coords, i, m) { // point ~m metres before index i
    let acc = 0; for (let j = i; j > 0; j--) { acc += mDist(coords[j - 1][0], coords[j - 1][1], coords[j][0], coords[j][1]); if (acc >= m) return coords[j - 1]; }
    return coords[0];
  }
  function pointFwd(coords, i, m) {
    let acc = 0; for (let j = i; j < coords.length - 1; j++) { acc += mDist(coords[j][0], coords[j][1], coords[j + 1][0], coords[j + 1][1]); if (acc >= m) return coords[j + 1]; }
    return coords[coords.length - 1];
  }
  /** Cue sheet for a plan() result; out-and-back gets an explicit turnaround row. */
  function cueSheet(p) {
    if (!p.pieces.length) return [];
    if (!p.outPieces) return cues(p.pieces, 0, true);
    const a = cues(p.outPieces, 0, false);
    const tk = p.outboundDistance / 1000;
    a.push({ km: tk, action: 'Turn around', name: 'retrace the route', length: 0, at: p.turnaround });
    const b = cues(p.retPieces, tk, true).slice(1);
    return a.concat(b);
  }
  function cues(pieces, startKm = 0, finish = true) {
    // merge pieces into named runs; unnamed short links (<40 m) inherit the previous name
    const runs = [];
    for (const p of pieces) {
      const name = p.name || KIND_LABEL[p.kind] || 'Path';
      const last = runs[runs.length - 1];
      if (last && (last.name === name || (!p.name && p.length < 40))) { last.coords = last.coords.concat(p.coords.slice(1)); last.length += p.length; }
      else runs.push({ name, coords: p.coords.slice(), length: p.length });
    }
    // fold a short run sandwiched between two runs of the same name back into them
    for (let i = runs.length - 2; i >= 1; i--) {
      if (runs[i].length < 40 && runs[i - 1].name === runs[i + 1].name) {
        runs[i - 1].coords = runs[i - 1].coords.concat(runs[i].coords.slice(1), runs[i + 1].coords.slice(1));
        runs[i - 1].length += runs[i].length + runs[i + 1].length; runs.splice(i, 2);
      }
    }
    const out = []; let acc = startKm * 1000;
    runs.forEach((r, k) => {
      let action = 'Start on';
      if (k > 0) {
        const prev = runs[k - 1].coords, cur = r.coords;
        const b1 = bearing(pointBack(prev, prev.length - 1, 20), prev[prev.length - 1]);
        const b2 = bearing(cur[0], pointFwd(cur, 0, 20));
        let d = ((b2 - b1 + 540) % 360) - 180;
        const a = Math.abs(d);
        action = a < 25 ? 'Continue onto' : a < 60 ? (d > 0 ? 'Bear right onto' : 'Bear left onto') : a < 150 ? (d > 0 ? 'Turn right onto' : 'Turn left onto') : 'Turn around onto';
      }
      out.push({ km: acc / 1000, action, name: r.name, length: r.length, at: r.coords[0] });
      acc += lengthOf(r.coords);
    });
    if (finish) out.push({ km: acc / 1000, action: 'Finish', name: '', length: 0, at: runs.length ? runs[runs.length - 1].coords.slice(-1)[0] : null });
    return out;
  }

  // ---------- GPX + ZIP ----------
  const esc = (s) => String(s).replace(/[<>&'"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
  function toGPX(name, coords, wpts) {
    const L = ['<?xml version="1.0" encoding="UTF-8"?>',
      '<gpx version="1.1" creator="Run Route Planner" xmlns="http://www.topografix.com/GPX/1/1">',
      `  <metadata><name>${esc(name)}</name></metadata>`];
    for (const w of wpts || []) L.push(`  <wpt lat="${w.lat.toFixed(7)}" lon="${w.lon.toFixed(7)}"><name>${esc(w.name)}</name></wpt>`);
    L.push('  <trk>', `    <name>${esc(name)}</name>`, '    <trkseg>');
    for (const c of coords) L.push(`      <trkpt lat="${c[0].toFixed(7)}" lon="${c[1].toFixed(7)}"/>`);
    L.push('    </trkseg>', '  </trk>', '</gpx>', '');
    return L.join('\n');
  }
  function parseGPX(text) {
    const pts = [], re = /<(trkpt|rtept)\b[^>]*?\blat="([-\d.]+)"[^>]*?\blon="([-\d.]+)"|<(trkpt|rtept)\b[^>]*?\blon="([-\d.]+)"[^>]*?\blat="([-\d.]+)"/g;
    let m; while ((m = re.exec(text))) pts.push(m[2] !== undefined ? [+m[2], +m[3]] : [+m[6], +m[5]]);
    const nm = /<name>([^<]*)<\/name>/.exec(text);
    return { name: nm ? nm[1] : 'Imported route', coords: pts };
  }
  /** Densify so no gap exceeds step metres (smoother lines in other apps). */
  function densify(coords, step = 10) {
    const out = coords.length ? [coords[0]] : [];
    for (let i = 1; i < coords.length; i++) {
      const a = coords[i - 1], b = coords[i], d = mDist(a[0], a[1], b[0], b[1]), n = Math.max(1, Math.ceil(d / step));
      for (let k = 1; k <= n; k++) out.push([a[0] + (b[0] - a[0]) * k / n, a[1] + (b[1] - a[1]) * k / n]);
    }
    return out;
  }
  return { Network, plan, cues, cueSheet, toGPX, parseGPX, densify, mDist, lengthOf, pointInPoly, KIND_LABEL, LINK, ESTATE };
});
