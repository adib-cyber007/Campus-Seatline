import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const clientDir = path.resolve(fileURLToPath(new URL('..', import.meta.url)))
const repoDir = path.resolve(clientDir, '..')

const manifests = [
  path.join(repoDir, 'package.json'),
  path.join(clientDir, 'package.json'),
  path.join(repoDir, 'server', 'package.json')
]
const versions = manifests.map(file => JSON.parse(fs.readFileSync(file, 'utf8')).version)
const releaseVersion = versions[0]
if (versions.some(version => version !== releaseVersion)) {
  throw new Error(`Package versions diverge: ${versions.join(', ')}`)
}

const gradle = fs.readFileSync(path.join(clientDir, 'android', 'app', 'build.gradle'), 'utf8')
const versionName = gradle.match(/versionName\s+"([^"]+)"/)?.[1]
const versionCode = Number(gradle.match(/versionCode\s+(\d+)/)?.[1])
if (versionName !== releaseVersion) {
  throw new Error(`Android versionName ${versionName || '<missing>'} does not match ${releaseVersion}`)
}
if (!Number.isInteger(versionCode) || versionCode < 6) {
  throw new Error(`Android versionCode must be an integer >= 6; found ${versionCode || '<missing>'}`)
}

console.log(`Release versions aligned at ${releaseVersion} (Android versionCode ${versionCode})`)
