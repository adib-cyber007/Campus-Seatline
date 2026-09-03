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
  assert.equal(meta.content, '#0F182B')

  applyTheme(THEMES.LIGHT, document)
  assert.equal(document.documentElement.dataset.theme, THEMES.LIGHT)
  assert.equal(meta.content, '#F7F5F0')
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

const indexHtml = await readFile(new URL('../index.html', import.meta.url), 'utf8')
check('restores dark mode before the application module loads', () => {
  const restoreIndex = indexHtml.indexOf("localStorage.getItem('seatline_theme_v1')")
  const appIndex = indexHtml.indexOf('src="/src/main.jsx"')
  assert.ok(restoreIndex >= 0)
  assert.ok(appIndex > restoreIndex)
})

console.log(`\nTheme verification: ${passed}/${passed} passed`)
