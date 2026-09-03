import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import {
  applyTheme,
  normalizeTheme,
  readTheme,
  saveTheme,
  THEMES,
  THEME_STORAGE_KEY
} from '../src/theme.js'

let passed = 0

function check(name, verify) {
  verify()
  passed += 1
  console.log(`✓ ${name}`)
}

const values = new Map()
const storage = {
  getItem(key) {
    return values.get(key) ?? null
  },
  setItem(key, value) {
    values.set(key, value)
  }
}

check('defaults to the existing light theme', () => {
  assert.equal(readTheme(storage), THEMES.LIGHT)
  assert.equal(normalizeTheme('unexpected'), THEMES.LIGHT)
})

check('persists and restores dark mode', () => {
  assert.equal(saveTheme(THEMES.DARK, storage), THEMES.DARK)
  assert.equal(values.get(THEME_STORAGE_KEY), THEMES.DARK)
  assert.equal(readTheme(storage), THEMES.DARK)
})

check('applies the root theme and browser chrome color', () => {
  const meta = {
    content: null,
    setAttribute(name, value) {
      assert.equal(name, 'content')
      this.content = value
    }
  }
  const document = {
    documentElement: { dataset: {}, style: {} },
    querySelector(selector) {
      assert.equal(selector, 'meta[name="theme-color"]')
      return meta
    }
  }

  assert.equal(applyTheme(THEMES.DARK, document), THEMES.DARK)
  assert.equal(document.documentElement.dataset.theme, THEMES.DARK)
  assert.equal(document.documentElement.style.colorScheme, THEMES.DARK)
  assert.equal(meta.content, '#10151F')

  applyTheme(THEMES.LIGHT, document)
  assert.equal(document.documentElement.dataset.theme, THEMES.LIGHT)
  assert.equal(meta.content, '#EEF1F4')
})

check('fails safely when browser storage is unavailable', () => {
  const blockedStorage = {
    getItem() {
      throw new Error('blocked')
    },
    setItem() {
      throw new Error('blocked')
    }
  }

  assert.equal(readTheme(blockedStorage), THEMES.LIGHT)
  assert.doesNotThrow(() => saveTheme(THEMES.DARK, blockedStorage))
})

function luminance(hex) {
  const channels = hex.slice(1).match(/../g).map(channel => {
    const value = Number.parseInt(channel, 16) / 255
    return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
  })
  return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2]
}

function contrast(foreground, background) {
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8')
const styles = await readFile(new URL('../src/styles.css', import.meta.url), 'utf8')
check('restores dark mode before the application module loads', () => {
  const restoreIndex = indexHtml.indexOf("localStorage.getItem('seatline_theme_v1')")
  const appIndex = indexHtml.indexOf('src="/src/main.jsx"')
  assert.ok(restoreIndex >= 0)
  assert.ok(appIndex > restoreIndex)
})

check('declares the approved fixed design tokens', () => {
  for (const [name, value] of [
    ['ink', '#10151f'],
    ['paper', '#eef1f4'],
    ['paper-dim', '#e2e6ea'],
    ['line-teal', '#17847a'],
    ['line-amber', '#e8a33d'],
    ['line-red', '#c1432e'],
    ['text', '#14181f'],
    ['text-inv', '#f2f4f6']
  ]) {
    assert.match(styles, new RegExp(`--${name}: ${value};`, 'i'))
  }
})

check('keeps text and semantic state labels above WCAG AA contrast', () => {
  for (const [foreground, background] of [
    ['#14181f', '#eef1f4'],
    ['#f2f4f6', '#10151f'],
    ['#0d655e', '#eef1f4'],
    ['#704500', '#eef1f4'],
    ['#9d3021', '#eef1f4'],
    ['#75c7bf', '#151d28'],
    ['#e8a33d', '#151d28'],
    ['#ee8d7b', '#151d28']
  ]) {
    assert.ok(contrast(foreground, background) >= 4.5)
  }
})

check('dark-theme selectors cannot hide or rearrange functional UI', () => {
  const darkBlocks = [...styles.matchAll(/:root\[data-theme='dark'\][^{]*\{([^}]*)\}/g)]
  assert.ok(darkBlocks.length > 0)
  for (const [, declarations] of darkBlocks) {
    assert.doesNotMatch(declarations, /\b(display|visibility|position|width|height|overflow|grid-template|order)\s*:/)
  }
})

console.log(`\nTheme verification: ${passed}/${passed} passed`)
