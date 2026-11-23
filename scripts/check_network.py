"""Fail if a built network misses part of Singapore. Usage: python scripts/check_network.py data/net-v2.json
Each checkpoint (a town centre spread across the island) must have the start of some edge within 300 m."""
import json, math, sys

CHECKPOINTS = {'Jurong East': (1.3331, 103.7422), 'Woodlands': (1.4360, 103.7865), 'Yishun': (1.4294, 103.8350),
               'Ang Mo Kio': (1.3700, 103.8495), 'Tampines': (1.3536, 103.9451), 'Pasir Ris': (1.3730, 103.9493),
               'Bedok': (1.3240, 103.9300), 'Queenstown': (1.2942, 103.8060), 'Raffles Place': (1.2840, 103.8514),
               'Bukit Panjang': (1.3784, 103.7620), 'Punggol': (1.4052, 103.9024), 'Sentosa': (1.2494, 103.8303)}

rows = json.load(open(sys.argv[1]))
starts = [(r[2] / 1e6, r[3] / 1e6) for r in rows[1:]]
bad = []
for name, (la, lo) in CHECKPOINTS.items():
    kx = 111319.49 * math.cos(math.radians(la))
    d = min(math.hypot((s[0] - la) * 110574, (s[1] - lo) * kx) for s in starts)
    print(f'{name:14s} nearest edge {d:6.0f} m')
    if d > 300:
        bad.append(name)
lats = [s[0] for s in starts]; lons = [s[1] for s in starts]
print(f'bbox lat {min(lats):.3f}..{max(lats):.3f} lon {min(lons):.3f}..{max(lons):.3f}')
if bad or max(lats) > 1.475:
    print('::error::network misses ' + ', '.join(bad) if bad else '::error::network reaches north of the Strait of Johor')
    sys.exit(1)
print('coverage OK')
