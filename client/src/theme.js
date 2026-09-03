export const THEME_STORAGE_KEY = 'seatline_theme_v1'

export const THEMES = Object.freeze({
  LIGHT: 'light',
  DARK: 'dark'
})

export function normalizeTheme(value) {
  return value === THEMES.DARK ? THEMES.DARK : THEMES.LIGHT
}

export function readTheme(storage) {
  try {
    return normalizeTheme((storage ?? globalThis.localStorage)?.getItem(THEME_STORAGE_KEY))
  } catch {
    return THEMES.LIGHT
  }
}

export function saveTheme(theme, storage) {
  const normalized = normalizeTheme(theme)
  try {
    const selectedStorage = storage ?? globalThis.localStorage
    selectedStorage?.setItem(THEME_STORAGE_KEY, normalized)
  } catch {
    // Storage can be unavailable in private or restricted browser contexts.
  }
  return normalized
}

export function applyTheme(theme, targetDocument = globalThis.document) {
  const normalized = normalizeTheme(theme)
  const root = targetDocument?.documentElement
  if (!root) return normalized

  root.dataset.theme = normalized
  root.style.colorScheme = normalized

  const themeColor = targetDocument.querySelector?.('meta[name="theme-color"]')
  themeColor?.setAttribute('content', normalized === THEMES.DARK ? '#0F182B' : '#F7F5F0')

  return normalized
}
