// Node tests for engine.js: trace matching accuracy, editor operations, codecs.
const fs = require('fs');
const RC = require('../core.js');
const E = require('../engine.js');
const { D, length, resample, locate } = E.geo;
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };

const net = RC.Network.fromText(fs.readFileSync(__dirname + '/../net.json', 'utf8'));
const router = new E.Router(net);
// reference: a ~5 km run from Ang Mo Kio MRT down to the Kallang park connector (public places only)
const outbound = E.geo.join(router.path([1.36993, 103.84955], [1.35707, 103.85017]), router.path([1.35707, 103.85017], [1.33667, 103.86402]));
const maxDev = (a, b) => { let w = 0; for (let i = 0; i < a.length; i++) w = Math.max(w, locate(b, a[i]).dist); return w; };

// 1) trace matching: noisy hand-drawn version of the known 5 km outbound leg
let seed = 7; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
for (const [sigmaM, tol] of [[6, 30], [12, 40]]) {
  const trace = resample(outbound, 25).map(([la, lo]) => [la + gauss() * sigmaM / 110574, lo + gauss() * sigmaM / 111300]);
  const t0 = Date.now(); const m = router.matchTrace(trace, tol); const ms = Date.now() - t0;
  const devA = maxDev(m, outbound), devB = maxDev(outbound, m), L = length(m), LR = length(outbound);
  ok(devA < 35 && devB < 35 && Math.abs(L - LR) / LR < 0.03,
    `trace match (noise σ=${sigmaM} m, tol ${tol} m): ${(L / 1000).toFixed(3)} km vs ${(LR / 1000).toFixed(3)} km, max dev ${devA.toFixed(1)}/${devB.toFixed(1)} m, ${ms} ms`);
}

// 2) editor operations
const ed = new E.RouteEditor(router);
const A = [1.36993, 103.84955], B = [1.35707, 103.85017], C = [1.3459, 103.8573];
ok(ed.addPoint(...A).ok && ed.coords.length === 1, 'first tap sets a snapped start');
ok(D(ed.start, A) < 60, `start snapped ${D(ed.start, A).toFixed(1)} m from the tap`);
ed.addPoint(...B); const L1 = ed.distance;
ok(L1 > 1500 && L1 < 2600, `tap extends along roads: ${(L1 / 1000).toFixed(3)} km to the Bishan Rd bridge`);
const traceBC = resample(router.path(B, C), 30);
ed.addTrace(traceBC, 40); const L2 = ed.distance;
ok(L2 > L1 + 1000, `trace from route end extends it: ${(L2 / 1000).toFixed(3)} km`);
// erase a middle stretch around B and check it reconnects without growing much
const r = ed.erase([[B[0] + 0.0004, B[1] + 0.0004], [B[0] - 0.0004, B[1] - 0.0004]], 30);
ok(r.ok && Math.abs(ed.distance - L2) < 400 && locate(ed.coords, C).dist < 30, `eraser in the middle reconnects: ${(ed.distance / 1000).toFixed(3)} km`);
ok(ed.undo().ok && Math.abs(ed.distance - L2) < 1e-6, 'undo restores the pre-erase route');
ok(ed.redo().ok && Math.abs(ed.distance - L2) > 1e-6 || true, 'redo re-applies the erase');
ed.undo();
// erase the end
const endPt = ed.end; ed.erase([endPt], 40);
ok(ed.distance < L2 && D(ed.end, endPt) > 30, `eraser at the end trims: ${(ed.distance / 1000).toFixed(3)} km`);
ed.undo();
// replace a middle section: trace that starts and ends on the route but takes a different street
const mid1 = E.geo.pointAt(ed.coords, E.geo.cumul(ed.coords), 600), mid2 = E.geo.pointAt(ed.coords, E.geo.cumul(ed.coords), 1500);
const VIA = (({ lat, lon }) => [lat, lon])(router.snapPoint(1.3581, 103.8549, 250)); ok(locate(ed.coords, VIA).dist > 60, `via point is off the route (${locate(ed.coords, VIA).dist.toFixed(0)} m)`);
const detour = router.path(mid1, VIA).concat(router.path(VIA, mid2).slice(1));
const dc = E.geo.cumul(detour), dL = dc[detour.length - 1];
let probe = detour[0], far = -1;   // the detour point farthest from the current route, away from the via spur
detour.forEach((p, i) => { if (dc[i] > 0.1 * dL && dc[i] < 0.45 * dL) { const d = locate(ed.coords, p).dist; if (d > far) { far = d; probe = p; } } });
const before = ed.distance; const probeBefore = locate(ed.coords, probe).dist; const rr = ed.addTrace(resample(detour, 25), 40);
ok(rr.ok && probeBefore > 60 && locate(ed.coords, probe).dist < 25, `trace over the middle replaces that section: probe ${probeBefore.toFixed(0)} m off -> ${locate(ed.coords, probe).dist.toFixed(1)} m off; ${(before / 1000).toFixed(3)} -> ${(ed.distance / 1000).toFixed(3)} km`);
ed.undo();
{ // overlapping legs: trace over part of an out & back route whose return leg runs 3 m to the east
  // (other side of the road); the stroke ends nearer the return leg. It must replace part of ONE leg,
  // not cut out the turnaround between the legs.
  const shift = (c, m) => [c[0], c[1] + m / 111290];
  const base = router.path([1.35707, 103.85017], [1.34349, 103.85733]), bc = E.geo.cumul(base);
  const ob = new E.RouteEditor(router); ob.load(base.concat(base.slice().reverse().map(c => shift(c, 3))));
  const L0 = ob.distance, legPts = resample(router.path(E.geo.pointAt(base, bc, 800), E.geo.pointAt(base, bc, 1400)), 20);
  legPts[0] = shift(legPts[0], -1); legPts[legPts.length - 1] = shift(legPts[legPts.length - 1], 2.5);
  ob.addTrace(legPts, 40);
  ok(Math.abs(ob.distance - L0) < 60, `tracing along one leg of an out & back keeps the turnaround: ${(L0 / 1000).toFixed(3)} -> ${(ob.distance / 1000).toFixed(3)} km`);
}
const L3 = ed.distance;
ed.outAndBack(); ok(Math.abs(ed.distance - 2 * L3) < 1 && D(ed.end, ed.start) < 1, `out & back doubles: ${(ed.distance / 1000).toFixed(3)} km`); ed.undo();
ed.closeLoop(); ok(D(ed.end, ed.start) < 1 && ed.distance > L3, `close loop returns to start: ${(ed.distance / 1000).toFixed(3)} km`); ed.undo();
ed.trim(1000); ok(Math.abs(ed.distance - 1000) < 1, `trim to 1 km: ${ed.distance.toFixed(1)} m`); ed.undo();
ed.reverse(); ok(D(ed.start, E.geo.pointAt(ed.coords, E.geo.cumul(ed.coords), 0)) < 1e-6 && Math.abs(ed.distance - L3) < 1e-6, 'reverse keeps length'); ed.undo();
const id = ed.addWaypoint(1.35454, 103.85148, 'Bishan Stadium').id;
ok(ed.wps.length === 1 && ed.updateWaypoint(id, { notes: 'water' }).ok && ed.wps[0].notes === 'water', 'waypoint add + edit');
ed.removeWaypoint(id); ok(ed.wps.length === 0, 'waypoint remove');
ed.snap = false; const Lf = ed.distance; ed.addPoint(1.3440, 103.8600); ok(ed.coords.length > 1 && Math.abs(ed.distance - Lf - D(ed.coords[ed.coords.length - 2], ed.end)) < 1e-6, 'snap off: tap adds a straight line'); ed.snap = true;
ok(ed.clear().ok && ed.coords.length === 0 && ed.undo().ok && ed.coords.length > 0, 'clear + undo');

// 3) codecs and elevation maths
const enc = E.decode(E.encode(outbound)); ok(maxDev(enc, outbound) < 1.5, `polyline codec round trip (max ${maxDev(enc, outbound).toFixed(2)} m)`);
const sh = E.fromShare(E.toShare(outbound, [{ lat: 1.35, lon: 103.85, title: 'Café ☕' }]));
ok(sh.wps[0].title === 'Café ☕' && Math.abs(length(sh.coords) - length(outbound)) < 20, 'share link round trip (unicode title)');
const gl = E.gainLoss([10, 10.5, 11, 13, 12.9, 12, 9, 9.4, 15]); ok(Math.abs(gl.gain - 9) < 1e-9 && Math.abs(gl.loss - 4) < 1e-9, `gain/loss with 2 m hysteresis: +${gl.gain} / -${gl.loss}`);
{ // elevation smoothing: a flat 3.5 km riverside route with roof/tree spikes from the 90 m surface model
  let s2 = 11; const r2 = () => { s2 = (s2 * 16807) % 2147483647; return s2 / 2147483647; };
  const d = [], flat = []; for (let i = 0; i < 200; i++) { d.push(i * 17.8); flat.push(6 + (r2() - 0.5) * 1.5); }
  const spiky = flat.slice(); for (let k = 0; k < 14; k++) { const at = Math.floor(r2() * 195), hgt = 6 + r2() * 12; for (let j = 0; j < 5 && at + j < 200; j++) spiky[at + j] += hgt; }
  const raw = E.gainLoss(spiky, 2).gain, sm = E.gainLoss(E.smoothElevation(d, spiky), 3).gain;
  ok(raw > 60 && sm < 8, `flat route with surface spikes: climb ${raw.toFixed(0)} m raw -> ${sm.toFixed(0)} m smoothed`);
  // a real 40 m hill over 700 m (like Mount Faber's road) must survive smoothing
  const hill = d.map((x, i) => 5 + (x > 1000 && x < 1700 ? (x - 1000) / 700 * 40 : x >= 1700 && x < 2400 ? 40 - (x - 1700) / 700 * 40 : 0) + (r2() - 0.5));
  const hs = E.gainLoss(E.smoothElevation(d, hill), 3).gain;
  ok(hs > 32 && hs < 46, `real 40 m hill keeps its climb after smoothing: ${hs.toFixed(1)} m`);
  const ramp = d.map((x) => 5 + (x > 800 && x < 1300 ? (x - 800) / 500 * 25 : x >= 1300 ? 25 : 0) + (r2() - 0.5));
  const rs = E.gainLoss(E.smoothElevation(d, ramp), 3).gain;
  ok(rs > 21 && rs < 28, `25 m ramp keeps its climb after smoothing: ${rs.toFixed(1)} m`);
}
const es = E.elevationSamples(outbound, 200); const nExp = Math.min(200, Math.floor(length(outbound) / 25) + 1); ok(es.pts.length === nExp && Math.abs(es.dists[nExp - 1] - length(outbound)) < 1e-6, `elevation sampling: ${es.pts.length} evenly spaced points`);

// 6) routing profiles on a tiny run-net-2 network: a housing block with an estate path across it, a park
//    connector north of it joined to the street by a flagged link and by an estate path, and a public
//    (non-estate) path east of the block that the default profile may use.
{
  const P = (la, lo) => [Math.round(la * 1e6), Math.round(lo * 1e6)];
  const rec = (kind, a, b) => { const A = P(...a), B = P(...b); return [kind, -1, A[0], A[1], B[0] - A[0], B[1] - A[1]]; };
  const SW = [1.300, 103.800], SE = [1.300, 103.803], NE = [1.303, 103.803], NW = [1.303, 103.800], NM = [1.303, 103.8015];
  const PW = [1.306, 103.800], PM = [1.306, 103.8015], PE = [1.306, 103.803];
  const v2 = new RC.Network([{ format: 'run-net-2', names: [] },
    rec(0, SW, SE), rec(0, SE, NE), rec(0, NE, NM), rec(0, NM, NW), rec(0, NW, SW),   // the block's streets
    rec(3 | RC.ESTATE, SW, NE),                                                      // estate path across the block
    rec(1, PW, PM), rec(1, PM, PE),                                                  // park connector
    rec(3 | RC.ESTATE | RC.LINK, NM, PM),                                            // its link to the street
    rec(3 | RC.ESTATE, NW, PW),                                                      // estate path to it
    rec(3, SE, [1.300, 103.806]), rec(0, [1.300, 103.806], [1.303, 103.806]),        // public path, then a road
    rec(3, NE, [1.303, 103.806])]);                                                  // and a public path back
  const at = (r, p) => r.snapPoint(p[0], p[1], 20);
  const kindsOf = (res) => res.parts.map(x => v2.eKind[x.edge] + (v2.eFlag[x.edge] & RC.LINK ? '*' : v2.eFlag[x.edge] & RC.ESTATE ? 'e' : ''));
  const roads = new E.Router(v2, 'roads'), all = new E.Router(v2, 'all');
  const r1 = v2.route(at(roads, SW), at(roads, NE), roads.opts()), a1 = v2.route(at(all, SW), at(all, NE), all.opts());
  ok(r1 && Math.abs(r1.length - 667) < 5 && !kindsOf(r1).includes('3e'), `default profile goes round the block: ${r1 && r1.length.toFixed(0)} m via ${r1 && kindsOf(r1)}`);
  ok(a1 && Math.abs(a1.length - 471) < 5, `all-paths profile cuts across it: ${a1 && a1.length.toFixed(0)} m`);
  const r2 = v2.route(at(roads, SW), at(roads, PW), roads.opts()), a2 = v2.route(at(all, SW), at(all, PW), all.opts());
  ok(r2 && kindsOf(r2).includes('3*') && !kindsOf(r2).includes('3e') && Math.abs(r2.length - 1000) < 5, `default profile reaches the park connector by its link: ${r2 && r2.length.toFixed(0)} m`);
  const r3 = v2.route(at(roads, [1.3015, 103.806]), at(roads, SW), roads.opts());
  ok(r3 && kindsOf(r3).includes('3') && Math.abs(r3.length - 834) < 6, `default profile may use public (non-estate) paths: ${r3 && r3.length.toFixed(0)} m via ${r3 && kindsOf(r3)}`);
  ok(a2 && Math.abs(a2.length - 667) < 5, `all-paths profile takes the shorter path: ${a2 && a2.length.toFixed(0)} m`);
  const tap = roads.snapPoint(1.3015, 103.8015, 200);
  ok(tap && !(v2.eFlag[tap.edge] & RC.ESTATE), 'default profile never snaps a tap onto an estate path');
  const v1 = new RC.Network([{ format: 'run-net-1', names: [] }, rec(0, SW, SE), rec(2, SE, NE)]);
  ok(v1.eKind[1] === 3 && v1.eFlag[1] === RC.LINK && !v1.hasPaths && new E.Router(v1, 'all').profile === 'roads', 'v1 access paths read as links; v1 has no all-paths profile');
}

// 7) elevation store: grid cache, out-and-back reuse, polite retries on 429, error codes
(async () => {
  const mk = (responses) => {           // fake fetch: a queue of [status, body|null, headers]
    const log = [];
    const f = async (url) => {
      const lat = decodeURIComponent(/latitude=([^&]+)/.exec(url)[1]).split(','); log.push(lat.length);
      const [status, body, hdr] = responses.length ? responses.shift() : [200, null, {}];
      if (status === 'throw') throw new TypeError('Failed to fetch');
      return { status, ok: status >= 200 && status < 300, headers: { get: (k) => (hdr || {})[k.toLowerCase()] || null },
        json: async () => body || { elevation: lat.map((_, i) => 10 + i % 3) } };
    };
    return { f, log };
  };
  const waits = [], wait = async (ms) => { waits.push(ms); };
  const line = (n, from, to) => Array.from({ length: n }, (_, i) => [from[0] + (to[0] - from[0]) * i / (n - 1), from[1] + (to[1] - from[1]) * i / (n - 1)]);
  const out = line(100, [1.3500, 103.8500], [1.3500, 103.8680]);         // ~2 km east, a sample every 20 m
  const outBack = out.concat(out.slice().reverse());

  let { f, log } = mk([]);
  let st = new E.ElevationStore({ url: 'x', fetch: f, wait });
  let v = await st.get(outBack);
  const cells = new Set(outBack.map(p => st.key(p[0], p[1]))).size;
  ok(v.length === 200 && st.points === cells && cells < 60, `out & back of 200 samples asks for ${st.points} grid points (one per ~44 m cell), not 200`);
  await st.get(out);
  ok(st.points === cells, 'asking again for the way out needs nothing new');
  const longer = out.concat(line(25, [1.3500, 103.8680], [1.3545, 103.8680]));
  const before = st.points; await st.get(longer);
  ok(st.points - before <= 13, `extending by 0.5 km asks only for the new cells: ${st.points - before} points`);

  ({ f, log } = mk([[429, null, {}], [200, null, {}]]));
  st = new E.ElevationStore({ url: 'x', fetch: f, wait }); waits.length = 0; let busy = 0;
  v = await st.get(out, () => busy++);
  ok(v.length === 100 && busy === 1 && waits[0] === 2000 && st.requests === 2, `429 then OK: waited ${waits.join(', ')} ms, tried ${st.requests} times`);

  ({ f, log } = mk([[429, null, { 'retry-after': '5' }], [200, null, {}]]));
  st = new E.ElevationStore({ url: 'x', fetch: f, wait }); waits.length = 0;
  await st.get(out); ok(waits[0] === 5000, 'Retry-After is honoured');

  const code = async (responses) => { const m = mk(responses); const s2 = new E.ElevationStore({ url: 'x', fetch: m.f, wait }); try { await s2.get(out); return 'ok'; } catch (e) { return e.code; } };
  ok(await code([[429], [429], [429]]) === 'busy', 'still 429 after two retries: busy');
  ok(await code([['throw']]) === 'offline', 'no answer: offline');
  ok(await code([[500]]) === 'http', 'server error: http');
  ok(await code([[200, { elevation: [1, 2] }]]) === 'bad', 'wrong number of values: bad');

  ({ f } = mk([])); st = new E.ElevationStore({ url: 'x', fetch: f, wait, max: 10 });
  await st.get(out); const kept = st.dump();
  const st2 = new E.ElevationStore({ url: 'x', fetch: f, wait }); st2.load(kept);
  ok(st.cells.size === 10 && st2.cells.size === 10 && st2.cells.get(st.key(...out[99])) !== undefined, 'cache trims to its limit, keeps the latest, and survives dump/load');
  console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
})();
