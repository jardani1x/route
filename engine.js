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
  /** Elevation lookups with a cell cache and polite retries.
   *  Open-Meteo counts each coordinate in a request roughly as one call against per-minute, per-hour and
   *  per-day limits, so re-asking for a whole route on every edit soon gets "429 Too Many Requests".
   *  Points are snapped to a grid of ELEV_GRID degrees (~44 m, half the 90 m cell of the Copernicus model
   *  behind the API, so snapping hardly changes the answer) and each grid point is fetched once: an edit
   *  asks only for the cells the route did not cover before, and an out-and-back asks for its way out only.
   *  On 429 it waits (Retry-After, else 2 s, then 6 s) and tries again; then it gives up with err.code 'busy'.
   *  Other failures: 'offline' (no answer), 'http' (an error status), 'bad' (an answer it cannot use). */
  const ELEV_GRID = 0.0004;
  class ElevationStore {
    constructor({ url, fetch, wait, retries = [2000, 6000], max = 20000, grid = ELEV_GRID }) {
      this.url = url; this.fetch = fetch; this.retries = retries; this.max = max; this.grid = grid;
      this.wait = wait || ((ms) => new Promise((r) => setTimeout(r, ms)));
      this.cells = new Map(); this.requests = 0; this.points = 0;
    }
    key(la, lo) { return Math.round(la / this.grid) + ',' + Math.round(lo / this.grid); }
    _coord(k) { const [a, b] = k.split(',').map(Number); return [(a * this.grid).toFixed(5), (b * this.grid).toFixed(5)]; }
    /** Elevations for pts ([lat, lon] pairs), in order. onBusy() is called before each wait after a 429.
     *  Calls run one after another, so a second edit reuses what the first one fetched. */
    get(pts, onBusy) {
      const run = (this._q || Promise.resolve()).then(() => this._get(pts, onBusy));
      this._q = run.catch(() => {});
      return run;
    }
    async _get(pts, onBusy) {
      const keys = pts.map((p) => this.key(p[0], p[1]));
      const need = [...new Set(keys)].filter((k) => !this.cells.has(k));
      for (let i = 0; i < need.length; i += 100) {
        const chunk = need.slice(i, i + 100), vals = await this._ask(chunk, onBusy);
        chunk.forEach((k, j) => this.cells.set(k, vals[j]));
      }
      for (const k of keys) { const v = this.cells.get(k); this.cells.delete(k); this.cells.set(k, v); }  // recently used last
      while (this.cells.size > this.max) this.cells.delete(this.cells.keys().next().value);
      return keys.map((k) => this.cells.get(k));
    }
    async _ask(chunk, onBusy) {
      const cs = chunk.map((k) => this._coord(k));
      const url = `${this.url}?latitude=${cs.map((c) => c[0]).join(',')}&longitude=${cs.map((c) => c[1]).join(',')}`;
      for (let attempt = 0; ; attempt++) {
        let r;
        try { r = await this.fetch(url); } catch (e) { throw Object.assign(new Error('Open-Meteo could not be reached'), { code: 'offline' }); }
        this.requests++;
        if (r.status === 429) {
          if (attempt >= this.retries.length) throw Object.assign(new Error('Open-Meteo is busy'), { code: 'busy' });
          const after = Number(r.headers && r.headers.get && r.headers.get('retry-after'));
          if (onBusy) onBusy();
          await this.wait(after > 0 ? Math.min(after * 1000, 30000) : this.retries[attempt]);
          continue;
        }
        if (!r.ok) throw Object.assign(new Error('Open-Meteo answered ' + r.status), { code: 'http' });
        const j = await r.json();
        if (!j || !Array.isArray(j.elevation) || j.elevation.length !== chunk.length || j.elevation.some((v) => typeof v !== 'number' || !isFinite(v)))
          throw Object.assign(new Error('Open-Meteo sent an answer that could not be used'), { code: 'bad' });
        this.points += chunk.length;
        return j.elevation;
      }
    }
    /** For localStorage: [[key, metres], ...], most recently used last. */
    dump(limit = 8000) { return [...this.cells].slice(-limit); }
    load(list) { if (Array.isArray(list)) for (const e of list) if (Array.isArray(e) && typeof e[0] === 'string' && isFinite(e[1])) this.cells.set(e[0], e[1]); }
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
  /**
   * The route editor. A finish ('outback' = back the same way, 'loop' = back to the start by the shortest
   * way) stays live and removable: `base` keeps the route as drawn, `coords` is what is shown and exported.
   * While a finish is on, every edit (tap, trace, eraser, trim) changes the drawn route and the way back is
   * worked out again, so the route can still be extended or changed after closing it; outAndBack() or
   * closeLoop() again, or removeFinish(), takes it off.
   */
  class RouteEditor {
    constructor(router) { this.router = router; this.coords = []; this.wps = []; this.base = null; this.finish = null; this.past = []; this.future = []; this.snap = true; this.listeners = []; this._before = null; }
    onChange(fn) { this.listeners.push(fn); }
    _emit() { for (const f of this.listeners) f(this); }
    get distance() { return length(this.coords); }
    /** Length of the route as drawn, without the way back. */
    get baseDistance() { return length(this.finish ? this.base : this.coords); }
    get start() { return this.coords[0] || null; }
    get end() { return this.coords[this.coords.length - 1] || null; }
    _state() { return { coords: this.coords, wps: this.wps, base: this.base, finish: this.finish }; }
    /** The shown route for a drawn route plus a finish, or null if the finish cannot be made. */
    _finished(base, finish) {
      if (base.length < 2) return null;
      if (finish === 'outback') return join(base, base.slice().reverse());
      if (finish === 'loop') {
        const a = base[base.length - 1], b = base[0];
        if (D(a, b) < 5) return base.slice();
        const conn = this._connect(a, b); return conn ? join(base, conn) : null;
      }
      return null;
    }
    _commit(coords, wps = this.wps) {
      const prev = this._before || this._state();
      let base = null, finish = null, shown = coords, note = '';
      if (this._before && this._before.finish) {          // an edit made under a finish: put the finish back on
        const f = this._finished(coords, this._before.finish);
        if (f) { base = coords; finish = this._before.finish; shown = f; }
        else if (coords.length >= 2) note = this._before.finish === 'loop' ? 'No path back to the start from there, so the loop is off' : '';
      } else if (!this._before && coords === this.coords && this.finish) { base = this.base; finish = this.finish; }   // waypoint-only change
      this.past.push(prev); if (this.past.length > 100) this.past.shift();
      this.future = []; Object.assign(this, { coords: shown, wps, base, finish }); this._emit();
      return note ? { ok: true, note } : { ok: true };
    }
    /** Run an edit on the route as drawn (without its finish); _commit puts the finish back on. */
    _edit(fn) {
      if (!this.finish) return fn();
      const before = this._state(); this._before = before; this.coords = before.base;
      try { return fn(); } finally { this._before = null; if (this.coords === before.base) Object.assign(this, before); }
    }
    canUndo() { return this.past.length > 0; }
    canRedo() { return this.future.length > 0; }
    undo() { const s = this.past.pop(); if (!s) return { ok: false, msg: 'Nothing to undo' }; this.future.push(this._state()); Object.assign(this, s); this._emit(); return { ok: true }; }
    redo() { const s = this.future.pop(); if (!s) return { ok: false, msg: 'Nothing to redo' }; this.past.push(this._state()); Object.assign(this, s); this._emit(); return { ok: true }; }
    _connect(a, b) {
      if (D(a, b) < 0.5) return [a];
      if (!this.snap) return [a, b];
      return this.router.path(a, b) || null;
    }
    /** Tap: first tap sets the start, later taps extend the route to the tapped point. */
    addPoint(lat, lon, tolM = 60) { return this._edit(() => this._addPoint(lat, lon, tolM)); }
    _addPoint(lat, lon, tolM) {
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
    addTrace(points, tolM = 40) { return this._edit(() => this._addTrace(points, tolM)); }
    _addTrace(points, tolM) {
      const pts = dedupe(points);
      if (pts.length < 2 || length(pts) < 5) return pts.length ? this._addPoint(pts[0][0], pts[0][1], tolM) : { ok: false, msg: 'Draw a longer line' };
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
      const shown = this.coords, finish = this.finish;
      const r = this._edit(() => this._erase(points, radiusM));
      // under a loop, the way back to the start is not part of the drawn route
      if (!r.ok && finish === 'loop' && shown.length > 1) {
        const dense = resample(shown, 5);
        if (points.some(p => dense.some(c => D(p, c) <= radiusM))) return { ok: false, msg: 'That part is the way back to the start. Take the loop off (Finish route, then Loop) to change it.' };
      }
      return r;
    }
    _erase(points, radiusM) {
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
    /** Put a finish on, switch to the other one, or take it off if it is already on. */
    _setFinish(type) {
      const base = this.finish ? this.base : this.coords;
      if (this.finish === type) return this.removeFinish();
      if (base.length < 2) return { ok: false, msg: 'Draw a route first' };
      if (type === 'loop' && D(base[0], base[base.length - 1]) < 5) return { ok: false, msg: 'The route already ends at the start' };
      const shown = this._finished(base, type);
      if (!shown) return { ok: false, msg: 'No open path back to the start. Turn off Snap to close with a straight line.' };
      this.past.push(this._state()); if (this.past.length > 100) this.past.shift();
      this.future = []; Object.assign(this, { coords: shown, base, finish: type }); this._emit();
      return { ok: true };
    }
    outAndBack() { return this._setFinish('outback'); }
    closeLoop() { return this._setFinish('loop'); }
    /** Take the out & back or loop off, back to the route as drawn. */
    removeFinish() {
      if (!this.finish) return { ok: false, msg: 'The route has no out & back or loop to take off' };
      this.past.push(this._state()); if (this.past.length > 100) this.past.shift();
      this.future = []; Object.assign(this, { coords: this.base, base: null, finish: null }); this._emit();
      return { ok: true };
    }
    reverse() {
      if (this.coords.length < 2) return { ok: false, msg: 'Draw a route first' };
      if (this.finish === 'outback') return { ok: false, msg: 'An out & back is the same route both ways' };
      if (this.finish === 'loop') {   // run the loop the other way: drawn route = the loop reversed, minus nothing to rebuild
        const r = this._commit(this.coords.slice().reverse());
        return Object.assign(r, { note: 'Reversed. The way back is now part of the drawn route.' });
      }
      return this._commit(this.coords.slice().reverse());
    }
    /** Keep only the first distM metres of the route as drawn (e.g. 8 km before an out & back). */
    trim(distM) { return this._edit(() => { const L = this.distance; if (!(distM > 0) || distM >= L) return { ok: false, msg: `The route is ${(L / 1000).toFixed(2)} km, so there is nothing to trim` }; return this._commit(slice(this.coords, 0, distM)); }); }
    clear() { if (!this.coords.length && !this.wps.length) return { ok: false, msg: 'Nothing to clear' }; return this._commit([], []); }
    /** Load a route; with finish, coords are the route as drawn and the finish is put back on. */
    load(coords, wps = [], finish = null) {
      const c = dedupe(coords), w = wps.map(x => Object.assign({ id: 'w' + (wpSeq++) }, x));
      const shown = finish ? this._finished(c, finish) : null;
      this.past.push(this._state()); if (this.past.length > 100) this.past.shift();
      this.future = []; Object.assign(this, shown ? { coords: shown, wps: w, base: c, finish } : { coords: c, wps: w, base: null, finish: null }); this._emit();
      return { ok: true };
    }
    addWaypoint(lat, lon, title = 'Waypoint', notes = '') { const w = { id: 'w' + (wpSeq++), lat, lon, title, notes }; this._commit(this.coords, this.wps.concat([w])); return { ok: true, id: w.id }; }
    updateWaypoint(id, fields) { return this._commit(this.coords, this.wps.map(w => (w.id === id ? Object.assign({}, w, fields) : w))); }
    removeWaypoint(id) { return this._commit(this.coords, this.wps.filter(w => w.id !== id)); }
  }

  // ---------------- turn-by-turn ----------------
  const bearingOf = (a, b) => {
    const kx = KX0 * Math.cos(a[0] * Math.PI / 180);
    return (Math.atan2((b[1] - a[1]) * kx, (b[0] - a[0]) * KY) * 180 / Math.PI + 360) % 360;
  };
  const turnAngle = (b1, b2) => ((b2 - b1 + 540) % 360) - 180;   // + right, - left
  const COMPASS = ['north', 'north-east', 'east', 'south-east', 'south', 'south-west', 'west', 'north-west'];
  const compass = (b) => COMPASS[Math.round(b / 45) % 8];
  const KIND_WORD = ['road', 'park connector', 'crossing', 'path', 'steps', 'pavement', 'service road'];

  /**
   * Turn-by-turn cues for a route, using the network for the names of the ways it follows.
   * Returns [{d, type, angle, text, name}] in order: 'depart' at 0, then turns, 'arrive' at the end.
   * A turn is called where the way's name changes or where the route bends by 35 degrees or more at a
   * junction (at least three ways meet), so a curving road or park path does not chatter. Types:
   * continue, slight-left/right, left/right, sharp-left/right, uturn. ends: 'start' if it finishes where
   * it began (a loop or an out & back). opts.turnaround: distance of an out & back's turnaround, which
   * becomes one 'uturn' cue with nothing else called within 40 m of it.
   */
  function turnCues(net, coords, opts = {}) {
    const step = 5, L = length(coords);
    if (coords.length < 2 || L < 15) return [];
    const pts = resample(coords, step), cum = cumul(pts), n = pts.length;
    // the way under each sample: its name, else the street beside a pavement or crossing, else what it is
    const label = new Array(n), named = new Array(n).fill(false);
    for (let i = 0; i < n; i++) {
      const p = pts[i], s = net.snap(p[0], p[1], 8);
      if (!s) { label[i] = i ? label[i - 1] : 'path'; named[i] = i ? named[i - 1] : false; continue; }
      const k = net.eKind[s.edge]; let nm = net.nameOf(s.edge);
      if (!nm && (k === 5 || k === 2)) { const r = net.snap(p[0], p[1], 25, (e) => (net.eKind[e] === 0 || net.eKind[e] === 6) && !!net.nameOf(e)); if (r) nm = net.nameOf(r.edge); }
      label[i] = nm || KIND_WORD[k] || 'path'; named[i] = !!nm;
    }
    // runs of the same way; a run under 30 m (a crossing, a gap in the data) joins the run before it
    let runs = [];
    for (let i = 0; i < n; i++) {
      const r = runs[runs.length - 1];
      if (r && r.label === label[i]) r.j = i; else runs.push({ label: label[i], named: named[i], i, j: i });
    }
    for (let k = 1; k < runs.length; k++) {
      if (cum[runs[k].j] - cum[runs[k].i] < 30 && k < runs.length - 1) { runs[k - 1].j = runs[k].j; runs.splice(k, 1); k--; }
    }
    for (let k = 1; k < runs.length; k++) if (runs[k].label === runs[k - 1].label) { runs[k - 1].j = runs[k].j; runs.splice(k, 1); k--; }
    const runAt = (i) => runs.find(r => i >= r.i && i <= r.j) || runs[runs.length - 1];
    // bend at each sample, over 15 m either side
    const W = 3, ang = new Float64Array(n);
    for (let i = W; i < n - W; i++) ang[i] = turnAngle(bearingOf(pts[i - W], pts[i]), bearingOf(pts[i], pts[i + W]));
    const junction = (p) => {
      const s = net.snap(p[0], p[1], 10); if (!s || !net.adjStart) return false;
      const len = net.eLen[s.edge], node = s.t < 12 ? net.eU[s.edge] : s.t > len - 12 ? net.eV[s.edge] : -1;
      return node >= 0 && net.adjStart[node + 1] - net.adjStart[node] >= 3;
    };
    // candidate turns: run boundaries, and the sharpest sample of each bend of 35 degrees or more
    const cand = [];
    for (let k = 1; k < runs.length; k++) cand.push({ i: runs[k].i, change: true });
    for (let i = W; i < n - W; i++) {
      const a = Math.abs(ang[i]);
      if (a >= 35 && a >= Math.abs(ang[i - 1]) && a >= Math.abs(ang[i + 1]) && (a >= 150 || junction(pts[i]))) cand.push({ i, change: false });
    }
    cand.sort((x, y) => x.i - y.i);
    // how much the route turns across 40 m either side: a U-turn spreads over several samples
    const wide = (i) => turnAngle(bearingOf(pts[Math.max(0, i - 8)], pts[i]), bearingOf(pts[i], pts[Math.min(n - 1, i + 8)]));
    const cues = [];
    for (const c of cand) {
      // the strongest bend within 20 m of the candidate is where the turn is
      let bi = c.i;
      for (let i = Math.max(W, c.i - 4); i <= Math.min(n - W - 1, c.i + 4); i++) if (Math.abs(ang[i]) > Math.abs(ang[bi])) bi = i;
      let a = ang[bi] || 0; const wa = wide(bi);
      if (Math.abs(wa) >= 150) a = wa;                                   // a U-turn
      const abs = Math.abs(a), run = runAt(Math.min(n - 1, bi + W)), d = cum[bi];
      if (!c.change && abs < 35) continue;
      const prev = cues[cues.length - 1];
      if (prev && d - prev.d < (abs >= 150 || Math.abs(prev.angle) >= 150 ? 45 : 25)) { if (abs > Math.abs(prev.angle)) cues.pop(); else continue; }
      const side = a > 0 ? 'right' : 'left';
      const type = abs < 20 ? 'continue' : abs < 55 ? 'slight-' + side : abs < 135 ? side : abs < 165 ? 'sharp-' + side : 'uturn';
      // "continue onto" only for a new street name: carrying on along an unnamed path is not news
      if (type === 'continue' && (!prev || runAt(bi - W).label === run.label || !run.named)) continue;
      cues.push({ d, type, angle: Math.round(a), name: run.label, named: run.named, same: runAt(Math.max(0, bi - 6)).label === run.label });
    }
    if (opts.turnaround > 0) {   // an out & back: one clear 'turn around' at the turnaround
      const t = opts.turnaround, r = runAt(cum.findIndex(x => x >= t));
      for (let k = cues.length - 1; k >= 0; k--) if (Math.abs(cues[k].d - t) < 40) cues.splice(k, 1);
      cues.push({ d: t, type: 'uturn', angle: 180, name: r.label, named: r.named, same: true });
      cues.sort((x, y) => x.d - y.d);
    }
    const way = (c) => (c.named ? c.name : 'the ' + c.name);
    const VERB = { continue: 'Continue', 'slight-left': 'Bear left', 'slight-right': 'Bear right', left: 'Turn left', right: 'Turn right', 'sharp-left': 'Turn sharp left', 'sharp-right': 'Turn sharp right', uturn: 'Turn around' };
    // unnamed ways: "to stay on the path" would suggest one path where there are several, so a turn that
    // stays on unnamed paths is just the turn
    for (const c of cues) {
      c.text = c.type === 'uturn' ? (c.named ? `Turn around on ${c.name}` : 'Turn around') : c.name === 'steps' ? `${VERB[c.type]} up or down the steps`
        : c.same ? (c.named ? `${VERB[c.type]} to stay on ${c.name}` : VERB[c.type]) : `${VERB[c.type]} onto ${way(c)}`;
      delete c.same;
    }
    // the first 30 m and the last 30 m are not worth a call: head off along the way the route settles on
    const i30 = Math.min(n - 1, Math.round(30 / step)), r0 = runAt(i30), first = { name: r0.label, named: r0.named };
    const b0 = bearingOf(pts[0], pts[Math.min(n - 1, i30)]);
    const loopy = D(coords[0], coords[coords.length - 1]) < 30;
    return [{ d: 0, type: 'depart', angle: 0, name: first.name, named: first.named, text: `Head ${compass(b0)} on ${way(first)}` }]
      .concat(cues.filter(c => c.d >= 30 && c.d <= L - 30))
      .concat([{ d: L, type: 'arrive', angle: 0, name: '', text: loopy ? 'Arrive back at the start' : 'Arrive at the finish', ends: loopy ? 'start' : 'elsewhere' }]);
  }

  /**
   * Follows a runner along a route from position fixes. Progress only moves forward (bar GPS jitter),
   * so on an out & back the way back is not mistaken for the way out. update() returns:
   *   {status: 'to-start' | 'on' | 'off' | 'done', along, left, dist (to the route), bearing (to it),
   *    next (cue), toNext (m), then (the cue after)}
   */
  class RouteTracker {
    constructor(coords, cues) {
      this.pts = resample(coords, 5); this.cum = cumul(this.pts); this.L = this.cum[this.cum.length - 1] || 0;
      this.cues = cues || []; this.along = null; this.offCount = 0;
      // first[i]: the earliest point (more than 60 m of route before i) within 20 m of point i, else i.
      // Where the route comes back over ground it has already covered, a fix there is not a short cut.
      const n = this.pts.length, first = this.first = new Int32Array(n), grid = new Map(), C = 20;
      const key = (p, dx, dy) => `${Math.floor(p[0] * 111000 / C) + dx},${Math.floor(p[1] * 111000 * Math.cos(p[0] * Math.PI / 180) / C) + dy}`;
      for (let i = 0; i < n; i++) {
        let f = i;
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) for (const j of grid.get(key(this.pts[i], dx, dy)) || []) {
          if (j < f && this.cum[i] - this.cum[j] > 60 && D(this.pts[i], this.pts[j]) < C) f = j;
        }
        first[i] = f; const k = key(this.pts[i], 0, 0); if (!grid.has(k)) grid.set(k, []); grid.get(k).push(i);
      }
    }
    _nearest(p, from, to) {
      let best = -1, bd = Infinity;
      for (let i = 0; i < this.pts.length; i++) { const d = this.cum[i]; if (d < from || d > to) continue; const x = D(p, this.pts[i]); if (x < bd) { bd = x; best = i; } }
      return { i: best, dist: bd };
    }
    /** Where on the route a fix is, between from and to metres along. Each place the route passes within
     *  tol of the fix is a local minimum of the distance. When the phone gives a heading (moving), a pass
     *  that runs the other way counts 30 m further. Of the passes about as near as the nearest (within
     *  12 m: the same path walked twice is equally near both times), the EARLIEST wins, so on an out &
     *  back or a spur the way out is taken until the heading or the distance says otherwise, and progress
     *  does not run ahead onto the way back. With hold, a fix behind the window (the distance still falling
     *  at its start) holds the progress instead of matching a later pass. */
    _match(p, from, to, tol, hd, hold) {
      let i0 = -1, i1 = -1;
      for (let i = 0; i < this.pts.length; i++) { const d = this.cum[i]; if (d < from) continue; if (d > to) break; if (i0 < 0) i0 = i; i1 = i; }
      if (i0 < 0) return -1;
      const n = i1 - i0 + 1, x = new Float64Array(n);
      for (let k = 0; k < n; k++) x[k] = D(p, this.pts[i0 + k]);
      const useHd = Number.isFinite(hd), N = this.pts.length;
      const wrong = (i) => { if (!useHd) return false; const b = bearingOf(this.pts[Math.max(0, i - 1)], this.pts[Math.min(N - 1, i + 1)]); return Math.abs(((hd - b) % 360 + 540) % 360 - 180) > 100; };
      const cand = [];
      for (let k = 0; k < n; k++) {
        if (x[k] > tol) continue;
        if ((k === 0 || x[k] <= x[k - 1]) && (k === n - 1 || x[k] < x[k + 1])) cand.push({ k, e: x[k] + (wrong(i0 + k) ? 30 : 0) });
      }
      if (!cand.length) return -1;
      if (hold && cand[0].k === 0 && n > 1 && cand[0].e === x[0]) return i0;   // behind the window: hold
      let be = Infinity; for (const c of cand) if (c.e < be) be = c.e;
      for (const c of cand) if (c.e <= be + 12) return i0 + c.k;
      return -1;
    }
    /** heading: degrees from the phone (coords.heading) while moving, else null. */
    update(lat, lon, accuracy = 10, heading = null) {
      // a fix counts as on the route within 2.5x its reported accuracy (35-60 m): phones under-report the
      // error between tall blocks, and a false "off route" every few minutes is worse than a late one
      const p = [lat, lon], tol = Math.max(35, Math.min(2.5 * (accuracy || 12), 60));
      let i = -1;
      if (this.along === null) i = this._match(p, 0, this.L, tol, heading, false);      // joining: the earliest place the route passes here
      else {
        // GPS noise can put a fix a little behind the progress so far: matching there counts as on route
        i = this._match(p, this.along - 40, this.along + 300, tol, heading, true);
        if (i >= 0) this.jump = null;
        else {   // a short cut further along: believe it after three fixes in a row agree, and only if that
          // ground is new (where the route comes back over ground already covered, it is not a short cut)
          const g = this._match(p, this.along + 300, this.L, tol, heading, false);
          if (g < 0 || this.cum[this.first[g]] <= this.along + 300) this.jump = null;
          else {
            this.jump = this.jump && Math.abs(this.cum[g] - this.jump.d) < 80 ? { d: this.cum[g], n: this.jump.n + 1 } : { d: this.cum[g], n: 1 };
            if (this.jump.n >= 3) { i = g; this.jump = null; }
          }
        }
      }
      if (i >= 0) {   // forward only, and no more than 40 m per fix unless it was a confirmed short cut
        const a = this.along === null ? this.cum[i] : Math.max(this.along, Math.min(this.cum[i], this.cum[i] - this.along > 300 ? this.cum[i] : this.along + 40));
        this.along = a; this.offCount = 0;
      }
      const out = { along: this.along || 0, left: this.L - (this.along || 0), L: this.L };
      if (this.along === null) {
        const s = this.pts[0], n = this._nearest(p, 0, this.L);
        Object.assign(out, { status: 'to-start', dist: D(p, s), bearing: bearingOf(p, s), nearestDist: n.dist });
      } else if (i < 0) {
        this.offCount++;
        const n = this._nearest(p, this.along - 50, this.along + 500), q = n.i >= 0 ? this.pts[n.i] : this.pts[0];
        Object.assign(out, { status: this.offCount >= 3 ? 'off' : 'on', dist: n.dist, bearing: bearingOf(p, q) });   // three misses in a row
      } else out.status = 'on';
      if (this.along !== null && this.L - this.along <= 15) out.status = 'done';
      // a cue stays "next" until 10 m past it, so a fix that lands on the corner still shows (and calls) it
      const a = this.along || 0, k = this.cues.findIndex(c => c.d > a - 10);
      out.next = k >= 0 ? this.cues[k] : null; out.toNext = out.next ? Math.max(0, out.next.d - a) : 0; out.then = k >= 0 ? this.cues[k + 1] || null : null;
      return out;
    }
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

  return { Router, RouteEditor, geo: { D, dedupe, cumul, length, slice, locate, locateAll, resample, simplify, despur, pointAt, join }, encode, decode, toShare, fromShare, elevationSamples, smoothElevation, gainLoss, ElevationStore, turnCues, RouteTracker };
});
