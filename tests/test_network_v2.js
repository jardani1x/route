// Checks a built footpath network (run-net-2) on real routes between public places.
// Usage: node tests/test_network_v2.js path/to/net-v2.json   (skips, exit 0, if the file is missing)
const fs = require('fs');
const RC = require('../core.js');
const E = require('../engine.js');
const file = process.argv[2];
if (!file || !fs.existsSync(file)) { console.log('SKIP  no footpath network file given'); process.exit(0); }
let fails = 0;
const ok = (cond, msg) => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${msg}`); if (!cond) fails++; };

let t = Date.now(); const net = RC.Network.fromText(fs.readFileSync(file, 'utf8')); const loadMs = Date.now() - t;
ok(net.hasPaths && loadMs < 4000, `loads: ${net.E} edges in ${loadMs} ms`);
const v1 = RC.Network.fromText(fs.readFileSync(__dirname + '/../net.json', 'utf8'));
const def = new E.Router(net, 'roads'), all = new E.Router(net, 'all'), old = new E.Router(v1);
const estateM = (coords) => {  // metres of a path that run on estate-only edges (not links)
  let m = 0;
  for (const p of E.geo.resample(coords, 10)) {
    const s = net.snap(p[0], p[1], 2);
    if (s && (net.eFlag[s.edge] & RC.ESTATE) && !(net.eFlag[s.edge] & RC.LINK) && !net.snap(p[0], p[1], 2, (e) => net.allowed(e, 'roads'))) m += 10;
  }
  return m;
};
const PLACES = [  // [name, from, to]: public places only
  ['Ang Mo Kio MRT to Bishan Road bridge', [1.36993, 103.84955], [1.35707, 103.85017]],
  ['Bishan Road bridge to Kallang PCN at Braddell', [1.35707, 103.85017], [1.33667, 103.86402]],
  ['Raffles Place to Marina Barrage', [1.2840, 103.8514], [1.2807, 103.8710]],
  ['Tampines MRT to Pasir Ris MRT', [1.3536, 103.9451], [1.3730, 103.9493]],
  ['Toa Payoh MRT to Toa Payoh Town Park', [1.3327, 103.8474], [1.3365, 103.8530]],
  ['Jurong East MRT to Clementi MRT', [1.3331, 103.7422], [1.3150, 103.7650]],
  ['Punggol MRT to Punggol Waterway', [1.4052, 103.9024], [1.4100, 103.9080]],
];
for (const [name, a, b] of PLACES) {
  const pd = def.path(a, b), pa = all.path(a, b), po = old.path(a, b);
  const Ld = pd && E.geo.length(pd), La = pa && E.geo.length(pa), Lo = po && E.geo.length(po), em = pd ? estateM(pd) : 0;
  ok(pd && pa && em === 0 && La <= Ld * 1.05 + 30 && (!Lo || Ld <= Lo * 1.3 + 200),
    `${name}: default ${(Ld / 1000).toFixed(2)} km (estate ${em} m), every footpath ${(La / 1000).toFixed(2)} km, v1 ${Lo ? (Lo / 1000).toFixed(2) : '-'} km`);
}
// trace matching on the default profile: a noisy trace of a known route comes back the same length
const ref = E.geo.join(def.path(PLACES[0][1], PLACES[0][2]), def.path(PLACES[1][1], PLACES[1][2]));
let seed = 11; const rnd = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const gauss = () => Math.sqrt(-2 * Math.log(rnd() + 1e-12)) * Math.cos(2 * Math.PI * rnd());
const trace = E.geo.resample(ref, 25).map(([la, lo]) => [la + gauss() * 8 / 110574, lo + gauss() * 8 / 111300]);
t = Date.now(); const m = def.matchTrace(trace, 35); const ms = Date.now() - t;
let dev = 0; for (const p of m) dev = Math.max(dev, E.geo.locate(ref, p).dist);
ok(Math.abs(E.geo.length(m) - E.geo.length(ref)) / E.geo.length(ref) < 0.03 && dev < 35,
  `trace match: ${(E.geo.length(m) / 1000).toFixed(3)} km vs ${(E.geo.length(ref) / 1000).toFixed(3)} km, max dev ${dev.toFixed(0)} m, ${ms} ms`);
console.log(fails ? `\n${fails} FAILED` : '\nALL PASSED'); process.exit(fails ? 1 : 0);
