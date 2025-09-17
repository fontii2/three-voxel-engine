import { NextRequest } from 'next/server';
import { unstable_cache as cache } from 'next/cache';
import { Block } from '@/lib/three/block_types';
import { makeNoise } from '@/lib/three/perlin';

export const runtime = 'nodejs';

// Strong cache: immutable with long TTL; pairs well with deterministic content hashing
const ONE_YEAR = 31536000;
const CACHE_CONTROL = `public, max-age=${ONE_YEAR}, s-maxage=${ONE_YEAR}, immutable`;

type Params = {
  size: number;
  seed: string;
  base: number; // Block id
  cx: number;
  cy: number;
  cz: number;
  // terrain knobs
  surfaceScale: number;
  cavesScale: number;
  cavesThreshold: number;
  grassDepth: number;
  dirtDepth: number;
};

function parseParams(req: NextRequest): Params {
  const sp = req.nextUrl.searchParams;
  const size = Math.max(4, Math.min(128, Number(sp.get('size') ?? 64) | 0));
  const seed = (sp.get('seed') ?? 'seed').toString();
  const base = Number(sp.get('base') ?? Block.Stone) | 0;
  const cx = Number(sp.get('cx') ?? 0) | 0;
  const cy = Number(sp.get('cy') ?? 0) | 0;
  const cz = Number(sp.get('cz') ?? 0) | 0;

  const surfaceScale = Number(sp.get('surfaceScale') ?? 0.04);
  const cavesScale = Number(sp.get('cavesScale') ?? 0.16);
  const cavesThreshold = Number(sp.get('cavesThreshold') ?? 0.72);
  const grassDepth = Number(sp.get('grassDepth') ?? 2);
  const dirtDepth = Number(sp.get('dirtDepth') ?? 3);

  return { size, seed, base, cx, cy, cz, surfaceScale, cavesScale, cavesThreshold, grassDepth, dirtDepth };
}

// Simple deterministic string hash -> 32-bit unsigned int
function hash32(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

// Mix multiple integers into a single 32-bit hash deterministically
function mix(...nums: number[]) {
  let h = 0x811c9dc5 >>> 0;
  for (const n of nums) {
    let x = n >>> 0;
    x ^= x >>> 16; x = Math.imul(x, 0x7feb352d);
    x ^= x >>> 15; x = Math.imul(x, 0x846ca68b);
    x ^= x >>> 16;
    h ^= x;
  }
  return h >>> 0;
}

// Convert 32-bit int to [0,1) float for seeding our perlin
function toUnitFloat(u32: number) {
  return (u32 & 0x7ffffff) / 0x8000000; // 27 bits of mantissa
}

// Core generator: mirrors client logic but with deterministic seeding and world offsets
function generateChunkServer(params: Params): Uint8Array {
  const { size: S, seed, base, cx, cy, cz, surfaceScale, cavesScale, cavesThreshold, grassDepth, dirtDepth } = params;

  // World-space offset per chunk so neighboring chunks differ
  const ox = cx * S;
  const oy = cy * S;
  const oz = cz * S;

  // Seed noise deterministically with seed + coords
  const baseHash = hash32(seed);
  const noiseSeed1 = toUnitFloat(mix(baseHash, ox, oy, oz, 0xA1));
  const noiseSeed2 = toUnitFloat(mix(baseHash ^ 0x9e3779b9, ox, oy, oz, 0xB2));
  
  const surfaceNoise = makeNoise(noiseSeed1);
  const cavesNoise = makeNoise(noiseSeed2);

  // Allocate grid and fill base block
  const total = S * S * S;
  const grid = new Uint8Array(total);
  grid.fill(base);

  const IDX = (x: number, y: number, z: number) => x + y * S + z * S * S;

  // Surface heightmap: carve air above height
  for (let x = 0; x < S; x++) {
    for (let z = 0; z < S; z++) {
      const h = surfaceNoise((x + ox) * surfaceScale, (z + oz) * surfaceScale);
      const maxY = Math.floor(h * S);
      for (let y = S - 1; y > maxY; y--) {
        grid[IDX(x, y, z)] = Block.Air;
      }
    }
  }

  // 3D caves: carve air where noise exceeds threshold
  for (let x = 0; x < S; x++) {
    for (let y = 0; y < S; y++) {
      for (let z = 0; z < S; z++) {
        const n = cavesNoise((x + ox) * cavesScale, (y + oy) * cavesScale, (z + oz) * cavesScale);
        if (n > cavesThreshold) grid[IDX(x, y, z)] = Block.Air;
      }
    }
  }

  // Paint layers to mirror client behavior:
  // 1) Grass: replace contiguous top blocks only if they match `base` (stone).
  // 2) Dirt: replace top N solids only if they match `base` (stone), skipping grass.
  const replaceTopContiguous = (from: number, to: number, depth: number) => {
    for (let x = 0; x < S; x++) {
      for (let z = 0; z < S; z++) {
        let y = S - 1;
        while (y >= 0 && grid[IDX(x, y, z)] === Block.Air) y--;
        let replaced = 0;
        while (y >= 0 && replaced < depth) {
          const i = IDX(x, y, z);
          const b = grid[i];
          if (b === Block.Air) break;
          if (b !== from) break;
          grid[i] = to & 0xff;
          replaced++; y--;
        }
      }
    }
  };
  const replaceTopAny = (from: number | null, to: number, depth: number) => {
    for (let x = 0; x < S; x++) {
      for (let z = 0; z < S; z++) {
        let y = S - 1;
        while (y >= 0 && grid[IDX(x, y, z)] === Block.Air) y--;
        let replaced = 0;
        while (y >= 0 && replaced < depth) {
          const i = IDX(x, y, z);
          const b = grid[i];
          if (b !== Block.Air && (from == null || b === from)) {
            grid[i] = to & 0xff;
            replaced++;
          }
          y--;
        }
      }
    }
  };
  if (grassDepth > 0) replaceTopContiguous(base, Block.Grass, grassDepth | 0);
  if (dirtDepth > 0) replaceTopAny(base, Block.Dirt, dirtDepth | 0);

  return grid;
}

// Cache generator results by parameter signature
const getChunkCached = cache(
  async (params: Params) => {
    const grid = generateChunkServer(params);
    return grid; // Uint8Array result
  },
  ['chunk-gen'],
  { revalidate: ONE_YEAR, tags: ['chunk-gen'] }
);

function keyOf(p: Params) {
  return `${p.size}|${p.seed}|${p.base}|${p.cx}|${p.cy}|${p.cz}|${p.surfaceScale}|${p.cavesScale}|${p.cavesThreshold}|${p.grassDepth}|${p.dirtDepth}`;
}

export async function GET(req: NextRequest) {
  try {
    const params = parseParams(req);

    // Use a stable cache key; cache wrapper ignores params, so include in key
    const cacheKey = keyOf(params);
    const data = await getChunkCached(params);

    // Compute a weak ETag from key (deterministic)
    const etag = `W/"${hash32(cacheKey).toString(16)}-${params.size}"`;

    // Conditional request support
    const ifNoneMatch = req.headers.get('if-none-match');
    if (ifNoneMatch && ifNoneMatch === etag) {
      return new Response(null, { status: 304, headers: { 'Cache-Control': CACHE_CONTROL, ETag: etag } });
    }

    // Return compact binary body (Uint8Array)
    return new Response(data, {
      status: 200,
      headers: {
        'Content-Type': 'application/octet-stream',
        'Cache-Control': CACHE_CONTROL,
        'ETag': etag,
        'X-Chunk-Size': String(params.size),
      },
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message ?? 'error' }), { status: 500, headers: { 'Content-Type': 'application/json' } });
  }
}
