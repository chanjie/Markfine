"""Reproduce the two original, seamless paper materials. Standard library only; no runtime filter."""
import math
from pathlib import Path
import random
import struct
import zlib

ROOT = Path(__file__).resolve().parents[1]
SIZE = 1024  # 512 CSS px at 2x, so fibers have soft subpixel edges on Retina displays.


def noise_layer(rng, cells, amplitude, field):
    grid = [[rng.uniform(-1, 1) for _ in range(cells)] for _ in range(cells)]
    positions = [(x * cells / SIZE) for x in range(SIZE)]
    indices = [int(x) for x in positions]
    weights = [(x - int(x)) ** 2 * (3 - 2 * (x - int(x))) for x in positions]
    for y in range(SIZE):
        gy = y * cells / SIZE
        iy, fy = int(gy), gy - int(gy)
        fy = fy * fy * (3 - 2 * fy)
        row = [grid[iy][x] * (1 - fy) + grid[(iy + 1) % cells][x] * fy for x in range(cells)]
        base = y * SIZE
        for x in range(SIZE):
            ix, fx = indices[x], weights[x]
            field[base + x] += amplitude * (row[ix] * (1 - fx) + row[(ix + 1) % cells] * fx)


def material(kind):
    kraft = kind == 'kraft'
    rng = random.Random(61473 if kraft else 31907)
    tone = [0.0] * (SIZE * SIZE)
    relief = [0.0] * (SIZE * SIZE)
    # Pulp clouds, compressed patches and fine tooth, not a flat white-noise veil.
    for cells, strength in [(3, 3.0), (7, 6.2), (19, 4.3), (59, 2.1), (193, .85)]:
        noise_layer(rng, cells, strength * (1.35 if kraft else 1), tone)
    noise_layer(rng, 117, 1.8 if kraft else 1.3, relief)
    for _ in range(3600 if kraft else 2600):
        x0, y0 = rng.uniform(0, SIZE), rng.uniform(0, SIZE)
        length = min(160, max(6, rng.lognormvariate(3.1 if kraft else 2.9, .7)))
        angle = rng.uniform(0, math.tau)
        bend = rng.uniform(-3.5, 3.5)
        width = rng.uniform(.7, 2.3) * (1.2 if kraft else 1)
        strength = rng.uniform(.4, 1.25)
        pigment = rng.uniform(-13, 5.5) * (1.3 if kraft else 1)
        dx, dy = math.cos(angle), math.sin(angle)
        for step in range(math.ceil(length * 1.5)):
            t = step / max(1, math.ceil(length * 1.5) - 1)
            taper = math.sin(math.pi * t) ** .45
            curve = math.sin(math.pi * t) * bend
            x, y = x0 + dx * length * t - dy * curve, y0 + dy * length * t + dx * curve
            radius = math.ceil(width * 1.6)
            for py in range(math.floor(y) - radius, math.floor(y) + radius + 1):
                for px in range(math.floor(x) - radius, math.floor(x) + radius + 1):
                    distance = ((px - x) ** 2 + (py - y) ** 2) / width ** 2
                    if distance > 3: continue
                    amount = math.exp(-distance * 1.7) * taper * strength
                    at = (py % SIZE) * SIZE + px % SIZE
                    # Unevenly embedded fibers catch a little light on one edge, not ink-like dashes.
                    relief[at] += amount * 1.4
                    tone[at] += amount * pigment * .66
    base = (224, 201, 161) if kraft else (247, 243, 231)
    raw = bytearray()
    for y in range(SIZE):
        raw.append(0)
        for x in range(SIZE):
            at = y * SIZE + x
            slope = relief[at] - relief[((y - 1) % SIZE) * SIZE + (x - 1) % SIZE]
            value = tone[at] + slope * (6.2 if kraft else 4.8) + rng.gauss(0, 1.8 if kraft else 1.3)
            # Compress overlapping kraft fibers so their shadows cannot become ink-like marks.
            # Keep the existing text color legible even on the darkest part of the material.
            if kraft: value = 26 * math.tanh(value / 26)
            # Slight chromatic variation is part of the material, not an extra theme-colored overlay.
            raw.extend(max(0, min(255, round(channel + value * factor))) for channel, factor in zip(base, (1, 1.02, 1.06)))

    def chunk(name, data):
        return struct.pack('>I', len(data)) + name + data + struct.pack('>I', zlib.crc32(name + data) & 0xffffffff)
    png = b'\x89PNG\r\n\x1a\n' + chunk(b'IHDR', struct.pack('>IIBBBBB', SIZE, SIZE, 8, 2, 0, 0, 0)) + chunk(b'IDAT', zlib.compress(raw, 9)) + chunk(b'IEND', b'')
    target = ROOT / 'Web/textures' / (kind + '-texture.png')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(png)
    print(str(target.relative_to(ROOT)), len(png), 'bytes')


if __name__ == '__main__':
    for kind in ['paper', 'kraft']:
        material(kind)
