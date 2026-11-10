import assert from 'node:assert/strict'
import { readdir, readFile } from 'node:fs/promises'
import { join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'
const root = fileURLToPath(new URL('../src/pages', import.meta.url))
async function files(dir) {
  const entries = await readdir(dir, { withFileTypes: true })
  return (await Promise.all(entries.map(e => e.isDirectory() ? files(join(dir, e.name)) : [join(dir, e.name)]))).flat().filter(f => /\.mdx?$/.test(f))
}
const pages = await files(root)
const routes = new Set(pages.map(f => '/'+relative(root, f).replace(/\.mdx?$/, '').replace(/(^|\/)index$/, '')))
routes.add('/')
const config = fileURLToPath(new URL('../vocs.config.ts', import.meta.url))
for (const file of [...pages, config]) {
  const content = (await readFile(file, 'utf8')).replace(/```[\s\S]*?```/g, '')
  const links = [...content.matchAll(/\]\((\/[^\s)]*)\)|(?:href|to|link)\s*[:=]\s*["'](\/[^"']*)["']/g)]
  for (const match of links) {
    const path = (match[1] ?? match[2]).split(/[?#]/)[0].replace(/\/$/, '') || '/'
    assert(routes.has(path), `${relative(root, file)} links to missing route: ${path}`)
  }
}
console.log(`Verified local page links and navigation across ${pages.length} pages`)
