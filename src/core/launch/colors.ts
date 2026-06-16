/**
 * Tab color resolution for Windows Terminal launches.
 *
 * Accepts either a natural color name (case-insensitive) or a hex value in
 * `#RRGGBB` / `RRGGBB` form and normalizes it to an upper-case `#RRGGBB`
 * string that Windows Terminal's `--tabColor` flag understands.
 */

/** Natural color name -> canonical upper-case `#RRGGBB`. */
const COLOR_MAP: Record<string, string> = {
  black: "#000000",
  white: "#FFFFFF",
  red: "#FF0000",
  green: "#00FF00",
  blue: "#0000FF",
  yellow: "#FFFF00",
  orange: "#FFA500",
  purple: "#800080",
  violet: "#EE82EE",
  pink: "#FFC0CB",
  magenta: "#FF00FF",
  fuchsia: "#FF00FF",
  cyan: "#00FFFF",
  aqua: "#00FFFF",
  teal: "#008080",
  gray: "#808080",
  grey: "#808080",
  silver: "#C0C0C0",
  maroon: "#800000",
  olive: "#808000",
  navy: "#000080",
  lime: "#00FF00",
  brown: "#A52A2A",
  gold: "#FFD700",
  amber: "#FFBF00",
  indigo: "#4B0082",
  crimson: "#DC143C",
  slate: "#708090",
  "dark-green": "#008000",
  "light-green": "#90EE90",
  "dark-blue": "#00008B",
  "light-blue": "#ADD8E6",
  "dark-red": "#8B0000",
  "bright-red": "#FF0000",
  "bright-green": "#00FF00",
  "bright-blue": "#0000FF",
};

const HEX_RE = /^#?[0-9a-fA-F]{6}$/;

/**
 * Resolve a color name or hex string to an upper-case `#RRGGBB` value.
 * Throws a descriptive error (listing the known names) for unknown colors.
 */
export function colorToHex(color: string): string {
  const trimmed = color.trim();

  if (HEX_RE.test(trimmed)) {
    const hex = trimmed.startsWith("#") ? trimmed.slice(1) : trimmed;
    return `#${hex.toUpperCase()}`;
  }

  const mapped = COLOR_MAP[trimmed.toLowerCase()];
  if (mapped) {
    return mapped;
  }

  const known = Object.keys(COLOR_MAP).join(", ");
  throw new Error(
    `Unknown color "${color}". Use a "#RRGGBB" hex value or one of: ${known}.`,
  );
}
