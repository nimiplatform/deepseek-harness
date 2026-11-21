import { readFile } from 'node:fs/promises'

const resources = JSON.parse(await readFile(new URL('./dsh-dev-resources.json', import.meta.url), 'utf8'))
process.env.DSH_DESKTOP_DSH_DIR = resources.projectDir
process.env.DSH_DESKTOP_PRIMARY_RUNTIME_DIR = resources.primaryRuntime
process.env.DSH_NIMI_DEV_WORKER_EXECUTABLE = resources.workerExecutable
if (resources.browserExecutable) process.env.DSH_NIMI_BROWSER_EXECUTABLE = resources.browserExecutable
await import('../../apps/desktop/lib/main.js')
