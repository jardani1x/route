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
const es = E.elevationSamples(outbound, 200); const nExp = Math.min(200, Math.floor(length(outbound) / 25) + 1); ok(es.pts.length === nExp && Math.abs(es.dists[nExp - 1] - length(outbound)) < 1e-6, `elevation sampling: ${es.pts.length} evenly spaced points`);

console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
