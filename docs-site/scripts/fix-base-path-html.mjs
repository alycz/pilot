import { readdir, readFile, writeFile } from 'node:fs/promises'
import { extname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const outputDirectory = fileURLToPath(new URL('../dist/public/', import.meta.url))
const unprefixedSkipLink = /href="\/(?!docs(?:\/|"))([^"#]*#vocs-content)"/g

async function htmlFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true })
  const files = []
  for (const entry of entries) {
    const path = join(directory, entry.name)
    if (entry.isDirectory()) files.push(...(await htmlFiles(path)))
    else if (entry.isFile() && extname(entry.name) === '.html') files.push(path)
  }
  return files
}

let patched = 0
for (const file of await htmlFiles(outputDirectory)) {
  const source = await readFile(file, 'utf8')
  const output = source.replace(unprefixedSkipLink, (_match, target) => {
    patched += 1
    return `href="/docs/${target}"`
  })
  if (output !== source) await writeFile(file, output)
}

if (patched === 0) throw new Error('Vocs emitted no unprefixed skip-to-content links')
process.stdout.write(`prefixed ${patched} skip-to-content links with /docs\n`)
