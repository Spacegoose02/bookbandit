import { DEFAULT_THEME, isThemeId, THEME_IDS, type ThemeId } from "@bookbandit/shared";
import { installAppFonts } from "./fonts";

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
}

const SYSTEM = `system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
const ROUNDED = `"Nunito", "Varela Round", ui-rounded, ${SYSTEM}`;
const MONO = `"Press Start 2P", "VT323", ui-monospace, "SFMono-Regular", Menlo, monospace`;

const svgUrl = (svg: string) => `url("data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}")`;

export const THEMES: Record<ThemeId, Theme> = {
  dark: {
    id: "dark",
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
    name: "Retro",
    emoji: "📻",
    scheme: "light",
    colors: {
      bg: "#f3e4c4",
      surface: "#fbf1dc",
      surface2: "#ead3a6",
      text: "#3b2412",
      muted: "#6e4f33",
      accent: "#c2462b",
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
    name: "Pink",
    emoji: "🌸",
    scheme: "light",
    colors: {
      bg: "#fff0f6",
      surface: "#ffffff",
      surface2: "#ffe0ee",
      text: "#4a1631",
      muted: "#874268",
      accent: "#d6247a",
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
    name: "Dinosaur",
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
      focus: "#e07b00",
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
  ];
}

export function applyTheme(theme: Theme, root: HTMLElement = document.documentElement): void {
  installAppFonts(root.ownerDocument);
  for (const [k, v] of themeVars(theme)) root.style.setProperty(k, v);
  root.dataset.theme = theme.id;
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
