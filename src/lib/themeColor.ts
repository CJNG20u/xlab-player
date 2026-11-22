export const DEFAULT_APP_THEME_COLOR = '#121212';

/**
 * Normalizes a 3- or 6-digit hex color string into uppercase `#RRGGBB`.
 * Returns the fallback if the input is invalid.
 */
export function normalizeHexColor(input: string | null | undefined, fallback = DEFAULT_APP_THEME_COLOR): string {
  if (!input) return fallback;
  const trimmed = input.trim();
  const shortMatch = /^#([0-9a-fA-F]{3})$/.exec(trimmed);
  if (shortMatch) {
    const [r, g, b] = shortMatch[1].split('');
    return `#${r}${r}${g}${g}${b}${b}`.toLowerCase();
  }
  const fullMatch = /^#([0-9a-fA-F]{6})$/.exec(trimmed);
  if (fullMatch) {
    return `#${fullMatch[1]}`.toLowerCase();
  }
  return fallback;
}

/**
 * Computes the exact darkened top gradient hex color used at the top edge of
 * the full-screen Now Playing view so the mobile status bar blends seamlessly
 * while keeping white status bar clock/battery icons legible.
 */
export function computeNowPlayingTopHex(dominantColor: string | null | undefined): string {
  const hex = normalizeHexColor(dominantColor, '#1f3a2e');
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);

  // Apply the same subtle 18% darkening tint to match the top of the Now Playing gradient
  const factor = 0.82;
  const toHex = (n: number) =>
    Math.max(0, Math.min(255, Math.round(n * factor)))
      .toString(16)
      .padStart(2, '0');

  return `#${toHex(r)}${toHex(g)}${toHex(b)}`;
}

/**
 * Dynamically updates `<meta name="theme-color">` and root background backing so
 * Android Chrome and iOS Safari status bars match the active screen color.
 */
export function setDocumentThemeColor(hexColor: string): void {
  if (typeof document === 'undefined') return;
  const normalized = normalizeHexColor(hexColor, DEFAULT_APP_THEME_COLOR);

  let meta = document.querySelector<HTMLMetaElement>('meta[name="theme-color"]');
  if (!meta) {
    meta = document.createElement('meta');
    meta.name = 'theme-color';
    document.head.appendChild(meta);
  }
  meta.setAttribute('content', normalized);
  document.documentElement.style.backgroundColor = normalized;
  if (document.body) {
    document.body.style.backgroundColor = normalized;
  }
}
