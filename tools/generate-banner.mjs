#!/usr/bin/env node
/**
 * generate-banner.mjs — builds dark.svg / light.svg hero banners for the
 * profile README, replicating the arifhaxn reference layout & animations
 * (window chrome, glowing accent border, framed dithered portrait, animated
 * SYSTEM.INFO data block, particle morph loop).
 *
 * Usage:
 *   node tools/generate-banner.mjs            # writes both themes
 *   node tools/generate-banner.mjs --theme=dark
 *
 * The left panel "VISUAL.MAP" renders an animated 1-bit dithered portrait
 * read from assets/visual-map.json (rebuild via `npm run gen:portrait -- <photo>`).
 * The right side is an animated SYSTEM.INFO table whose rows fade and slide in.
 *
 * All palette values are driven by the THEMES table below.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const themeArg = process.argv.find(a => a.startsWith('--theme='));
const themes = themeArg ? [themeArg.split('=')[1]] : ['dark', 'light'];

/* ---------- deterministic PRNG for reproducible runs / particle paths ---------- */
function mulberry32(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ---------- theme palettes (reference-parity) ---------- */
const THEMES = {
  dark: {
    name: 'dark',
    bitmap: 'dark',
    winBg: '#070B16',
    panelGrad: ['#0A101F', '#0C1426'],
    titleBarBg: '#0B1222',
    hairline: 'rgba(255,255,255,0.10)',
    titleText: '#94A3B8',
    mapLabel: '#475569',
    frameGlow: '#22D3EE',
    frameBg: '#0A101F',
    frameBorder: 'rgba(34,211,238,0.35)',
    bracketColor: '#22D3EE',
    portraitFill: '#A78BFA',
    accentStops: ['#7C3AED', '#22D3EE', '#10B981'],
    accentDur: '10s',
    infoHdr: '#22D3EE',
    liveColor: '#F87171',
    pillBg: '#4C1D95',
    pillText: '#E9D5FF',
    labelColor: '#22D3EE',
    leaderColor: 'rgba(148,163,184,0.35)',
    valColor: '#F8FAFC',
    divColor: '#94A3B8',
    footerText: '#94A3B8',
    cursorColor: '#22D3EE',
    seed: 20261010,
  },
  light: {
    name: 'light',
    bitmap: 'light',
    winBg: '#FFFFFF',
    panelGrad: ['#F8FAFC', '#EEF2F7'],
    titleBarBg: '#F1F5F9',
    hairline: 'rgba(15,23,42,0.10)',
    titleText: '#475569',
    mapLabel: '#94A3B8',
    frameGlow: '#06B6D4',
    frameBg: '#F8FAFC',
    frameBorder: 'rgba(8,145,178,0.40)',
    bracketColor: '#06B6D4',
    portraitFill: '#7C3AED',
    accentStops: ['#2563EB', '#06B6D4', '#10B981'],
    accentDur: '10s',
    infoHdr: '#0891B2',
    liveColor: '#DC2626',
    pillBg: '#DBEAFE',
    pillText: '#1D4ED8',
    labelColor: '#0891B2',
    leaderColor: 'rgba(15,23,42,0.25)',
    valColor: '#0F172A',
    divColor: '#475569',
    footerText: '#475569',
    cursorColor: '#06B6D4',
    seed: 20261010,
  },
};

/* ---------- visual map constants ---------- */
const MAP = JSON.parse(readFileSync(join(root, 'assets', 'visual-map.json'), 'utf8'));
// Portrait field sits inside the frame (x=36, y=84, w=400, h=492), inset ~14px on sides and ~2px bottom:
const P_FIELD = { x: 50, y: 86, w: 372, h: 490 };
const P_SCALE_X = +(P_FIELD.w / MAP.w).toFixed(4);
const P_SCALE_Y = +(P_FIELD.h / MAP.h).toFixed(4);
const INTRO_END = 3.2;
const P_LOOP = 13.9;
const P_KT = '0.000;0.194;0.288;0.432;0.525;0.669;0.763;0.906;1.000';
const INTRO_GROUPS = 60;
const TILE_W = 29, TILE_H = 34; // ≈ 99 tiles on 286x377 grid
const N_PARTICLES = 900;
const PARTICLE_BANDS = 30;

function expandRuns(rows) {
  const runs = [];
  rows.forEach((r, y) => {
    for (let i = 0; i < r.length; i += 2) runs.push({ x: r[i], y, n: r[i + 1] });
  });
  return runs;
}

function runsPath(runs) {
  runs.sort((a, b) => a.y - b.y || a.x - b.x);
  let d = '', px = 0, py = 0;
  runs.forEach((r, i) => {
    d += i ? `m${r.x - px} ${r.y - py}h${r.n}` : `M${r.x} ${r.y}h${r.n}`;
    px = r.x + r.n; py = r.y;
  });
  return d;
}

const fmt = v => +v.toFixed(1);

function bandOrder(pts) {
  const sorted = [...pts].sort((a, b) => a.y - b.y);
  const per = Math.ceil(sorted.length / PARTICLE_BANDS);
  const out = [];
  for (let i = 0; i < sorted.length; i += per) {
    out.push(...sorted.slice(i, i + per).sort((a, b) => a.x - b.x));
  }
  return out;
}

function sampleN(arr, n, rng) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a.slice(0, n);
}

function portrait(t, rng) {
  const runs = expandRuns(MAP[t.bitmap]);
  const loopAttrs = `dur="${P_LOOP}s" begin="${INTRO_END}s" repeatCount="indefinite"`;

  /* intro: runs split into <=3px chunks so the fade-in is a dotty sparkle */
  const buckets = Array.from({ length: INTRO_GROUPS }, () => []);
  for (const r of runs) {
    for (let x = r.x; x < r.x + r.n; x += 3) {
      buckets[Math.floor(rng() * INTRO_GROUPS)].push({ x, y: r.y, n: Math.min(3, r.x + r.n - x) });
    }
  }
  const intro = buckets.map((b, i) =>
    `<g opacity="0"><animate attributeName="opacity" values="0;1" dur="0.9s" begin="${(0.2 + i * 0.0333).toFixed(2)}s" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines=".4 0 .2 1"/><path d="${runsPath(b)}"/></g>`
  ).join('');

  /* loop: spatial tiles; shared fade on parent group prevents overlapping alpha seams */
  const tiles = new Map();
  for (const r of runs) {
    for (let x = r.x; x < r.x + r.n;) {
      const tx = Math.floor(x / TILE_W);
      const end = Math.min(r.x + r.n, (tx + 1) * TILE_W);
      const key = `${tx},${Math.floor(r.y / TILE_H)}`;
      if (!tiles.has(key)) tiles.set(key, []);
      tiles.get(key).push({ x, y: r.y, n: end - x });
      x = end;
    }
  }
  const cx = MAP.w / 2, cy = MAP.h / 2;
  const tileEls = [...tiles.entries()].map(([key, rs]) => {
    const [tx, ty] = key.split(',').map(Number);
    const tcx = (tx + 0.5) * TILE_W, tcy = (ty + 0.5) * TILE_H;
    const dx = fmt((cx - tcx) * 0.45 + (rng() - 0.5) * 1.5);
    const dy = fmt((cy - tcy) * 0.45 + (rng() - 0.5) * 1.5);
    const d = `${dx} ${dy}`;
    return `<g><animateTransform attributeName="transform" type="translate" values="0 0;0 0;${[d, d, d, d, d, d].join(';')};0 0" keyTimes="${P_KT}" ${loopAttrs}/>` +
      `<path d="${runsPath(rs)}"/></g>`;
  }).join('');

  /* particles: portrait pixel -> logo 1 -> logo 2 -> logo 3 -> portrait */
  const lit = runs.flatMap(r => Array.from({ length: r.n }, (_, i) => ({ x: r.x + i + 0.5, y: r.y + 0.5 })));
  const states = [bandOrder(sampleN(lit, N_PARTICLES, rng))];
  for (const logo of MAP.logos) {
    const px = expandRuns(logo).flatMap(r => Array.from({ length: r.n }, (_, i) => ({ x: r.x + i, y: r.y })));
    states.push(bandOrder(sampleN(px, N_PARTICLES, rng).map(p => ({ x: p.x + rng(), y: p.y + rng() }))));
  }
  const uses = [];
  for (let i = 0; i < N_PARTICLES; i++) {
    const at = s => `${fmt(states[s][i].x - 1.2)} ${fmt(states[s][i].y - 0.85)}`;
    const [p0, s1, s2, s3] = [at(0), at(1), at(2), at(3)];
    uses.push(`<use href="#tvparticle" opacity="0"><animate attributeName="opacity" values="0;0;1;1;1;1;1;1;0" keyTimes="${P_KT}" ${loopAttrs}/><animateTransform attributeName="transform" type="translate" values="${[p0, p0, s1, s1, s2, s2, s3, s3, p0].join(';')}" keyTimes="${P_KT}" ${loopAttrs}/></use>`);
  }

  return `<g clip-path="url(#frameClip)">
    <g transform="translate(${P_FIELD.x},${P_FIELD.y}) scale(${P_SCALE_X},${P_SCALE_Y})" fill="none" stroke="${t.portraitFill}" stroke-width="1" shape-rendering="crispEdges">
      <g transform="translate(0 .5)">
        <g><set attributeName="opacity" to="0" begin="${INTRO_END}s"/>${intro}</g>
        <g opacity="0"><animate attributeName="opacity" values="1;1;0;0;0;0;0;0;1" keyTimes="${P_KT}" ${loopAttrs}/>${tileEls}</g>
      </g>
      <g fill="${t.portraitFill}" stroke="none">${uses.join('')}</g>
    </g>
  </g>`;
}

/* ---------- SYSTEM.INFO data rows ---------- */
const INFO_ROWS = [
  { label: 'Subject', val: 'Dang Duy Linh', y: 162, t: 0.90 },
  { label: 'Role', val: 'Full-Stack Developer', y: 185, t: 1.02 },
  { label: 'Origin', val: 'Ho Chi Minh City, Vietnam', y: 208, t: 1.14 },
  { label: 'Status', val: 'Open to work + Shipping quietly', y: 231, t: 1.26 },
  { label: 'ToolChain', val: 'Docker, Git, GitHub Actions, Figma', y: 254, t: 1.38 },

  { label: 'Core.Lang', val: 'TypeScript, JavaScript, Java, C#, Dart, Python', y: 285, t: 1.60 },
  { label: 'Core.Frontend', val: 'React, Next.js, Tailwind, Sass', y: 308, t: 1.72 },
  { label: 'Core.Backend', val: 'Node, NestJS, .NET, Spring, GraphQL', y: 331, t: 1.84 },
  { label: 'Core.Database', val: 'PostgreSQL, MongoDB, Redis, Firebase', y: 354, t: 1.96 },
  { label: 'Core.Infra', val: 'Docker, Git, GitHub Actions', y: 377, t: 2.08 },

  { divider: true, y: 408, t: 2.30 },

  { label: 'Grid.LinkedIn', val: 'in/duylinh15723', y: 431, t: 2.42 },
  { label: 'Grid.Telegram', val: '@linhdangdev15723', y: 454, t: 2.54 },
  { label: 'Grid.Portfolio', val: 'g.dev/linhdangdev', y: 477, t: 2.66 },
  { label: 'Grid.Mail', val: 'duylinh05030723@gmail.com', y: 500, t: 2.78 },
  { label: 'Grid.GitHub', val: '@LinhDangDev', y: 523, t: 2.90 },
];

function systemInfo(t) {
  const TOTAL_SLOTS = 79;
  const out = [];

  // Header line
  out.push(`  <text x="470" y="106" font-size="13" letter-spacing="2" fill="${t.infoHdr}" filter="url(#txtGlow)">SYSTEM.INFO</text>`);
  out.push(`  <line x1="566" y1="102" x2="1061" y2="102" stroke="${t.hairline}"/>`);
  out.push(`  <text x="1125" y="106" text-anchor="end" font-size="12" fill="${t.liveColor}" font-weight="700"><tspan>&#9679;</tspan> LIVE<animate attributeName="opacity" values="1;0.25;1" dur="1.6s" repeatCount="indefinite"/></text>`);

  // Email pill
  const pillW = 245;
  out.push(`  <g opacity="0"><animate attributeName="opacity" from="0" to="1" dur="0.5s" begin="0.6s" fill="freeze"/>
    <rect x="470" y="122" width="${pillW}" height="20" rx="4" fill="${t.pillBg}"/>
    <text x="479" y="136" font-size="14" font-weight="700" fill="${t.pillText}">duylinh05030723@gmail.com</text>
    <line x1="${470 + pillW + 10}" y1="130" x2="1125" y2="130" stroke="${t.hairline}"/>
  </g>`);

  // Rows
  for (const r of INFO_ROWS) {
    const begin = `${r.t.toFixed(2)}s`;
    if (r.divider) {
      const dashes = '-'.repeat(69);
      out.push(`  <g opacity="0"><animate attributeName="opacity" from="0" to="1" dur="0.4s" begin="${begin}" fill="freeze"/><text x="470" y="${r.y}" font-size="14" textLength="655" lengthAdjust="spacingAndGlyphs" xml:space="preserve"><tspan fill="${t.divColor}">- Contact </tspan><tspan fill="${t.leaderColor}">${dashes}</tspan></text></g>`);
      continue;
    }
    const needed = Math.max(3, TOTAL_SLOTS - (r.label.length + 1) - (r.val.length + 1));
    const dots = '.'.repeat(needed);
    out.push(`  <g opacity="0"><animate attributeName="opacity" from="0" to="1" dur="0.4s" begin="${begin}" fill="freeze"/><animateTransform attributeName="transform" type="translate" values="-8 0;0 0" dur="0.4s" begin="${begin}" fill="freeze"/><text x="470" y="${r.y}" font-size="14" textLength="655" lengthAdjust="spacingAndGlyphs" xml:space="preserve"><tspan fill="${t.labelColor}">${r.label} </tspan><tspan fill="${t.leaderColor}">${dots}</tspan><tspan fill="${t.valColor}" font-weight="600"> ${r.val}</tspan></text></g>`);
  }

  // Footer
  out.push(`  <g opacity="0"><animate attributeName="opacity" from="0" to="1" dur="0.5s" begin="3.15s" fill="freeze"/>
    <text x="470" y="577" font-size="14" fill="${t.footerText}">&#9656; More about me &amp; projects below in README &#8595; <tspan fill="${t.cursorColor}">&#9608;<animate attributeName="fill-opacity" values="1;0;1" dur="1s" repeatCount="indefinite"/></tspan></text>
  </g>`);

  return out.join('\n');
}

/* ---------- full SVG builder ---------- */
function build(themeName) {
  const t = THEMES[themeName];
  const rng = mulberry32(t.seed);
  const a = t.accentStops;

  return `<svg xmlns="http://www.w3.org/2000/svg" width="1180" height="610" viewBox="0 0 1180 610"
     font-family="ui-monospace,SFMono-Regular,Menlo,Consolas,'Liberation Mono',monospace"
     role="img" aria-label="Dang Duy Linh · profile.sh --live">
<title>Dang Duy Linh · profile.sh --live</title>
<defs>
  <linearGradient id="accent" x1="0" y1="0" x2="1" y2="0">
    <stop offset="0" stop-color="${a[0]}"><animate attributeName="stop-color" values="${a[0]};${a[1]};${a[2]};${a[0]}" dur="${t.accentDur}" repeatCount="indefinite"/></stop>
    <stop offset="0.5" stop-color="${a[1]}"><animate attributeName="stop-color" values="${a[1]};${a[2]};${a[0]};${a[1]}" dur="${t.accentDur}" repeatCount="indefinite"/></stop>
    <stop offset="1" stop-color="${a[2]}"><animate attributeName="stop-color" values="${a[2]};${a[0]};${a[1]};${a[2]}" dur="${t.accentDur}" repeatCount="indefinite"/></stop>
  </linearGradient>
  <linearGradient id="panelGrad" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="${t.panelGrad[0]}"/>
    <stop offset="1" stop-color="${t.panelGrad[1]}"/>
  </linearGradient>
  <filter id="glow8" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="8"/></filter>
  <filter id="glow3" x="-60%" y="-60%" width="220%" height="220%"><feGaussianBlur stdDeviation="3"/></filter>
  <filter id="txtGlow" x="-30%" y="-30%" width="160%" height="160%"><feGaussianBlur stdDeviation="0.9" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
  <clipPath id="winClip"><rect x="2" y="2" width="1176" height="606" rx="18"/></clipPath>
  <clipPath id="frameClip"><rect x="36" y="84" width="400" height="492" rx="10"/></clipPath>
  <rect id="tvparticle" width="2.4" height="1.7"/>
</defs>

<!-- outer window -->
<rect x="2" y="2" width="1176" height="606" rx="18" fill="${t.winBg}"/>
<g clip-path="url(#winClip)">
  <rect x="2" y="2" width="1176" height="606" fill="url(#panelGrad)"/>

  <!-- title bar -->
  <rect x="2" y="2" width="1176" height="46" fill="${t.titleBarBg}"/>
  <line x1="2" y1="48" x2="1178" y2="48" stroke="${t.hairline}"/>
  <circle cx="30" cy="25" r="5.5" fill="#ff5f56"/>
  <circle cx="50" cy="25" r="5.5" fill="#ffbd2e"/>
  <circle cx="70" cy="25" r="5.5" fill="#27c93f"/>
  <text x="590" y="29" text-anchor="middle" font-size="12" fill="${t.titleText}">duylinh05030723@gmail.com - % ./profile.sh --live</text>

  <!-- VISUAL.MAP label + frame -->
  <text x="38" y="74" font-size="10" letter-spacing="3" fill="${t.mapLabel}">VISUAL.MAP</text>
  <rect x="36" y="84" width="400" height="492" rx="10" fill="none" stroke="${t.frameGlow}" stroke-width="2" opacity="0.45" filter="url(#glow3)"/>
  <rect x="36" y="84" width="400" height="492" rx="10" fill="${t.frameBg}" stroke="${t.frameBorder}"/>

  <!-- dithered portrait + morph loop -->
  ${portrait(t, rng)}

  <!-- corner bracket accents -->
  <path d="M 50 84 L 36 84 L 36 98" fill="none" stroke="${t.bracketColor}" stroke-width="2" opacity="0.8"/>
  <path d="M 422 84 L 436 84 L 436 98" fill="none" stroke="${t.bracketColor}" stroke-width="2" opacity="0.8"/>
  <path d="M 50 576 L 36 576 L 36 562" fill="none" stroke="${t.bracketColor}" stroke-width="2" opacity="0.8"/>
  <path d="M 422 576 L 436 576 L 436 562" fill="none" stroke="${t.bracketColor}" stroke-width="2" opacity="0.8"/>

  <!-- SYSTEM.INFO panel -->
${systemInfo(t)}
</g>

<!-- animated gradient border -->
<rect x="3" y="3" width="1174" height="604" rx="17" fill="none" stroke="url(#accent)" stroke-width="3" opacity="0.55" filter="url(#glow8)"/>
<rect x="3" y="3" width="1174" height="604" rx="17" fill="none" stroke="url(#accent)" stroke-width="1.6"/>
</svg>
`;
}

for (const name of themes) {
  if (!THEMES[name]) { console.error(`unknown theme: ${name}`); process.exit(1); }
  writeFileSync(join(root, `${name}.svg`), build(name), 'utf8');
  console.log(`wrote ${name}.svg`);
}
