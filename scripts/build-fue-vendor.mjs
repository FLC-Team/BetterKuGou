import fs from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { build } from 'vite'
import vue from '@vitejs/plugin-vue'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
if (!process.argv[2]) throw new Error('Usage: node scripts/build-fue-vendor.mjs <Fue source directory>')
const sourceRoot = path.resolve(process.argv[2])
const output = path.join(root, '.agent/tools/fue-package')
const manifest = JSON.parse(await fs.readFile(path.join(sourceRoot, 'package.json'), 'utf8'))
if (manifest.name !== '@fue/ui' || manifest.version !== '0.1.0') throw new Error('Expected Fue UI 0.1.0 source')

/** Extend only Message content rendering for application actions; retain all upstream effects and timers. */
function patchMessage(source, id) {
  const filename = id.replaceAll('\\', '/')
  if (filename.endsWith('/f_message_context.ts')) {
    if (!source.includes('content: string;')) throw new Error('Fue Message content type changed')
    return { code: source.replace('content: string;', "content: string | (() => import('vue').VNodeChild);"), map: null }
  }
  if (!filename.endsWith('/f_message_provider.vue')) return null
  const replacements = [
    ['  content: string;', "  content: MessageOptions['content'];"],
    ['{{ entry.content }}', '<component v-if="typeof entry.content === \'function\'" :is="entry.content" /><template v-else>{{ entry.content }}</template>']
  ]
  for (const [before, after] of replacements) {
    if (!source.includes(before)) throw new Error(`Fue Message source changed: missing ${before}`)
    source = source.replace(before, after)
  }
  return { code: source, map: null }
}

await build({
  configFile: false,
  root: sourceRoot,
  plugins: [{ name: 'bk-fue-message-content', enforce: 'pre', transform: patchMessage }, vue()],
  resolve: { alias: { '@': path.join(sourceRoot, 'src') } },
  build: {
    outDir: path.join(output, 'dist'), emptyOutDir: true,
    lib: { entry: path.join(sourceRoot, 'src/index.ts'), name: 'FueUi', formats: ['es', 'cjs'],
      cssFileName: 'style', fileName: format => `fue-ui.${format === 'es' ? 'js' : 'cjs'}` },
    rollupOptions: { external: ['vue'], output: { exports: 'named', globals: { vue: 'Vue' } } }
  }
})

/** Carry upstream declarations into the archive, keeping the Message extension typed. */
async function copyDeclarations(directory, relative = '') {
  for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
    const next = path.join(relative, entry.name)
    if (entry.isDirectory()) await copyDeclarations(path.join(directory, entry.name), next)
    else if (entry.name.endsWith('.d.ts')) {
      let declaration = await fs.readFile(path.join(directory, entry.name), 'utf8')
      if (entry.name === 'f_message_context.d.ts') {
        if (!declaration.includes('content: string;')) throw new Error('Fue Message declaration changed')
        declaration = declaration.replace('content: string;', "content: string | (() => import('vue').VNodeChild);")
      }
      const target = path.join(output, 'dist', next)
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, declaration)
    }
  }
}
await copyDeclarations(path.join(sourceRoot, 'dist'))
const { name, description, type, files, main, module, types, exports, peerDependencies } = manifest
await fs.writeFile(path.join(output, 'package.json'), JSON.stringify({ name, version: '0.1.0-bk.1',
  description, type, files, main, module, types, exports, peerDependencies }, null, 2) + '\n')
console.log('Prepared .agent/tools/fue-package. Pack with npm pack ./.agent/tools/fue-package --pack-destination vendor --ignore-scripts')
