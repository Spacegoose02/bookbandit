/**
 * Picture scenes for the kid themes: a wide, simple SVG drawn as a banner on the kid home and
 * sticker book. Purely decorative (always `aria-hidden`), flat shapes only, so they stay small
 * and look the same on every device. Each one is 800×140 and is drawn with `background-size: cover`.
 */

const W = 800;
const H = 140;
/** Extra sky and ground on each side, so wide screens crop the top and bottom less. */
const PAD = 200;
/** Stretch a full-width ground or sand shape across the padded width. */
const wide = (shape: string) => `<g transform="translate(${W / 2} 0) scale(${(W + 2 * PAD) / W} 1) translate(${-W / 2} 0)">${shape}</g>`;

const svg = (body: string, defs = "") =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="${-PAD} 0 ${W + 2 * PAD} ${H}" preserveAspectRatio="xMidYMid slice">${defs ? `<defs>${defs}</defs>` : ""}${body}</svg>`;

const sky = (id: string, top: string, bottom: string) =>
  `<linearGradient id="${id}" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>`;

/** A few pseudo-random points so the scenes look hand-placed but are the same every time. */
function scatter(n: number, seed: number, maxY = H): [number, number][] {
  const out: [number, number][] = [];
  let s = seed;
  const next = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
  for (let i = 0; i < n; i++) out.push([Math.round(next() * (W + 2 * PAD) - PAD), Math.round(next() * maxY)]);
  return out;
}

const SPACE = svg(
  `<rect x="${-PAD}" width="${W + 2 * PAD}" height="${H}" fill="url(#k)"/>` +
    scatter(64, 7)
      .map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${i % 5 === 0 ? 2.2 : 1.2}" fill="#fff" fill-opacity="${i % 3 ? 0.7 : 1}"/>`)
      .join("") +
    // ringed planet
    `<circle cx="150" cy="72" r="32" fill="#ffb347"/><circle cx="140" cy="62" r="8" fill="#ffd38a"/><ellipse cx="150" cy="74" rx="56" ry="11" fill="none" stroke="#ff7eb6" stroke-width="5" transform="rotate(-14 150 74)"/>` +
    // moon
    `<circle cx="430" cy="38" r="18" fill="#e9e6ff"/><circle cx="424" cy="34" r="4" fill="#c9c4f2"/><circle cx="436" cy="44" r="3" fill="#c9c4f2"/>` +
    // little green planet
    `<circle cx="560" cy="108" r="14" fill="#6ee7b7"/><circle cx="555" cy="104" r="3" fill="#34d399"/>` +
    // rocket
    `<g transform="translate(690 56) rotate(30)"><path d="M0-28C14-14 14 18 10 30H-10C-14 18-14-14 0-28Z" fill="#f8fafc"/><circle cy="0" r="7" fill="#7ee8fa" stroke="#3b82f6" stroke-width="3"/><path d="M-10 14-22 32-10 30ZM10 14 22 32 10 30Z" fill="#ef4444"/><path d="M-7 31Q0 58 7 31Z" fill="#ffcf33"/><path d="M-4 31Q0 46 4 31Z" fill="#ff7a1a"/></g>`,
  sky("k", "#0d0f2b", "#2a2f7a"),
);

const SEA = svg(
  `<rect x="${-PAD}" width="${W + 2 * PAD}" height="${H}" fill="url(#k)"/>` +
    // light rays
    `<path d="M120 0 180 0 90 140 40 140ZM420 0 470 0 400 140 350 140Z" fill="#fff" fill-opacity=".12"/>` +
    // sand
    wide(`<path d="M0 118Q200 100 400 116T800 112V140H0Z" fill="#f5dca0"/>`) +
    // seaweed
    `<path d="M60 140C50 110 74 96 62 66M80 140C90 112 70 98 84 74M690 140C680 112 704 100 692 72M712 140C722 116 702 104 716 84" stroke="#2f9e6e" stroke-width="7" fill="none" stroke-linecap="round"/>` +
    // fish
    `<g transform="translate(250 64)"><ellipse rx="26" ry="15" fill="#ff8a3d"/><path d="M22 0 42-14V14Z" fill="#ff8a3d"/><path d="M-6-14V14" stroke="#fff" stroke-width="5"/><circle cx="-14" cy="-3" r="3.5" fill="#123"/></g>` +
    `<g transform="translate(520 92) scale(-.75 .75)"><ellipse rx="26" ry="15" fill="#ffd23f"/><path d="M22 0 42-14V14Z" fill="#ffd23f"/><circle cx="-14" cy="-3" r="3.5" fill="#123"/></g>` +
    // starfish
    `<path d="M600 106l5 10 11 1-8 7 3 11-11-6-10 6 3-11-8-7 11-1z" fill="#ff6b8b"/>` +
    // bubbles
    scatter(14, 3, 100)
      .map(([x, y], i) => `<circle cx="${x}" cy="${y}" r="${3 + (i % 4) * 2}" fill="none" stroke="#fff" stroke-opacity=".7" stroke-width="2"/>`)
      .join(""),
  sky("k", "#7fdcef", "#2ba3c4"),
);

const JUNGLE = svg(
  `<rect x="${-PAD}" width="${W + 2 * PAD}" height="${H}" fill="url(#k)"/>` +
    `<circle cx="660" cy="40" r="26" fill="#ffd23f"/>` +
    wide(`<path d="M0 120Q140 92 300 116T600 108 800 116V140H0Z" fill="#5c9e31"/>`) +
    // big leaves around the edges
    [
      [30, 20, -30, 70],
      [80, 0, 20, 60],
      [10, 110, -60, 60],
      [770, 10, 200, 70],
      [730, 120, 150, 64],
      [380, 140, -95, 46],
    ]
      .map(
        ([x, y, r, s]) =>
          `<g transform="translate(${x} ${y}) rotate(${r})"><ellipse rx="${s}" ry="${s / 3}" fill="#2f7d32"/><path d="M-${s} 0H${s}" stroke="#a5d66b" stroke-width="3"/></g>`,
      )
      .join("") +
    // vine with flowers
    `<path d="M200 0C210 30 190 50 205 80" stroke="#2f7d32" stroke-width="5" fill="none"/><circle cx="205" cy="82" r="8" fill="#ff5c8a"/><circle cx="205" cy="82" r="3" fill="#ffd23f"/>` +
    `<path d="M520 0C510 26 530 44 516 66" stroke="#2f7d32" stroke-width="5" fill="none"/><circle cx="516" cy="68" r="8" fill="#ff8a3d"/><circle cx="516" cy="68" r="3" fill="#fff3b0"/>` +
    // toucan-ish bird on a branch
    `<path d="M300 70H420" stroke="#7a4a1e" stroke-width="6" stroke-linecap="round"/><g transform="translate(360 52)"><ellipse rx="14" ry="17" fill="#222"/><ellipse cx="2" cy="4" rx="7" ry="10" fill="#fff3b0"/><circle cx="4" cy="-8" r="3" fill="#fff"/><path d="M10-10Q34-8 30 0Q20-2 10-2Z" fill="#ff8a1a"/></g>`,
  sky("k", "#c9f0a0", "#8fd16a"),
);

const UNICORN = svg(
  `<rect x="${-PAD}" width="${W + 2 * PAD}" height="${H}" fill="url(#k)"/>` +
    // rainbow
    ["#ff6b8b", "#ffa94d", "#ffe066", "#69db7c", "#74c0fc", "#b197fc"]
      .map((c, i) => `<path d="M${260 + i * 12} 150A${140 - i * 12} ${120 - i * 12} 0 0 1 ${540 - i * 12} 150" fill="none" stroke="${c}" stroke-width="12"/>`)
      .join("") +
    // clouds
    [
      [250, 128],
      [550, 128],
      [90, 50],
      [700, 40],
    ]
      .map(([x, y]) => `<g fill="#fff"><circle cx="${x}" cy="${y}" r="20"/><circle cx="${x + 22}" cy="${y - 8}" r="24"/><circle cx="${x + 46}" cy="${y}" r="18"/><rect x="${x}" y="${y}" width="46" height="18"/></g>`)
      .join("") +
    // sparkles
    scatter(16, 11, 110)
      .map(([x, y], i) => {
        const s = 4 + (i % 3) * 3;
        return `<path d="M${x} ${y - s}L${x + s / 3} ${y - s / 3} ${x + s} ${y} ${x + s / 3} ${y + s / 3} ${x} ${y + s} ${x - s / 3} ${y + s / 3} ${x - s} ${y} ${x - s / 3} ${y - s / 3}Z" fill="${i % 2 ? "#fff" : "#ffd6f5"}"/>`;
      })
      .join(""),
  sky("k", "#e9d8ff", "#ffd6ec"),
);

const BUILDER = svg(
  `<rect x="${-PAD}" width="${W + 2 * PAD}" height="${H}" fill="url(#k)"/>` +
    `<circle cx="90" cy="38" r="22" fill="#fff3b0"/>` +
    `<rect x="${-PAD}" y="112" width="${W + 2 * PAD}" height="28" fill="#c8963e"/>` +
    // hazard stripe
    `<g transform="translate(${-PAD} 112)">${Array.from({ length: Math.ceil((W + 2 * PAD) / 30) + 1 }, (_, i) => `<path d="M${i * 30} 0h15l-10 10h-15z" fill="#222"/>`).join("")}</g>` +
    // crane
    `<g stroke="#3a3a3a" stroke-width="5" fill="none"><path d="M560 112V20M560 24H740M560 24 600 4V24M700 24V60"/></g><rect x="684" y="60" width="32" height="22" fill="#e8590c"/>` +
    // stacked blocks
    `<rect x="250" y="80" width="60" height="32" fill="#4dabf7"/><rect x="310" y="80" width="60" height="32" fill="#ff6b6b"/><rect x="280" y="48" width="60" height="32" fill="#ffd43b" stroke="#222" stroke-width="2"/>` +
    // cones
    `<path d="M440 112 452 80 464 112Z M470 112 482 80 494 112Z" fill="#ff7a1a"/><path d="M445 100H459M475 100H489" stroke="#fff" stroke-width="4"/>` +
    // little digger
    `<g transform="translate(130 74)"><rect x="0" y="10" width="54" height="22" rx="4" fill="#ffcf33"/><rect x="8" y="-8" width="24" height="20" rx="3" fill="#ffcf33"/><rect x="12" y="-4" width="14" height="10" fill="#bfe3ff"/><circle cx="12" cy="34" r="8" fill="#333"/><circle cx="44" cy="34" r="8" fill="#333"/><path d="M54 16 76 0 86 18" stroke="#ffcf33" stroke-width="6" fill="none"/><path d="M80 14h14l-6 14h-10z" fill="#555"/></g>`,
  sky("k", "#bde4ff", "#fff3c4"),
);

const CASTLE = svg(
  `<rect x="${-PAD}" width="${W + 2 * PAD}" height="${H}" fill="url(#k)"/>` +
    `<circle cx="700" cy="40" r="22" fill="#ffe066"/>` +
    wide(`<path d="M0 118Q160 92 340 112T800 104V140H0Z" fill="#69b34c"/>`) +
    // castle
    `<g fill="#b9b4d6">` +
    `<rect x="300" y="50" width="200" height="72"/>` +
    `<rect x="270" y="30" width="50" height="92"/><rect x="480" y="30" width="50" height="92"/>` +
    Array.from({ length: 7 }, (_, i) => `<rect x="${300 + i * 30}" y="40" width="16" height="12"/>`).join("") +
    `</g>` +
    `<path d="M262 32 295 0 328 32ZM472 32 505 0 538 32Z" fill="#5b5fc7"/>` +
    `<path d="M380 122V92A20 20 0 0 1 420 92V122Z" fill="#6b4226"/>` +
    `<rect x="286" y="54" width="16" height="22" rx="8" fill="#5b5fc7"/><rect x="498" y="54" width="16" height="22" rx="8" fill="#5b5fc7"/>` +
    // flags
    `<path d="M398 50V20" stroke="#555" stroke-width="3"/><path d="M398 20 430 28 398 36Z" fill="#e8590c"/>` +
    // stars
    scatter(10, 5, 60)
      .map(([x, y]) => `<circle cx="${x}" cy="${y}" r="1.8" fill="#fff"/>`)
      .join("") +
    // knight's shield and a crown in the grass
    `<path d="M140 92h30v16c0 12-15 18-15 18s-15-6-15-18z" fill="#c92a2a" stroke="#ffd43b" stroke-width="3"/><path d="M640 104l8-14 8 10 8-10 8 10 8-10 8 14z" fill="#ffd43b" stroke="#b8860b" stroke-width="2"/>`,
  sky("k", "#a5b4fc", "#e0e7ff"),
);

const DINOSAUR = svg(
  `<rect x="${-PAD}" width="${W + 2 * PAD}" height="${H}" fill="url(#k)"/>` +
    `<circle cx="110" cy="36" r="22" fill="#fff3b0"/>` +
    // volcano
    `<path d="M520 120 600 40H640L720 120Z" fill="#8d6e63"/><path d="M600 40Q620 56 640 40L630 52Q620 60 610 52Z" fill="#ff7a1a"/>` +
    `<g fill="#cfd8dc" fill-opacity=".9"><circle cx="620" cy="26" r="10"/><circle cx="636" cy="14" r="8"/><circle cx="650" cy="4" r="7"/></g>` +
    wide(`<path d="M0 116Q200 88 420 112T800 110V140H0Z" fill="#6aa84f"/>`) +
    // palm tree
    `<path d="M240 118C236 90 244 70 238 48" stroke="#7a4a1e" stroke-width="7" fill="none"/>` +
    `<g fill="#2f7d32"><ellipse cx="216" cy="46" rx="28" ry="8" transform="rotate(20 216 46)"/><ellipse cx="262" cy="46" rx="28" ry="8" transform="rotate(-20 262 46)"/><ellipse cx="238" cy="38" rx="8" ry="24"/></g>` +
    // friendly long-neck dino
    `<g transform="translate(360 64)" fill="#4caf50"><ellipse cx="0" cy="30" rx="44" ry="22"/><path d="M28 22C46 8 50-16 58-26L70-20C62-10 56 14 38 34Z"/><ellipse cx="66" cy="-26" rx="14" ry="9"/><rect x="-30" y="40" width="12" height="20" rx="5"/><rect x="16" y="40" width="12" height="20" rx="5"/><path d="M-40 26Q-70 30-82 20Q-66 40-38 38Z"/></g><circle cx="430" cy="36" r="2.5" fill="#123"/>`,
  sky("k", "#c8ecff", "#eef8dc"),
);

export const SCENES = { space: SPACE, sea: SEA, jungle: JUNGLE, unicorn: UNICORN, builder: BUILDER, castle: CASTLE, dinosaur: DINOSAUR };
