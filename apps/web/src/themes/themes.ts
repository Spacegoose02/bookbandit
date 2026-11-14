import { DEFAULT_THEME, isThemeId, THEME_IDS, type ThemeId } from "@bookbandit/shared";
import { installAppFonts } from "./fonts";
import { SCENES } from "./scenes";
import "./themes.css";

/**
 * Every theme sets the same tokens, so components only ever use `var(--bb-*)`.
 * `reader*` colors are what the book page itself uses (inside the foliate iframe).
 */
export interface Theme {
  id: ThemeId;
  name: string;
  /** Shown on the picker so kids who can't read yet can still choose */
  emoji: string;
  scheme: "light" | "dark";
  colors: {
    bg: string;
    surface: string;
    surface2: string;
    text: string;
    muted: string;
    accent: string;
    accentText: string;
    border: string;
    focus: string;
    readerBg: string;
    readerText: string;
    readerLink: string;
  };
  font: string;
  displayFont: string;
  radius: string;
  /** Optional page background decoration (CSS `background-image`) */
  pattern?: string;
  /** Where the picker lists it: calm reading themes, fun themes, or easiest to see. */
  group: ThemeGroup;
  /** Kid themes: a picture scene for the kid home banner (an SVG). */
  scene?: string;
  /** Kid themes: buddies (avatars) that go with it, offered first in the buddy picker. */
  buddies?: string[];
}

export type ThemeGroup = "calm" | "fun" | "easy";

export const THEME_GROUPS: { id: ThemeGroup; grownUp: string; kid: string }[] = [
  { id: "fun", grownUp: "Fun", kid: "Fun worlds" },
  { id: "calm", grownUp: "Calm reading", kid: "Calm colors" },
  { id: "easy", grownUp: "Easiest to see", kid: "Easy to see" },
];

const SYSTEM = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const ROUNDED = `"Nunito", "Varela Round", ui-rounded, ${SYSTEM}`;
const MONO = `"Press Start 2P", "VT323", ui-monospace, "SFMono-Regular", Menlo, monospace`;

const BOOKISH = `"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif`;

const svgUrl = (svg: string) => `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;

export const THEMES: Record<ThemeId, Theme> = {
  dark: {
    id: "dark",
    group: "calm",
    name: "Dark",
    emoji: "🌙",
    scheme: "dark",
    colors: {
      bg: "#14161b",
      surface: "#1d2027",
      surface2: "#272b34",
      text: "#eceef2",
      muted: "#a3a9b6",
      accent: "#e0a54a",
      accentText: "#1b1305",
      border: "#343945",
      focus: "#f2c27a",
      readerBg: "#16181d",
      readerText: "#dcdfe5",
      readerLink: "#f0b866",
    },
    font: SYSTEM,
    displayFont: SYSTEM,
    radius: "12px",
  },
  light: {
    id: "light",
    group: "calm",
    name: "Light",
    emoji: "☀️",
    scheme: "light",
    colors: {
      bg: "#f7f5f0",
      surface: "#ffffff",
      surface2: "#efebe3",
      text: "#1f1d1a",
      muted: "#5f5a52",
      accent: "#8a4b12",
      accentText: "#ffffff",
      border: "#d9d3c7",
      focus: "#b8641c",
      readerBg: "#fbf8f1",
      readerText: "#222222",
      readerLink: "#8a4b12",
    },
    font: SYSTEM,
    displayFont: `Georgia, "Iowan Old Style", serif`,
    radius: "12px",
  },
  nuclear: {
    id: "nuclear",
    group: "fun",
    name: "Nuclear",
    emoji: "☢️",
    scheme: "dark",
    colors: {
      bg: "#0b0f08",
      surface: "#131a0e",
      surface2: "#1c2614",
      text: "#d9ffb8",
      muted: "#93b878",
      accent: "#9dff2e",
      accentText: "#0b1400",
      border: "#2f4520",
      focus: "#e8ff3a",
      readerBg: "#0d120a",
      readerText: "#cdf5ad",
      readerLink: "#b6ff5c",
    },
    font: SYSTEM,
    displayFont: `"Orbitron", "Eurostile", ${SYSTEM}`,
    radius: "4px",
    pattern: svgUrl(
      `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><path d="M0 40L40 0M-10 10L10-10M30 50L50 30" stroke="#9dff2e" stroke-opacity=".05" stroke-width="10"/></svg>`,
    ),
  },
  retro: {
    id: "retro",
    group: "calm",
    name: "Retro",
    emoji: "📻",
    scheme: "light",
    colors: {
      bg: "#f3e4c4",
      surface: "#fbf1dc",
      surface2: "#ead3a6",
      text: "#3b2412",
      muted: "#6e4f33",
      accent: "#9e3519",
      accentText: "#fff6e6",
      border: "#c9a877",
      focus: "#1f7a72",
      readerBg: "#f8ecd2",
      readerText: "#3b2412",
      readerLink: "#a8371f",
    },
    font: `"Courier Prime", "Courier New", ${SYSTEM}`,
    displayFont: `"Cooper Black", "Bookman Old Style", Georgia, serif`,
    radius: "18px",
  },
  pink: {
    id: "pink",
    group: "fun",
    name: "Pink",
    emoji: "🌸",
    scheme: "light",
    colors: {
      bg: "#fff0f6",
      surface: "#ffffff",
      surface2: "#ffe0ee",
      text: "#4a1631",
      muted: "#874268",
      accent: "#b81d68",
      accentText: "#ffffff",
      border: "#f5b8d4",
      focus: "#9b2c8c",
      readerBg: "#fff7fb",
      readerText: "#3c1428",
      readerLink: "#c01f6e",
    },
    font: ROUNDED,
    displayFont: ROUNDED,
    radius: "22px",
    pattern: svgUrl(
      `<svg xmlns="http://www.w3.org/2000/svg" width="60" height="60"><circle cx="10" cy="10" r="3" fill="#d6247a" fill-opacity=".09"/><circle cx="40" cy="38" r="5" fill="#d6247a" fill-opacity=".07"/></svg>`,
    ),
  },
  school: {
    id: "school",
    group: "fun",
    name: "School",
    emoji: "✏️",
    scheme: "light",
    colors: {
      bg: "#fdfcf5",
      surface: "#ffffff",
      surface2: "#eef3fb",
      text: "#1d2b45",
      muted: "#4d5d7a",
      accent: "#2357c6",
      accentText: "#ffffff",
      border: "#c8d4ea",
      focus: "#d33a2c",
      readerBg: "#ffffff",
      readerText: "#1d2b45",
      readerLink: "#2357c6",
    },
    font: ROUNDED,
    displayFont: `"Comic Neue", "Chalkboard SE", ${ROUNDED}`,
    radius: "10px",
    pattern: svgUrl(
      `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><path d="M0 31.5H32" stroke="#2357c6" stroke-opacity=".12"/></svg>`,
    ),
  },
  gaming: {
    id: "gaming",
    group: "fun",
    name: "Gaming",
    emoji: "🎮",
    scheme: "dark",
    colors: {
      bg: "#0d0a1f",
      surface: "#171233",
      surface2: "#221a4a",
      text: "#ece8ff",
      muted: "#a79ed6",
      accent: "#00e5ff",
      accentText: "#03161a",
      border: "#3b2f7a",
      focus: "#ff3df2",
      readerBg: "#100c26",
      readerText: "#e1dcff",
      readerLink: "#5cf0ff",
    },
    font: SYSTEM,
    displayFont: MONO,
    radius: "6px",
    pattern: svgUrl(
      `<svg xmlns="http://www.w3.org/2000/svg" width="24" height="24"><rect x="11" y="11" width="2" height="2" fill="#00e5ff" fill-opacity=".14"/></svg>`,
    ),
  },
  dinosaur: {
    id: "dinosaur",
    group: "fun",
    name: "Dinosaur",
    scene: svgUrl(SCENES.dinosaur),
    buddies: ["🦖", "🦕", "🥚", "🌋", "🌴"],
    emoji: "🦖",
    scheme: "light",
    colors: {
      bg: "#eef6e4",
      surface: "#ffffff",
      surface2: "#dcedc8",
      text: "#1f3316",
      muted: "#4b6340",
      accent: "#2f7420",
      accentText: "#ffffff",
      border: "#b9d6a0",
      focus: "#b05a00",
      readerBg: "#fbfdf7",
      readerText: "#1f3316",
      readerLink: "#2f7420",
    },
    font: ROUNDED,
    displayFont: ROUNDED,
    radius: "24px",
    pattern: svgUrl(
      `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="90"><g fill="#3f8f2a" fill-opacity=".08"><ellipse cx="20" cy="22" rx="7" ry="9"/><circle cx="13" cy="10" r="3"/><circle cx="20" cy="8" r="3"/><circle cx="27" cy="10" r="3"/><ellipse cx="65" cy="67" rx="7" ry="9"/><circle cx="58" cy="55" r="3"/><circle cx="65" cy="53" r="3"/><circle cx="72" cy="55" r="3"/></g></svg>`,
    ),
  },
  storm: {
    id: "storm",
    group: "calm",
    name: "Storm",
    emoji: "⛈️",
    scheme: "dark",
    colors: {
      bg: "#1a2130",
      surface: "#222b3d",
      surface2: "#2c374d",
      text: "#e6ecf5",
      muted: "#9fadc4",
      accent: "#ffd23f",
      accentText: "#1d1600",
      border: "#3a4762",
      focus: "#7cc4ff",
      readerBg: "#1c2433",
      readerText: "#dbe3ef",
      readerLink: "#ffd85c",
    },
    font: SYSTEM,
    displayFont: SYSTEM,
    radius: "14px",
    pattern: svgUrl(
      `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><path d="M10 0l-4 18M40 20l-4 18M70 40l-4 18M25 50l-4 18" stroke="#7cc4ff" stroke-opacity=".08" stroke-width="1.5"/></svg>`,
    ),
  },
  contrast: {
    id: "contrast",
    group: "easy",
    name: "High contrast",
    emoji: "🔆",
    scheme: "dark",
    colors: {
      bg: "#000000",
      surface: "#000000",
      surface2: "#1a1a1a",
      text: "#ffffff",
      muted: "#e6e6e6",
      accent: "#ffe000",
      accentText: "#000000",
      border: "#ffffff",
      focus: "#00e5ff",
      readerBg: "#000000",
      readerText: "#ffffff",
      readerLink: "#ffe000",
    },
    font: `"Atkinson Hyperlegible", ${SYSTEM}`,
    displayFont: `"Atkinson Hyperlegible", ${SYSTEM}`,
    radius: "8px",
  },
  // --- Grown-up reading themes ------------------------------------------------------------

  sepia: {
    id: "sepia",
    group: "calm",
    name: "Sepia",
    emoji: "📜",
    scheme: "light",
    colors: {
      bg: "#f4ecd8",
      surface: "#fbf6e9",
      surface2: "#ebe0c5",
      text: "#3d2f1f",
      muted: "#6b5640",
      accent: "#7a4a1e",
      accentText: "#fffaf0",
      border: "#d8c9a6",
      focus: "#a0522d",
      readerBg: "#f4ecd8",
      readerText: "#3a2c1b",
      readerLink: "#7a4a1e",
    },
    font: SYSTEM,
    displayFont: BOOKISH,
    radius: "10px",
  },
  eink: {
    id: "eink",
    group: "easy",
    name: "E-ink paper",
    emoji: "📃",
    scheme: "light",
    colors: {
      bg: "#f2f2ee",
      surface: "#ffffff",
      surface2: "#e4e4df",
      text: "#000000",
      muted: "#3a3a3a",
      accent: "#111111",
      accentText: "#ffffff",
      border: "#7a7a7a",
      focus: "#000000",
      readerBg: "#ffffff",
      readerText: "#000000",
      readerLink: "#000000",
    },
    font: SYSTEM,
    displayFont: BOOKISH,
    radius: "4px",
  },
  amoled: {
    id: "amoled",
    group: "calm",
    name: "True black",
    emoji: "🖤",
    scheme: "dark",
    colors: {
      bg: "#000000",
      surface: "#0b0b0b",
      surface2: "#171717",
      text: "#e8e8e8",
      muted: "#a8a8a8",
      accent: "#8ab4f8",
      accentText: "#000000",
      border: "#2a2a2a",
      focus: "#c6dafc",
      readerBg: "#000000",
      readerText: "#cfcfcf",
      readerLink: "#8ab4f8",
    },
    font: SYSTEM,
    displayFont: SYSTEM,
    radius: "12px",
  },
  solarized: {
    id: "solarized",
    group: "calm",
    name: "Solarized",
    emoji: "🌗",
    scheme: "dark",
    colors: {
      bg: "#002b36",
      surface: "#073642",
      surface2: "#0d4250",
      text: "#eee8d5",
      muted: "#a3b0b0",
      accent: "#b58900",
      accentText: "#002b36",
      border: "#1f4f5c",
      focus: "#268bd2",
      readerBg: "#002b36",
      readerText: "#e4ddc8",
      readerLink: "#2aa198",
    },
    font: SYSTEM,
    displayFont: SYSTEM,
    radius: "8px",
  },
  forest: {
    id: "forest",
    group: "calm",
    name: "Forest",
    emoji: "🌲",
    scheme: "dark",
    colors: {
      bg: "#12201a",
      surface: "#1a2b23",
      surface2: "#23392e",
      text: "#e4efe6",
      muted: "#a3bfae",
      accent: "#7fc28e",
      accentText: "#0d1a12",
      border: "#2f4a3c",
      focus: "#e8c56b",
      readerBg: "#14231c",
      readerText: "#dbe8de",
      readerLink: "#9fd6ab",
    },
    font: SYSTEM,
    displayFont: BOOKISH,
    radius: "14px",
    pattern: svgUrl(
      `<svg xmlns="http://www.w3.org/2000/svg" width="70" height="70"><g fill="#7fc28e" fill-opacity=".06"><path d="M15 4 25 22H19L28 38H2L11 22H5Z"/><path d="M52 36 60 50H55L62 62H42L49 50H44Z"/></g></svg>`,
    ),
  },
  ocean: {
    id: "ocean",
    group: "calm",
    name: "Deep ocean",
    emoji: "🌊",
    scheme: "dark",
    colors: {
      bg: "#0b1d2e",
      surface: "#10283d",
      surface2: "#17344f",
      text: "#e3f1fb",
      muted: "#9dbbd2",
      accent: "#4fd1c5",
      accentText: "#062420",
      border: "#24476a",
      focus: "#ffd166",
      readerBg: "#0d2133",
      readerText: "#d9eaf6",
      readerLink: "#6fe0d5",
    },
    font: SYSTEM,
    displayFont: SYSTEM,
    radius: "14px",
    pattern: svgUrl(
      `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><path d="M0 20Q10 12 20 20T40 20T60 20T80 20" fill="none" stroke="#4fd1c5" stroke-opacity=".07" stroke-width="2"/></svg>`,
    ),
  },

  // --- Kid themes: bright, rounded, with a picture scene and matching buddies -------------

  space: {
    id: "space",
    group: "fun",
    name: "Space",
    emoji: "🚀",
    scheme: "dark",
    colors: {
      bg: "#10122e",
      surface: "#1a1d45",
      surface2: "#262b60",
      text: "#f1f0ff",
      muted: "#b9bbea",
      accent: "#ffcf33",
      accentText: "#241a00",
      border: "#3a3f86",
      focus: "#7ee8fa",
      readerBg: "#14163a",
      readerText: "#ecebff",
      readerLink: "#ffd95c",
    },
    font: ROUNDED,
    displayFont: ROUNDED,
    radius: "22px",
    pattern: svgUrl(
      `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="90"><g fill="#fff"><circle cx="12" cy="18" r="1.4" fill-opacity=".5"/><circle cx="60" cy="8" r="1" fill-opacity=".4"/><circle cx="74" cy="56" r="1.6" fill-opacity=".45"/><circle cx="30" cy="70" r="1" fill-opacity=".35"/><path d="M44 36l1.5 4 4 1.5-4 1.5-1.5 4-1.5-4-4-1.5 4-1.5z" fill-opacity=".35"/></g></svg>`,
    ),
    scene: svgUrl(SCENES.space),
    buddies: ["🚀", "👩‍🚀", "👨‍🚀", "👽", "🛸", "🪐", "🌟", "🤖"],
  },
  sea: {
    id: "sea",
    group: "fun",
    name: "Under the sea",
    emoji: "🐙",
    scheme: "light",
    colors: {
      bg: "#e3f6fb",
      surface: "#ffffff",
      surface2: "#c9eef6",
      text: "#0b3a4a",
      muted: "#2f6475",
      accent: "#0a6f82",
      accentText: "#ffffff",
      border: "#9fd9e6",
      focus: "#e8590c",
      readerBg: "#f6fdff",
      readerText: "#0b3a4a",
      readerLink: "#0a6f82",
    },
    font: ROUNDED,
    displayFont: ROUNDED,
    radius: "24px",
    pattern: svgUrl(
      `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><g fill="none" stroke="#0a7a8f" stroke-opacity=".12" stroke-width="2"><circle cx="14" cy="16" r="5"/><circle cx="22" cy="30" r="3"/><circle cx="60" cy="56" r="6"/></g></svg>`,
    ),
    scene: svgUrl(SCENES.sea),
    buddies: ["🐙", "🐠", "🐬", "🐳", "🦀", "🐢", "🦈", "🧜"],
  },
  jungle: {
    id: "jungle",
    group: "fun",
    name: "Jungle",
    emoji: "🐒",
    scheme: "light",
    colors: {
      bg: "#f1f7e0",
      surface: "#ffffff",
      surface2: "#e2efc0",
      text: "#233512",
      muted: "#4b5e30",
      accent: "#b93c0b",
      accentText: "#ffffff",
      border: "#c5db93",
      focus: "#0f766e",
      readerBg: "#fcfef6",
      readerText: "#233512",
      readerLink: "#a8370a",
    },
    font: ROUNDED,
    displayFont: ROUNDED,
    radius: "24px",
    pattern: svgUrl(
      `<svg xmlns="http://www.w3.org/2000/svg" width="96" height="96"><g fill="#3f7d1f" fill-opacity=".08"><ellipse cx="20" cy="20" rx="16" ry="6" transform="rotate(-35 20 20)"/><ellipse cx="72" cy="70" rx="16" ry="6" transform="rotate(30 72 70)"/></g></svg>`,
    ),
    scene: svgUrl(SCENES.jungle),
    buddies: ["🐒", "🦁", "🐯", "🦜", "🐘", "🦒", "🐍", "🦥"],
  },
  unicorn: {
    id: "unicorn",
    group: "fun",
    name: "Unicorn",
    emoji: "🦄",
    scheme: "light",
    colors: {
      bg: "#f7f0ff",
      surface: "#ffffff",
      surface2: "#ece0ff",
      text: "#3b1f5e",
      muted: "#664a8a",
      accent: "#8a3fd0",
      accentText: "#ffffff",
      border: "#d9c3f5",
      focus: "#d6336c",
      readerBg: "#fdfaff",
      readerText: "#33194f",
      readerLink: "#7a2fc0",
    },
    font: ROUNDED,
    displayFont: ROUNDED,
    radius: "26px",
    pattern: svgUrl(
      `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><g fill="#a855f7" fill-opacity=".1"><path d="M16 8l2 6 6 2-6 2-2 6-2-6-6-2 6-2z"/><path d="M58 48l1.5 4.5 4.5 1.5-4.5 1.5-1.5 4.5-1.5-4.5-4.5-1.5 4.5-1.5z"/></g></svg>`,
    ),
    scene: svgUrl(SCENES.unicorn),
    buddies: ["🦄", "🌈", "🧚", "🦋", "🌸", "🐰", "🐱", "⭐"],
  },
  builder: {
    id: "builder",
    group: "fun",
    name: "Construction",
    emoji: "🚧",
    scheme: "light",
    colors: {
      bg: "#fff7d6",
      surface: "#ffffff",
      surface2: "#ffeaa0",
      text: "#262626",
      muted: "#57534e",
      accent: "#f0a800",
      accentText: "#1a1a1a",
      border: "#f0cf6a",
      focus: "#c2410c",
      readerBg: "#fffdf4",
      readerText: "#222222",
      readerLink: "#9a4a00",
    },
    font: ROUNDED,
    displayFont: `"Arial Black", ${ROUNDED}`,
    radius: "10px",
    pattern: svgUrl(
      `<svg xmlns="http://www.w3.org/2000/svg" width="40" height="40"><path d="M0 40L40 0M-10 10L10-10M30 50L50 30" stroke="#222" stroke-opacity=".04" stroke-width="8"/></svg>`,
    ),
    scene: svgUrl(SCENES.builder),
    buddies: ["🚜", "🏗️", "👷", "🚚", "🔨", "🧱", "🚒", "🦺"],
  },
  castle: {
    id: "castle",
    group: "fun",
    name: "Castle",
    emoji: "🏰",
    scheme: "light",
    colors: {
      bg: "#f3f1fb",
      surface: "#ffffff",
      surface2: "#e4e2f7",
      text: "#221d47",
      muted: "#52497a",
      accent: "#3b3fb0",
      accentText: "#ffffff",
      border: "#cdc8ec",
      focus: "#8a6408",
      readerBg: "#fdfcf7",
      readerText: "#221d47",
      readerLink: "#3b3fb0",
    },
    font: ROUNDED,
    displayFont: `"Cinzel", Georgia, ${ROUNDED}`,
    radius: "16px",
    pattern: svgUrl(
      `<svg xmlns="http://www.w3.org/2000/svg" width="90" height="90"><g fill="#3b3fb0" fill-opacity=".07"><path d="M10 30l5-10 5 7 5-7 5 7 5-7 5 10z"/><path d="M58 64h16v8c0 7-8 10-8 10s-8-3-8-10z"/></g></svg>`,
    ),
    scene: svgUrl(SCENES.castle),
    buddies: ["👑", "🤴", "👸", "🛡️", "🐉", "🧙", "🦄", "🐴"],
  },

};

export const THEME_LIST: Theme[] = THEME_IDS.map((id) => THEMES[id]);

export function themeOrDefault(id: unknown): Theme {
  return THEMES[isThemeId(id) ? id : DEFAULT_THEME];
}

/** CSS custom properties for a theme, as `[name, value]` pairs. */
export function themeVars(theme: Theme): [string, string][] {
  const c = theme.colors;
  return [
    ["--bb-bg", c.bg],
    ["--bb-surface", c.surface],
    ["--bb-surface-2", c.surface2],
    ["--bb-text", c.text],
    ["--bb-muted", c.muted],
    ["--bb-accent", c.accent],
    ["--bb-accent-text", c.accentText],
    ["--bb-border", c.border],
    ["--bb-focus", c.focus],
    ["--bb-reader-bg", c.readerBg],
    ["--bb-reader-text", c.readerText],
    ["--bb-font", theme.font],
    ["--bb-display-font", theme.displayFont],
    ["--bb-radius", theme.radius],
    ["--bb-pattern", theme.pattern ?? "none"],
    ["--bb-scene", theme.scene ?? "none"],
  ];
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  installAppFonts(root.ownerDocument);
  for (const [k, v] of themeVars(theme)) root.style.setProperty(k, v);
  root.dataset.theme = theme.id;
  root.dataset.scheme = theme.scheme;
  root.style.colorScheme = theme.scheme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute("content", theme.colors.bg);
}

// --- contrast helpers (used by tests so every theme stays readable) ---

function channel(v: number): number {
  const s = v / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

export function luminance(hex: string): number {
  const m = /^#([0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error(`Not a #rrggbb color: ${hex}`);
  const n = parseInt(m[1], 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}
