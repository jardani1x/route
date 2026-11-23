/* RouteEngine — route editing on top of RunCore (network + A*).
 * Geometry helpers, snap-to-map trace matching (HMM / Viterbi), and a RouteEditor with
 * click-to-extend, trace, eraser, segment replace, finish actions, waypoints and undo/redo.
 * Pure logic (no DOM); runs in the browser (window.RouteEngine) and in Node for tests. */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./core.js'));
  else root.RouteEngine = factory(root.RunCore);
})(typeof self !== 'undefined' ? self : this, function (RC) {
  'use strict';
  const KY = 110574.0, KX0 = 111319.49;

  // ---------------- geometry ----------------
  const D = (a, b) => RC.mDist(a[0], a[1], b[0], b[1]);
  const same = (a, b) => Math.abs(a[0] - b[0]) < 1e-9 && Math.abs(a[1] - b[1]) < 1e-9;
  function dedupe(cs) { const o = []; for (const c of cs) if (!o.length || D(o[o.length - 1], c) > 0.05) o.push([c[0], c[1]]); return o; }
  function cumul(cs) { const c = new Float64Array(cs.length); for (let i = 1; i < cs.length; i++) c[i] = c[i - 1] + D(cs[i - 1], cs[i]); return c; }
  const length = (cs) => (cs.length < 2 ? 0 : cumul(cs)[cs.length - 1]);
  function join(...parts) { const o = []; for (const p of parts) for (const c of p || []) if (!o.length || !same(o[o.length - 1], c)) o.push(c); return o; }
  function pointAt(cs, cum, d) {
    if (d <= 0) return cs[0]; const L = cum[cs.length - 1]; if (d >= L) return cs[cs.length - 1];
    let lo = 0, hi = cs.length - 1; while (hi - lo > 1) { const m = (lo + hi) >> 1; if (cum[m] < d) lo = m; else hi = m; }
    const seg = cum[hi] - cum[lo], u = seg > 0 ? (d - cum[lo]) / seg : 0;
    return [cs[lo][0] + u * (cs[hi][0] - cs[lo][0]), cs[lo][1] + u * (cs[hi][1] - cs[lo][1])];
  }
  /** Coordinates between distances d0 < d1 along cs. */
  function slice(cs, d0, d1) {
    if (cs.length < 2) return cs.slice(); const cum = cumul(cs);
    const out = [pointAt(cs, cum, d0)];
    for (let i = 0; i < cs.length; i++) if (cum[i] > d0 && cum[i] < d1) out.push(cs[i]);
    out.push(pointAt(cs, cum, d1));
    return dedupe(out);
  }
  /** Nearest point on polyline: {d: distance along, dist: offset in metres, pt}. */
  function locate(cs, p) {
    if (!cs.length) return null; if (cs.length === 1) return { d: 0, dist: D(cs[0], p), pt: cs[0] };
    const kx = KX0 * Math.cos(p[0] * Math.PI / 180); let best = null, acc = 0;
    for (let i = 0; i < cs.length - 1; i++) {
      const ax = (cs[i][1] - p[1]) * kx, ay = (cs[i][0] - p[0]) * KY, bx = (cs[i + 1][1] - p[1]) * kx, by = (cs[i + 1][0] - p[0]) * KY;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; let u = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0; u = Math.max(0, Math.min(1, u));
      const px = ax + u * dx, py = ay + u * dy, dist = Math.hypot(px, py), segL = D(cs[i], cs[i + 1]);
      if (!best || dist < best.dist) best = { d: acc + u * segL, dist, pt: [p[0] + py / KY, p[1] + px / kx] };
      acc += segL;
    }
    return best;
  }
  /** Every stretch of the polyline within tol of p: one {d, dist} per run of nearby segments
   *  (an out & back route passes the same spot twice, so a point can sit on both legs). */
  function locateAll(cs, p, tol) {
    if (cs.length < 2) return cs.length ? [{ d: 0, dist: D(cs[0], p) }].filter(x => x.dist <= tol) : [];
    const kx = KX0 * Math.cos(p[0] * Math.PI / 180), out = []; let acc = 0, run = null;
    for (let i = 0; i < cs.length - 1; i++) {
      const ax = (cs[i][1] - p[1]) * kx, ay = (cs[i][0] - p[0]) * KY, bx = (cs[i + 1][1] - p[1]) * kx, by = (cs[i + 1][0] - p[0]) * KY;
      const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy; let u = L2 > 0 ? -(ax * dx + ay * dy) / L2 : 0; u = Math.max(0, Math.min(1, u));
      const dist = Math.hypot(ax + u * dx, ay + u * dy), segL = D(cs[i], cs[i + 1]);
      if (dist <= tol) { if (!run || dist < run.dist) run = { d: acc + u * segL, dist }; }
      else if (run) { out.push(run); run = null; }
      acc += segL;
    }
    if (run) out.push(run);
    return out;
  }
  function resample(cs, step) {
    if (cs.length < 2) return cs.slice(); const cum = cumul(cs), L = cum[cs.length - 1], out = [];
    const n = Math.max(1, Math.round(L / step)); for (let i = 0; i <= n; i++) out.push(pointAt(cs, cum, L * i / n));
    return out;
  }
  /** Douglas–Peucker in local metres. */
  function simplify(cs, tol) {
    if (cs.length < 3) return cs.slice();
    const lat0 = cs[0][0], kx = KX0 * Math.cos(lat0 * Math.PI / 180);
    const xy = cs.map(c => [(c[1] - cs[0][1]) * kx, (c[0] - lat0) * KY]);
    const keep = new Uint8Array(cs.length); keep[0] = keep[cs.length - 1] = 1;
    const stack = [[0, cs.length - 1]];
    while (stack.length) {
      const [a, b] = stack.pop(); let md = -1, mi = -1;
      const [ax, ay] = xy[a], [bx, by] = xy[b], dx = bx - ax, dy = by - ay, L = Math.hypot(dx, dy);
      for (let i = a + 1; i < b; i++) {
        const d = L > 0 ? Math.abs(dy * xy[i][0] - dx * xy[i][1] + bx * ay - by * ax) / L : Math.hypot(xy[i][0] - ax, xy[i][1] - ay);
        if (d > md) { md = d; mi = i; }
      }
      if (md > tol) { keep[mi] = 1; stack.push([a, mi], [mi, b]); }
    }
    return cs.filter((_, i) => keep[i]);
  }
  /** Remove short out-and-back spurs (artefacts of matching), keeping intended long ones. */
  function despur(cs, maxSpur = 120, closeM = 4) {
    let out = cs.slice(), changed = true, guard = 0;
    while (changed && guard++ < 20) {
      changed = false; const cum = cumul(out);
      for (let i = 0; i < out.length && !changed; i++)
        for (let j = i + 2; j < out.length && cum[j] - cum[i] <= maxSpur; j++)
          if (cum[j] - cum[i] > closeM * 3 && D(out[i], out[j]) < closeM) { out = out.slice(0, i + 1).concat(out.slice(j + 1)); changed = true; break; }
    }
    return out;
  }
  // Google encoded polyline (precision 5) — compact share links
  function encode(cs) {
    let out = '', pa = 0, po = 0;
    const enc = (v) => { v = v < 0 ? ~(v << 1) : v << 1; let s = ''; while (v >= 0x20) { s += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; } return s + String.fromCharCode(v + 63); };
    for (const [la, lo] of cs) { const a = Math.round(la * 1e5), o = Math.round(lo * 1e5); out += enc(a - pa) + enc(o - po); pa = a; po = o; }
    return out;
  }
  function decode(str) {
    const out = []; let i = 0, la = 0, lo = 0;
    const dec = () => { let r = 0, s = 0, b; do { b = str.charCodeAt(i++) - 63; r |= (b & 0x1f) << s; s += 5; } while (b >= 0x20 && i <= str.length); return r & 1 ? ~(r >> 1) : r >> 1; };
    while (i < str.length) { la += dec(); lo += dec(); out.push([la / 1e5, lo / 1e5]); }
    return out;
  }
  /** Points for an elevation lookup: at most maxPts, evenly spaced, with distances. */
  function elevationSamples(cs, maxPts = 200, minStep = 25) {
    const cum = cumul(cs), L = cs.length > 1 ? cum[cs.length - 1] : 0; if (!L) return { pts: [], dists: [] };
    const n = Math.max(2, Math.min(maxPts, Math.floor(L / minStep) + 1)), pts = [], dists = [];
    for (let i = 0; i < n; i++) { const d = L * i / (n - 1); pts.push(pointAt(cs, cum, d)); dists.push(d); }
    return { pts, dists };
  }
  /** Apply fn to each sample's neighbourhood within ±windowM/2 along the route. */
  function windowed(d, h, windowM, fn) {
    const out = new Array(h.length); let lo = 0, hi = 0;
    for (let i = 0; i < h.length; i++) {
      while (d[lo] < d[i] - windowM / 2) lo++;
      while (hi + 1 < h.length && d[hi + 1] <= d[i] + windowM / 2) hi++;
      out[i] = fn(h.slice(lo, hi + 1));
    }
    return out;
  }
  const median = (a) => { a = a.slice().sort((x, y) => x - y); const m = a.length >> 1; return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2; };
  /** Ground profile from the Copernicus 90 m surface model. Roofs and tree canopy only ever ADD height,
   *  so a morphological opening (running minimum, then running maximum, over 180 m, about two model cells)
   *  removes them while slopes longer than the window survive; a 90 m median then takes out small noise.
   *  Tested: spiky flat route 175 m raw climb -> 0 m; 40 m hill keeps ~88%; 25 m ramp keeps ~92%. */
  function smoothElevation(d, h, openM = 180, medianM = 90) {
    const opened = windowed(d, windowed(d, h, openM, (w) => Math.min(...w)), openM, (w) => Math.max(...w));
    return windowed(d, opened, medianM, median);
  }
  /** Total climb/descent with a hysteresis threshold so DEM noise is not counted. */
  function gainLoss(elev, threshold = 2) {
    let gain = 0, loss = 0, ref = elev[0];
    for (const e of elev) { if (e - ref >= threshold) { gain += e - ref; ref = e; } else if (ref - e >= threshold) { loss += ref - e; ref = e; } }
    return { gain, loss, min: Math.min(...elev), max: Math.max(...elev) };
  }

  // ---------------- router (network wrapper) ----------------
  class Router {
    constructor(net, profile = 'roads') {
      this.net = net; this.pcnFactor = 0.8; this.avoidClosures = true; this._comps = {};
      this.setProfile(profile);
    }
    /** 'roads' (streets, sidewalks, crossings, park connectors) or 'all' (every footpath, steps included). */
    setProfile(profile) {
      this.profile = profile === 'all' && this.net.hasPaths ? 'all' : 'roads';
      // largest connected component for this profile: taps prefer it so legs can be joined
      if (!this._comps[this.profile]) {
        const net = this.net, p = this.profile, comp = new Int32Array(net.N).fill(-1);
        let best = -1, bestSize = 0, id = 0;
        for (let s = 0; s < net.N; s++) {
          if (comp[s] >= 0) continue; const st = [s]; comp[s] = id; let size = 0;
          while (st.length) {
            const n = st.pop(); size++;
            for (let i = net.adjStart[n]; i < net.adjStart[n + 1]; i++) {
              const e = net.adj[i]; if (!net.allowed(e, p)) continue;
              const m = net.eU[e] === n ? net.eV[e] : net.eU[e]; if (comp[m] < 0) { comp[m] = id; st.push(m); }
            }
          }
          if (size > bestSize) { bestSize = size; best = id; } id++;
        }
        this._comps[p] = { comp, main: best };
      }
      this.comp = this._comps[this.profile].comp; this.main = this._comps[this.profile].main;
      return this.profile;
    }
    _open(e) { return !(this.avoidClosures && this.net.blocked[e]) && this.net.allowed(e, this.profile); }
    opts() { return { pcnFactor: this.pcnFactor, mode: 'oneway', profile: this.profile }; }
    snapPoint(lat, lon, tolM) {
      const n = this.net;
      return n.snap(lat, lon, tolM, (e) => this._open(e) && this.comp[n.eU[e]] === this.main) || n.snap(lat, lon, tolM, (e) => this._open(e));
    }
    _withBlocked(fn) { // routing honours closures only when avoidClosures is on
      if (this.avoidClosures) return fn();
      const saved = this.net.blocked; this.net.blocked = new Uint8Array(this.net.E);
      try { return fn(); } finally { this.net.blocked = saved; }
    }
    legCoords(A, B, opts) {
      if (A.edge === B.edge && Math.abs(A.t - B.t) < 0.05) return [[A.lat, A.lon]];
      const r = this._withBlocked(() => this.net.route(A, B, opts || this.opts()));
      if (!r) return null;
      return dedupe([].concat(...this.net.pieces(r.parts).map(p => p.coords)));
    }
    /** Path between two arbitrary points; short straight connectors where a point sits off the network.
     *  avoid: optional Set of edge ids to steer away from (they cost 8x their length). */
    path(a, b, tolM = 250, avoid = null) {
      const A = this.snapPoint(a[0], a[1], Math.max(tolM, 400)), B = this.snapPoint(b[0], b[1], tolM);
      if (!A || !B) return null;
      const mid = this.legCoords(A, B, avoid ? Object.assign(this.opts(), { avoid }) : null); if (!mid) return null;
      return join(A.dist > 1 ? [a] : [], mid, B.dist > 1 ? [b] : []);
    }
    /** One Viterbi pass. Returns chosen candidate index per layer (ks) and the A* result into each layer (rs). */
    _viterbi(layers, sigma, beta, opts) {
      const n = this.net;
      let cost = layers[0].c.map(c => (c.dist / sigma) ** 2); const hist = [cost], back = [null];
      for (let i = 1; i < layers.length; i++) {
        const prev = layers[i - 1], cur = layers[i], gc = D(prev.s, cur.s);
        const ncost = new Array(cur.c.length).fill(Infinity), nb = new Array(cur.c.length).fill(null);
        cur.c.forEach((ck, k) => {
          const em = (ck.dist / sigma) ** 2;
          prev.c.forEach((cj, j) => {
            if (cost[j] === Infinity) return;
            const r = (cj.edge === ck.edge && Math.abs(cj.t - ck.t) < 0.05) ? { parts: [], length: 0 } : this._withBlocked(() => n.route(cj, ck, opts));
            if (!r) return;
            const tot = cost[j] + Math.abs(r.length - gc) / beta + em;
            if (tot < ncost[k]) { ncost[k] = tot; nb[k] = { j, r }; }
          });
        });
        if (ncost.every(v => v === Infinity)) ncost.forEach((_, k) => { ncost[k] = (cur.c[k].dist / sigma) ** 2; nb[k] = { j: -1, r: null }; });
        back.push(nb); cost = ncost; hist.push(cost);
      }
      const argmin = (a) => a.indexOf(Math.min(...a));
      const ks = new Array(layers.length), rs = new Array(layers.length).fill(null);
      let k = argmin(cost);
      for (let i = layers.length - 1; i >= 1; i--) {
        ks[i] = k; const b = back[i][k];
        if (b.j < 0) { k = argmin(hist[i - 1]); continue; }
        rs[i] = b.r; k = b.j;
      }
      ks[0] = k;
      return { ks, rs };
    }
    /** Snap a freehand trace to roads and paths (HMM map matching, Viterbi). */
    matchTrace(points, tolM = 40) {
      const n = this.net, pts = dedupe(points); if (!pts.length) return null;
      const L = length(pts); let step = Math.min(40, Math.max(8, tolM / 2));
      if (L / step > 400) step = L / 400;
      const samples = L > 0 ? resample(pts, step) : pts;
      const sigma = Math.max(6, tolM / 3), beta = 15, opts = { pcnFactor: 1, mode: 'oneway', profile: this.profile };
      let layers = [];
      for (const s of samples) {
        const c = n.candidates(s[0], s[1], tolM, 4, (e) => this._open(e));
        if (c.length) layers.push({ s, c });
      }
      if (!layers.length) return null;
      if (layers.length === 1) { const b = layers[0].c[0]; return [[b.lat, b.lon]]; }
      // Viterbi, then drop outlier samples whose chosen candidate forces a detour in and out, and re-run
      let res = null;
      for (let pass = 0; pass < 3; pass++) {
        res = this._viterbi(layers, sigma, beta, opts);
        const drop = new Set();
        for (let i = 1; i < layers.length - 1; i++) {
          const rin = res.rs[i], rout = res.rs[i + 1];
          const gin = D(layers[i - 1].s, layers[i].s), gout = D(layers[i].s, layers[i + 1].s);
          if (rin && rout && rin.length > 1.6 * gin + 60 && rout.length > 1.6 * gout + 60) drop.add(i);
        }
        if (!drop.size) break;
        layers = layers.filter((_, i) => !drop.has(i));
      }
      const chain = [];
      for (let i = 1; i < layers.length; i++) {
        const cj = layers[i - 1].c[res.ks[i - 1]], ck = layers[i].c[res.ks[i]], r = res.rs[i];
        if (!r) { chain.push([[cj.lat, cj.lon]], [[ck.lat, ck.lon]]); continue; }   // gap: no path between samples
        chain.push(r.parts.length ? dedupe([].concat(...n.pieces(r.parts).map(p => p.coords))) : [[cj.lat, cj.lon], [ck.lat, ck.lon]]);
      }
      return despur(join(...chain));
    }
  }

  // ---------------- editor ----------------
  let wpSeq = 1;
  class RouteEditor {
    constructor(router) { this.router = router; this.coords = []; this.wps = []; this.past = []; this.future = []; this.snap = true; this.listeners = []; }
    onChange(fn) { this.listeners.push(fn); }
    _emit() { for (const f of this.listeners) f(this); }
    get distance() { return length(this.coords); }
    get start() { return this.coords[0] || null; }
    get end() { return this.coords[this.coords.length - 1] || null; }
    _commit(coords, wps = this.wps) {
      this.past.push({ coords: this.coords, wps: this.wps }); if (this.past.length > 100) this.past.shift();
      this.future = []; this.coords = coords; this.wps = wps; this._emit(); return { ok: true };
    }
    canUndo() { return this.past.length > 0; }
    canRedo() { return this.future.length > 0; }
    undo() { const s = this.past.pop(); if (!s) return { ok: false, msg: 'Nothing to undo' }; this.future.push({ coords: this.coords, wps: this.wps }); Object.assign(this, s); this._emit(); return { ok: true }; }
    redo() { const s = this.future.pop(); if (!s) return { ok: false, msg: 'Nothing to redo' }; this.past.push({ coords: this.coords, wps: this.wps }); Object.assign(this, s); this._emit(); return { ok: true }; }
    _connect(a, b) {
      if (D(a, b) < 0.5) return [a];
      if (!this.snap) return [a, b];
      return this.router.path(a, b) || null;
    }
    /** Tap: first tap sets the start, later taps extend the route to the tapped point. */
    addPoint(lat, lon, tolM = 60) {
      if (!this.coords.length) {
        if (!this.snap) return this._commit([[lat, lon]]);
        const p = this.router.snapPoint(lat, lon, tolM);
        if (!p) return { ok: false, msg: 'No road or path near there. Zoom in, or turn off Snap to place a free point.' };
        return this._commit([[p.lat, p.lon]]);
      }
      let target = [lat, lon];
      if (this.snap) { const p = this.router.snapPoint(lat, lon, tolM); if (!p) return { ok: false, msg: 'No road or path near there. Zoom in, or turn off Snap to draw a straight line.' }; target = [p.lat, p.lon]; }
      const seg = this._connect(this.end, target);
      if (!seg) return { ok: false, msg: 'No open path reaches that point. Turn off Snap to draw a straight line.' };
      return this._commit(join(this.coords, seg));
    }
    /** Freehand stroke: extends the route, or replaces the section between where it starts and ends on the route. */
    addTrace(points, tolM = 40) {
      const pts = dedupe(points);
      if (pts.length < 2 || length(pts) < 5) return pts.length ? this.addPoint(pts[0][0], pts[0][1], tolM) : { ok: false, msg: 'Draw a longer line' };
      const piece = this.snap ? this.router.matchTrace(pts, tolM) : simplify(pts, 1.5);
      if (!piece || piece.length < 2) return { ok: false, msg: 'Could not match that line to roads or paths. Zoom in and trace closer to them, or turn off Snap.' };
      if (!this.coords.length) return this._commit(piece);
      const end = this.end, nearEnd = D(pts[0], end) <= tolM || D(piece[0], end) <= tolM;
      if (!nearEnd && this.coords.length > 1) {
        // where the stroke starts and ends on the route; on overlapping legs pick the pair whose
        // stretch of route is closest in length to the new piece (same leg, not across the turnaround)
        const S0 = locateAll(this.coords, pts[0], tolM), E0 = locateAll(this.coords, pts[pts.length - 1], tolM), want = length(piece);
        let best = null;
        for (const s of S0) for (const e of E0) {
          const span = Math.abs(e.d - s.d); if (span <= tolM) continue;
          const score = Math.abs(span - want) + s.dist + e.dist; if (!best || score < best.score) best = { s, e, score };
        }
        if (best) {
          const s = best.s, e = best.e;
          let a = s.d, b = e.d, p = piece; if (a > b) { [a, b] = [b, a]; p = piece.slice().reverse(); }
          const before = slice(this.coords, 0, a), after = slice(this.coords, b, this.distance);
          const c1 = this._connect(before[before.length - 1], p[0]) || [before[before.length - 1], p[0]];
          const c2 = this._connect(p[p.length - 1], after[0]) || [p[p.length - 1], after[0]];
          return this._commit(join(before, c1, p, c2, after));
        }
      }
      const conn = this._connect(end, piece[0]) || [end, piece[0]];
      return this._commit(join(this.coords, conn, piece));
    }
    /** Eraser stroke: removes the touched stretch; trims an end, or reconnects a gap in the middle. */
    erase(points, radiusM) {
      if (!this.coords.length) return { ok: false, msg: 'Nothing to erase' };
      if (this.coords.length === 1) return points.some(p => D(p, this.coords[0]) <= radiusM) ? this._commit([], this.wps) : { ok: false, msg: 'Nothing to erase there' };
      const stroke = points.length > 1 ? resample(points, Math.max(2, radiusM / 3)) : points;
      const dense = resample(this.coords, Math.max(2, Math.min(5, radiusM / 4))), cum = cumul(dense);
      let i0 = -1, i1 = -1;
      dense.forEach((c, i) => { if (stroke.some(p => D(p, c) <= radiusM)) { if (i0 < 0) i0 = i; i1 = i; } });
      if (i0 < 0) return { ok: false, msg: 'Nothing to erase there' };
      const L = this.distance, d0 = cum[i0], d1 = cum[i1], atStart = i0 === 0, atEnd = i1 === dense.length - 1;
      if (atStart && atEnd) return this._commit([]);
      if (atStart) return this._commit(slice(this.coords, d1, L));
      if (atEnd) return this._commit(slice(this.coords, 0, d0));
      const before = slice(this.coords, 0, d0), after = slice(this.coords, d1, L);
      const a = before[before.length - 1], b = after[0];
      // join the gap another way: the roads and paths under the erased stretch cost 8x, so a detour wins
      // unless it is much longer; if the erased stretch is still the only sensible way, say so
      let conn = null, note = '';
      if (this.snap && D(a, b) >= 0.5) {
        const gone = slice(this.coords, d0, d1), avoid = new Set(), n = this.router.net;
        for (const p of resample(gone, 5)) { const s = n.snap(p[0], p[1], 4, (e) => this.router._open(e)); if (s) avoid.add(s.edge); }
        conn = this.router.path(a, b, 250, avoid);
        if (conn) {
          const kept = resample(gone, 10).filter(p => locate(conn, p).dist < 6).length / Math.max(1, resample(gone, 10).length);
          if (kept > 0.8) note = 'There is no other way through there, so the route still uses it';
        }
      }
      conn = conn || this._connect(a, b) || [a, b];
      const res = this._commit(join(before, conn, after));
      if (note) res.note = note;
      return res;
    }
    outAndBack() { if (this.coords.length < 2) return { ok: false, msg: 'Draw a route first' }; return this._commit(join(this.coords, this.coords.slice().reverse())); }
    closeLoop() {
      if (this.coords.length < 2) return { ok: false, msg: 'Draw a route first' };
      if (D(this.start, this.end) < 5) return { ok: false, msg: 'The route already ends at the start' };
      const conn = this._connect(this.end, this.start); if (!conn) return { ok: false, msg: 'No open path back to the start. Turn off Snap to close with a straight line.' };
      return this._commit(join(this.coords, conn));
    }
    reverse() { if (this.coords.length < 2) return { ok: false, msg: 'Draw a route first' }; return this._commit(this.coords.slice().reverse()); }
    /** Keep only the first distM metres (e.g. trim to 8 km before an out & back). */
    trim(distM) { const L = this.distance; if (!(distM > 0) || distM >= L) return { ok: false, msg: `The route is ${(L / 1000).toFixed(2)} km, so there is nothing to trim` }; return this._commit(slice(this.coords, 0, distM)); }
    clear() { if (!this.coords.length && !this.wps.length) return { ok: false, msg: 'Nothing to clear' }; return this._commit([], []); }
    load(coords, wps = []) { return this._commit(dedupe(coords), wps.map(w => Object.assign({ id: 'w' + (wpSeq++) }, w))); }
    addWaypoint(lat, lon, title = 'Waypoint', notes = '') { const w = { id: 'w' + (wpSeq++), lat, lon, title, notes }; this._commit(this.coords, this.wps.concat([w])); return { ok: true, id: w.id }; }
    updateWaypoint(id, fields) { return this._commit(this.coords, this.wps.map(w => (w.id === id ? Object.assign({}, w, fields) : w))); }
    removeWaypoint(id) { return this._commit(this.coords, this.wps.filter(w => w.id !== id)); }
  }

  // ---------------- share payload ----------------
  function toShare(coords, wps) {
    const json = JSON.stringify({ v: 1, p: encode(simplify(coords, 0.4)), w: wps.map(w => [+w.lat.toFixed(5), +w.lon.toFixed(5), w.title]) });
    const b64 = (typeof btoa === 'function' ? btoa(unescape(encodeURIComponent(json))) : Buffer.from(json, 'utf8').toString('base64'));
    return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }
  function fromShare(s) {
    const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
    const json = typeof atob === 'function' ? decodeURIComponent(escape(atob(b64))) : Buffer.from(b64, 'base64').toString('utf8');
    const o = JSON.parse(json); if (o.v !== 1) throw new Error('Unknown share version');
    return { coords: decode(o.p), wps: (o.w || []).map(([lat, lon, title]) => ({ lat, lon, title: String(title || 'Waypoint'), notes: '' })) };
  }

  return { Router, RouteEditor, geo: { D, dedupe, cumul, length, slice, locate, locateAll, resample, simplify, despur, pointAt, join }, encode, decode, toShare, fromShare, elevationSamples, smoothElevation, gainLoss };
});
