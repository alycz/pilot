import { readFile, writeFile } from 'node:fs/promises'

const manifest = JSON.parse(await readFile(new URL('../../services/harbor/catalog/manifest.json', import.meta.url), 'utf8'))
const server = await readFile(new URL('../../services/harbor/src/server.ts', import.meta.url), 'utf8')
const capability = await readFile(new URL('../../services/harbor/src/ops/capability.ts', import.meta.url), 'utf8')
const localBlock = server.match(/const LOCAL_ONLY_OPERATION_NAMES = new Set\(\[([\s\S]*?)\]\)/)?.[1]
const capabilityBlock = capability.match(/CAPABILITY_OPERATION_NAMES = Object.freeze\(\[([\s\S]*?)\]/)?.[1]
if (!localBlock?.includes('...CAPABILITY_OPERATION_NAMES') || !capabilityBlock) throw new Error('Review runtime registry filtering before generating docs')
const strings = value => [...value.matchAll(/["']([a-z][a-zA-Z0-9.-]+)["']/g)].map(match => match[1])
const local = new Set([...strings(localBlock), ...strings(capabilityBlock)])
const ops = manifest.ops
if (!Array.isArray(ops) || new Set(ops.map(op => op.name)).size !== ops.length) throw new Error('Invalid catalog')
const escape = value => String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('{', '&#123;').replaceAll('}', '&#125;').replaceAll('|', '&#124;')
let text = `# Harbor operation signatures\n\nGenerated from the source catalog. Do not edit this page by hand; run \`npm run generate\` in \`services/harbor\`, then \`npm run catalog\` in \`docs-site\`.\n\nThe generated registry contains **${ops.length} operations**, of which **${ops.filter(op => !local.has(op.name)).length}** remain in the production registry after the local-only filter. These counts describe code registration, not live acceptance or permission. Deployment profiles, operation guards, provider configuration, network support, and owner scope can further restrict availability.\n\nArguments marked \`?\` are optional in the catalog signature. Search the running MCP catalog for current discovery metadata; inspect the linked source schemas for required enums, bounds, cross-field validation, and authorization. A signature is not a complete JSON Schema.\n\nUse \`POST /api/ops/{operation}\` with JSON arguments or the corresponding MCP namespace. Hyphenated namespace segments require JavaScript bracket notation, not dot notation. See [first request](/harbor/quickstart), [response envelopes](/mcp/envelope), and [security](/harbor/security).\n\n`
for (const family of [...new Set(ops.map(op => op.family))].sort()) {
  text += `## ${escape(family)}\n\n`
  for (const op of ops.filter(op => op.family === family)) {
    text += `### ${op.name}\n\n${escape(op.summary)}\n\n\`\`\`text\n${op.signature}\n\`\`\`\n\n`
    if (local.has(op.name)) text += '**Local registry only.** Not included in the production registry.\n\n'
    if (op.caveats.length) text += `Catalog caveats: ${op.caveats.map(c => '`'+c+'`').join(', ')}.\n\n`
  }
}
text += 'Sources: [operation schemas](https://github.com/alycz/pilot/tree/main/services/harbor/src/ops), [runtime registry filtering](https://github.com/alycz/pilot/blob/main/services/harbor/src/server.ts), [catalog generator](https://github.com/alycz/pilot/blob/main/services/harbor/scripts/build-catalog.mjs).\n'
const destination = new URL('../src/pages/harbor/operations.mdx', import.meta.url)
if (process.argv.includes('--check')) {
  if (await readFile(destination, 'utf8') !== text) throw new Error('Harbor operation docs are stale; run npm run catalog')
  console.log(`Verified ${ops.length} operation signatures`)
} else {
  await writeFile(destination, text)
  console.log(`Wrote ${ops.length} operation signatures`)
}
