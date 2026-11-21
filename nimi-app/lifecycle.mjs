/** Use the existing DSH renderer, Electron build, and production resource staging. */
import { existsSync } from 'node:fs'
import { access, copyFile, cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { tmpdir } from 'node:os'

const repo = resolve(import.meta.dirname, '..')
const appDir = import.meta.dirname
const appPackage = JSON.parse(await readFile(join(appDir, 'package.json'), 'utf8'))
const { packageManager } = JSON.parse(await readFile(join(repo, 'package.json'), 'utf8'))

function spawnCorepack(args, cwd, env = process.env) {
  if (process.platform === 'win32') {
    const corepackJs = join(dirname(process.execPath), 'node_modules', 'corepack', 'dist', 'corepack.js')
    if (existsSync(corepackJs)) {
      return spawn(process.execPath, [corepackJs, ...args], { cwd, stdio: 'inherit', env })
    }
    return spawn('corepack.cmd', args, { cwd, stdio: 'inherit', env, shell: true })
  }
  return spawn('corepack', args, { cwd, stdio: 'inherit', env })
}

async function run(args, env = process.env) {
  await new Promise((done, reject) => {
    const child = spawnCorepack([packageManager, ...args], repo, env)
    child.on('error', reject)
    child.on('exit', (code, signal) => code === 0 ? done() : reject(new Error(`DSH command failed (${code ?? signal}): ${args.join(' ')}`)))
  })
}

async function buildSettings() {
  await new Promise((done, reject) => {
    const child = spawnCorepack([appPackage.packageManager, 'run', 'build:settings'], appDir)
    child.on('error', reject)
    child.on('exit', code => code === 0 ? done() : reject(new Error(`Nimi settings build failed (${code})`)))
  })
}

switch (process.argv[2]) {
  case 'host':
    await buildSettings()
    await mkdir(join(appDir, 'dist-electron'), { recursive: true })
    await run(['--filter', '@deepseek-ai/dsh-desktop', 'run', 'dev', '--prepare-only',
      '--runtime-descriptor', join(appDir, 'dist-electron', 'dsh-dev-resources.json')])
    await copyFile(join(appDir, 'host/main.js'), join(appDir, 'dist-electron/main.js'))
    break
  case 'renderer':
    await run(['--filter', '@deepseek-ai/dsh-web-frontend', 'exec', 'http-server', 'dist', '-a', '127.0.0.1', '-p', '4143', '-c-1'])
    break
  case 'package-macos': {
    await buildSettings()
    const { readCuaApplication } = await import('../scripts/cua-helper/payload.ts')
    const stage = await mkdtemp(join(tmpdir(), 'nimi-dsh-cua-'))
    try {
      await run(['exec', '/usr/bin/xcrun', 'python3', 'packages/experimental/cua-macos/native/build_app.py',
        '--output-directory', stage, '--arch', 'arm64', '--variant', 'release'])
      readCuaApplication(stage)
      await run(['--filter', '@deepseek-ai/dsh-desktop', 'run', 'package:mac:arm64:unsigned', '--dir'], {
        ...process.env, DSH_NIMI_LOCAL_BUILD: '1', DSH_NIMI_CUA_RELEASE_DIR: stage,
      })
      const { desktopTargetBuildPaths } = await import('../apps/desktop/scripts/desktop-build-paths.mjs')
      const source = join(desktopTargetBuildPaths('mac-arm64', process.env).unsignedArtifacts, 'mac-arm64', 'DeepSeek Harness.app')
      readCuaApplication(join(source, 'Contents/Resources/app.asar.unpacked/dsh/node_modules',
        '@deepseek-ai/dsh-cua-macos/native/bin/darwin-arm64'))
      const outputRoot = join(appDir, 'dist-electron-package')
      const destination = join(outputRoot, 'DeepSeek Harness.app')
      await rm(outputRoot, { recursive: true, force: true })
      await mkdir(outputRoot, { recursive: true })
      await cp(source, destination, { recursive: true, verbatimSymlinks: true })
    } finally {
      await rm(stage, { recursive: true, force: true })
    }
    break
  }
  case 'package-windows': {
    await buildSettings()
    await run(['--filter', '@deepseek-ai/dsh-desktop', 'run', 'package:win:x64:unsigned', '--dir'], {
      ...process.env, DSH_NIMI_LOCAL_BUILD: '1',
    })
    const { desktopTargetBuildPaths } = await import('../apps/desktop/scripts/desktop-build-paths.mjs')
    const source = join(desktopTargetBuildPaths('win-x64', process.env).unsignedArtifacts, 'win-unpacked')
    const outputRoot = join(appDir, 'dist-electron-package')
    await rm(outputRoot, { recursive: true, force: true })
    await cp(source, outputRoot, { recursive: true })
    await access(join(outputRoot, 'DeepSeek Harness.exe'))
    break
  }
  case 'test':
    await run([
      'exec', 'vitest', 'run',
      'apps/desktop-host/tests/nimi-model-adapter.spec.ts',
      'apps/desktop-host/tests/nimi-ecosystem-plugin.spec.ts',
      'apps/desktop/tests/nimi-text.spec.ts',
      'apps/desktop/tests/nimi-ecosystem.spec.ts',
      'apps/desktop/tests/nimi-session-provider.spec.ts',
      'apps/desktop/tests/preload-app.spec.ts',
      'packages/client/ui-settings-general/tests/nimi-ui.client.spec.tsx',
    ])
    break
  default:
    throw new Error('Choose host, renderer, package-macos, package-windows, or test.')
}
