import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import electron from 'vite-plugin-electron/simple'
import { copyFile, mkdir } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 将主进程直接加载的 HTML 放到构建入口旁，保持开发和构建路径一致。 */
function copyElectronPages() {
  const sourceRoot = fileURLToPath(new URL('.', import.meta.url))
  let outputDirectory
  return {
    name: 'copy-electron-pages',
    configResolved(config) {
      outputDirectory = path.resolve(config.root, config.build.outDir)
    },
    async closeBundle() {
      await mkdir(outputDirectory, { recursive: true })
      await Promise.all(['loading.html', 'desktopLyric.html'].map(file =>
        copyFile(path.join(sourceRoot, 'electron', file), path.join(outputDirectory, file))
      ))
    }
  }
}

// https://vitejs.dev/config/
export default defineConfig({
  base: './',
  plugins: [
    vue(),
    electron({
      main: {
        entry: 'electron/main.js',
        vite: {
          plugins: [copyElectronPages()],
          build: {
            commonjsOptions: { include: [/electron[\\/]/, /node_modules/] }
          }
        },
      },
      preload: {
        input: 'electron/preload.js',
      },
    }),
  ],
  build: {
    outDir: 'dist'
  }
})
