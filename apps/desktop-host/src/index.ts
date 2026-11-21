/** Launch the Desktop profile through the Web application and report its URL to Electron. */

import { delimiter, join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import type { PluginOperationRunId } from '@deepseek-ai/dsh-plugin-manager/diagnostic'
import { formatFatalDiagnostic } from './fatal-diagnostic.ts'
import { loadLayeredEnv, loadProfileDirectory, reportSkippedBundles } from '@deepseek-ai/dsh-app-boot'
import { runProfile } from '@deepseek-ai/dsh/profile-boot'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'
import type {} from '@deepseek-ai/dsh-deepseek-account'
import { localDragResource } from './file-drag.ts'

import { installDesktopUpdateTaskControl } from './update-tasks.ts'
import { installDesktopQuitInspection } from './quit-inspection.ts'
import { installPlatformSessionPublisher } from './platform-session.ts'
import { installOperationDiagnostics } from './operation-diagnostics.ts'
import { DesktopAuthenticationEnd, receiveDesktopSecret } from './authentication.ts'
import * as DesktopAuthentication from '@deepseek-ai/dsh-host-authentication-desktop'
import { NIMI_LOCAL_PROVIDER_ID, NimiModelAdapter } from './nimi-model-adapter.ts'
import {
  ensureNimiRouteConfig,
  listNimiModels,
  listNimiRoutes,
  readNimiModelInfo,
  streamNimiText,
  uploadNimiImage,
} from './nimi-text-client.ts'
import { installNimiEcosystemPlugin } from './nimi-ecosystem-plugin.ts'

async function main(): Promise<void> {
  const runId = randomUUID() as PluginOperationRunId
  const authentication = receiveDesktopSecret(process)
  if (process.connected) process.send?.({ type: 'starting', runId }, (error) => {
    if (error !== null) authentication.dispose()
  })
  const send = (message: object): Promise<void> => new Promise((resolve, reject) => {
    if (!process.connected || process.send === undefined) { resolve(); return }
    process.send(message, (error) => { if (error === null) resolve(); else reject(error) })
  })
  let secret: string
  try {
    secret = await authentication.secret
    authentication.signal.throwIfAborted()
  } catch (error) {
    if (!(error instanceof DesktopAuthenticationEnd)) throw error
    if (error.kind === 'shutdown') await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
    return
  }
  const runtimeDir = process.argv[2] as string
  const projectDir = process.argv[3] as string
  const patchFiles: string[] = []
  if (process.env.DSH_NIMI_TEXT === '1') {
    const documentsDirectory = process.env.DSH_HOME
    if (!documentsDirectory) throw new Error('Nimi DSH requires an account-scoped home.')
    const patchPath = join(projectDir, 'nimi-desktop.patch.yml')
    const browserExecutable = process.env.DSH_NIMI_BROWSER_EXECUTABLE
    // A new managed registration creates its default workspace inside its own home.
    await writeFile(patchPath, JSON.stringify([
      { id: 'agent-default-model', config: { provider: 'nimi', model: 'configured' } },
      { id: 'workspace-controller', config: { documentsDirectory } },
      { id: 'llm-deepseek', disabled: true },
      { id: 'llm-deepseek-account', disabled: true },
      { id: 'llm-pi-ai', disabled: true },
      // Nimi's profile keeps local session export. Upstream feedback, accounts,
      // branding, DeepSeek web search/API, and product analytics are disabled.
      ...['session-telemetry-otel', 'desktop-product-telemetry', 'product-analytics',
        'ui-settings-session-log', 'ui-message-feedback', 'message-feedback', 'command-feedback',
        'ui-settings-account', 'ui-account-notifications', 'ui-settings-models',
        'ui-brand-official', 'deepseek-account', 'session-log-deepseek',
        'plugin-package-inventory-deepseek', 'web-search-deepseek', 'web-deepseek-api',
        'ui-settings-web-search',
      ].map(id => ({ id, disabled: true })),
      ...(browserExecutable ? [{ insert: [
        { id: 'nimi-browser-use', name: '@deepseek-ai/dsh-browser-use' },
        { id: 'nimi-browser-playwright', name: '@deepseek-ai/dsh-experimental-browser-use-playwright-mcp',
          config: { mode: 'launch', headless: true, executablePath: browserExecutable } },
      ] }] : []),
    ]))
    patchFiles.push(patchPath)
  }
  // Set before the launch-environment snapshot and profile evaluation; empty means the payload sits beside the runtime directory.
  process.env.DSH_PRIMARY_RUNTIME = process.argv[4] || join(runtimeDir, '..', 'runtime', 'primary-runtime')
  const installAnchor = join(runtimeDir, 'node_modules', '@deepseek-ai', 'dsh', 'package.json')
  const profile = loadProfileDirectory('dsh', projectDir, installAnchor)
  reportSkippedBundles('dsh', profile)
  const application = runProfile({
    environment: loadLayeredEnv('dsh'),
    profile: 'desktop',
    resolvedProfile: { profile, installAnchor },
    patchFiles,
    args: ['--no-open', '--host', '127.0.0.1', '--port', '0'],
    ...(process.argv[5] === undefined ? {} : {
      packageManager: {
        command: process.execPath,
        args: ['--expose-internals', process.argv[5]],
        env: {
          ELECTRON_RUN_AS_NODE: '1',
          DSH_DESKTOP_NODE_EXECUTABLE: process.execPath,
          PATH: `${process.argv[6] ?? ''}${delimiter}${process.env.PATH ?? ''}`,
        },
      },
    }),
  })
  let stopping: Promise<void> | undefined
  const dragReads = new Map<number, AbortController>()
  const dragTasks = new Set<Promise<void>>()
  const control: {
    bootInjections?: () => readonly unknown[]
    refreshNimiModels?: () => void
    adoptNimiRevision?: (configRef?: string) => void
    updateTasks?: ReturnType<typeof installDesktopUpdateTaskControl>
    quitInspection?: ReturnType<typeof installDesktopQuitInspection>
  } = {}
  const stop = (): Promise<void> => stopping ??= (async () => {
    for (const abort of dragReads.values()) abort.abort()
    await Promise.allSettled(dragTasks)
    // Startup failure is reported by main; shutdown only owns a tree that booted.
    const running = await application.catch(() => undefined)
    await running?.shutdown.shutdown(0)
    await send({ type: 'shutdown-complete' })
    if (process.connected) process.disconnect()
    // A handle a disposed plugin left open would otherwise keep the Host alive past the shell's graceful
    // deadline; a startup failure keeps its own diagnostic exit.
    if (running !== undefined) process.exit()
  })()
  process.on('message', (message: unknown) => {
    if (typeof message !== 'object' || message === null || !('type' in message)) return
    if (message.type === 'nimi-models-refresh') { control.refreshNimiModels?.(); return }
    if (message.type === 'nimi-adopt-revision') {
      const configRef = 'configRef' in message && typeof message.configRef === 'string' ? message.configRef : undefined
      control.adoptNimiRevision?.(configRef)
      return
    }
    if (message.type === 'boot-injections' && 'requestId' in message && Number.isSafeInteger(message.requestId)) {
      const requestId = message.requestId
      void (async () => {
        try {
          if (stopping || !control.bootInjections) throw new Error('Desktop workspace is unavailable')
          await send({ type: 'boot-injections', requestId, injections: control.bootInjections() })
        } catch (error) {
          await send({ type: 'boot-injections', requestId, error: error instanceof Error ? error.message : 'Desktop workspace is unavailable' })
        }
      })().catch((error: unknown) => { console.error(error) })
      return
    }
    if (message.type === 'shutdown') { void stop(); return }
    if (message.type === 'file-drag-cancel') {
      if ('requestId' in message && typeof message.requestId === 'number') dragReads.get(message.requestId)?.abort()
      return
    }
    if (message.type === 'file-drag-resource') {
      if (!('requestId' in message) || typeof message.requestId !== 'number' || !Number.isSafeInteger(message.requestId)
        || !('address' in message) || typeof message.address !== 'string') return
      const { requestId, address } = message
      const abort = new AbortController()
      dragReads.set(requestId, abort)
      const task = (async () => {
        try {
          if (stopping !== undefined) throw new Error('Host stopping')
          const { ctx } = await application
          const resource = await localDragResource(ctx, address, abort.signal)
          await send({ type: 'file-drag-resource', requestId, resource })
        } catch (error) {
          if (!abort.signal.aborted) console.error(error)
          await send({ type: 'file-drag-resource', requestId, resource: null, error: 'File drag resource unavailable' })
        } finally { dragReads.delete(requestId) }
      })().catch((error: unknown) => { console.error(error) })
      dragTasks.add(task)
      void task.finally(() => { dragTasks.delete(task) })
      return
    }
    if (message.type === 'quit-inspection') {
      if (!('requestId' in message) || !Number.isSafeInteger(message.requestId)) return
      const requestId = message.requestId
      void (async () => {
        try {
          if (stopping !== undefined || control.quitInspection === undefined) throw new Error('desktop quit: Host is unavailable')
          const inspection = await control.quitInspection()
          await send({ type: 'quit-inspection', requestId, ...inspection })
        } catch (error) {
          // The shell treats an unknown state as interruptible work and asks before quitting.
          await send({ type: 'quit-inspection', requestId, activeTasks: true, scheduledTasks: false,
            error: error instanceof Error ? error.message : String(error) })
        }
      })().catch((error: unknown) => { console.error(error) })
      return
    }
    if (message.type !== 'update-tasks' || !('requestId' in message) || !Number.isSafeInteger(message.requestId)
      || !('action' in message) || !['inspect', 'lock', 'unlock'].includes(String(message.action))) return
    void (async () => {
      try {
        if (stopping !== undefined || control.updateTasks === undefined) throw new Error('desktop update: Host is unavailable')
        const active = await control.updateTasks(message.action as 'inspect' | 'lock' | 'unlock')
        await send({ type: 'update-tasks', requestId: message.requestId, active })
      } catch (error) {
        await send({ type: 'update-tasks', requestId: message.requestId, active: true,
          error: error instanceof Error ? error.message : String(error) })
      }
    })().catch((error: unknown) => { console.error(error) })
  })
  const onAuthenticationEnd = (): void => { void stop() }
  authentication.signal.addEventListener('abort', onAuthenticationEnd, { once: true })
  if (authentication.signal.aborted) onAuthenticationEnd()
  process.once('disconnect', () => { void stop() })
  const { ctx } = await application
  if (process.env.DSH_NIMI_TEXT === '1') {
    let syncInFlight: Promise<void> | undefined
    let registeredProviders: string[] = ['nimi', NIMI_LOCAL_PROVIDER_ID]
    const syncNimiProviders = (): Promise<void> => {
      syncInFlight ??= (async () => {
        try {
          await nimiAdapter.refreshRoutes(undefined, true)
          const nextProviders = nimiAdapter.providerIds()
          const changed = nextProviders.length !== registeredProviders.length
            || nextProviders.some((id, idx) => id !== registeredProviders[idx])
          if (changed) {
            registeredProviders = nextProviders
            registration.replace(nextProviders)
          } else {
            for (const provider of registeredProviders) ctx.emit('llm/models-updated', provider)
          }
        } catch {
          for (const provider of registeredProviders) ctx.emit('llm/models-updated', provider)
        } finally {
          syncInFlight = undefined
        }
      })()
      return syncInFlight
    }
    const nimiAdapter = new NimiModelAdapter({
      provider: 'nimi', id: 'configured', name: 'Nimi Home model',
    }, streamNimiText, async (ref, signal) => {
      const image = await ctx.attachments.readImage(ref, signal)
      return uploadNimiImage(image.data, image.ref.mediaType, signal)
    }, readNimiModelInfo, listNimiModels, {
      listRoutes: listNimiRoutes,
      ensureRouteConfig: ensureNimiRouteConfig,
      onCatalogChanged: () => { void syncNimiProviders() },
    })
    const registration = ctx.llm.registerAdapter(registeredProviders, nimiAdapter)
    control.refreshNimiModels = () => { void syncNimiProviders() }
    control.adoptNimiRevision = (configRef) => {
      nimiAdapter.adoptLatestRevision(configRef)
      void syncNimiProviders()
    }
    await syncNimiProviders().catch(() => undefined)
    const ecosystem = installNimiEcosystemPlugin(ctx)
    ctx.effect(() => () => { ecosystem.dispose() }, 'desktop-host: nimi ecosystem plugin')
  }
  const canPublish = (): boolean => stopping === undefined && process.connected && !authentication.signal.aborted
  if (!canPublish()) return
  ctx.effect(() => () => {
    authentication.signal.removeEventListener('abort', onAuthenticationEnd)
    authentication.dispose()
  }, 'desktop-host: authentication channel')
  installOperationDiagnostics(ctx, record => send({ type: 'plugin-operation', record }), 32, runId)
  control.updateTasks = installDesktopUpdateTaskControl(ctx)
  control.quitInspection = installDesktopQuitInspection(ctx)
  installPlatformSessionPublisher(ctx, (session) => {
    if (process.connected) process.send?.({ type: 'platform-session', session })
  })
  await ctx.plugin(DesktopAuthentication, { readSecret: () => secret }).await()
  if (!canPublish()) return
  const url = `${ctx.webServer.protocol}//127.0.0.1:${String(ctx.webServer.port)}/`
  control.bootInjections = () => {
    const admission = ctx.connection.authentication.authenticate({ headers: { cookie: `dsh-desktop-session=${secret}` } })
    if ('rejection' in admission) throw new Error('Desktop authentication provider did not admit the workspace')
    return ctx.webServer.collectIndexInjections(admission.peer)
  }
  const injections = control.bootInjections()
  if (!canPublish()) return
  process.send?.({ type: 'ready', url, injections }, (error) => { if (error !== null) console.error(error) })
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    // The shell receives the complete inspected error here, not through stderr:
    // stderr bytes and this IPC message race, and the shell reports the first
    // failure it sees.
    const diagnostic = formatFatalDiagnostic(error)
    if (process.connected) process.send?.({ type: 'fatal', message, diagnostic }, (error) => { if (error !== null) console.error(error) })
    console.error(error)
    process.exitCode = 1
    if (process.connected) process.disconnect()
  })
}
