/** A cold-seeded user message that carries a credential draws it masked behind its reveal control. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, compareOrRefreshGolden, fixtureUserPrompts,
  launchWebScaffold, seedSession, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('../../../snapshots/web/user-text-secret-mask', import.meta.url))
// Borrowed read-only: this scenario needs any settled user message, not a new recording.
const SEED = fileURLToPath(new URL('../../../snapshots/web/seeded-history/session.v3.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const RECORDED_PROMPT = 'Use the read tool twice in one assistant message: read a.txt and b.txt. Then reply with the single word DONE and stop.'
// Assembled at run time so the repository holds no literal in a credential format.
const KEY = ['sk', '-', '0123456789abcdef0123456789abcdef'].join('')
const PROMPT = `${KEY} is the key for this task.`

describe('web e2e: credential mask in user text', () => {
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>

  beforeAll(async () => {
    scaffold = await launchWebScaffold({})
    const raw = (await readFile(SEED, 'utf8')).replace(RECORDED_PROMPT, PROMPT)
    expect(fixtureUserPrompts(raw), 'adapted seed must carry the credential prompt').toContain(PROMPT)
    await seedSession(scaffold, raw, 'user-text-secret-mask')
    browser = await chromium.launch()
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.locator('[role="treeitem"]').first().click()
    await page.locator('[role="treeitem"]').nth(1).click()
    await page.getByRole('button', { name: 'Show secret', exact: true }).waitFor()
  }, 120_000)

  afterAll(async () => {
    await browser?.close()
    await scaffold?.close()
  })

  it('keeps a wrapped password with wide and combining characters in the same space', async () => {
    const value = 'ab窗边🌿e\u0301'.repeat(18)
    const prompt = `Layout sample postgres://demo:${value}@example.invalid/receipt.`
    const id = 'user-text-wide-marks'
    const seed = (await readFile(SEED, 'utf8')).replace(RECORDED_PROMPT, prompt)
    await seedSession(scaffold, seed, id)
    const wide = await newEnglishPage(browser)
    try {
      await wide.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
      await wide.getByText('Ungrouped', { exact: true }).waitFor()
      await wide.getByRole('button', { name: 'Search sessions' }).click()
      await wide.getByRole('textbox', { name: 'Search session names' }).fill(id)
      await wide.getByRole('tree', { name: 'Search results' }).getByRole('treeitem').click()
      const run = wide.locator('[data-secret]')
      const bubble = wide.locator('[class*="bubble"]', { has: run })
      await run.waitFor()
      const geometry = async () => [await run.boundingBox(), await bubble.boundingBox(), await run.getByRole('button').boundingBox()]
      const initial = await geometry()
      expect(initial[0]!.height).toBeGreaterThan(initial[2]!.height * 2)
      expect(await bubble.textContent()).not.toContain(value)
      await run.getByRole('button', { name: 'Show secret' }).click()
      await expect.poll(() => bubble.textContent()).toBe(prompt)
      expect(await geometry()).toEqual(initial)
      await run.getByRole('button', { name: 'Hide secret' }).click()
      await expect.poll(() => bubble.textContent()).not.toContain(value)
      expect(await geometry()).toEqual(initial)
    } finally {
      await wide.context().close()
    }
  })

  it('masks the credential in the bubble and reveals it from its own control', async () => {
    onTestFailed(() => saveFailureShot(page, 'web-e2e-user-text-secret-mask'))
    const text = page.locator('[class*="bubble"]', { has: page.locator('[data-secret]') })
    await compareOrRefreshGolden(join(SNAPSHOT_DIR, 'bubble.expected.md'), await text.ariaSnapshot(), MODE)
    expect(await text.textContent()).not.toContain(KEY)
    const run = page.locator('[data-secret]')
    // The mask marks and the control share one vertical center.
    const centers = await run.evaluate((box) => {
      const middle = (element: Element): number => {
        const rect = element.getBoundingClientRect()
        return rect.top + rect.height / 2
      }
      const [value, control] = [...box.children]
      return { mask: middle(value!.lastElementChild!), control: middle(control!) }
    })
    expect(Math.abs(centers.control - centers.mask)).toBeLessThanOrEqual(1)
    const masked = { run: await run.boundingBox(), bubble: await text.boundingBox() }
    await page.getByRole('button', { name: 'Show secret', exact: true }).click()
    await expect.poll(() => text.textContent()).toBe(PROMPT)
    // The monospace run keeps one mask character per original character, so revealing does not move the line.
    expect({ run: await run.boundingBox(), bubble: await text.boundingBox() }).toEqual(masked)
    await page.getByRole('button', { name: 'Hide secret', exact: true }).click()
    await expect.poll(() => text.textContent()).not.toContain(KEY)
    expect(tripwire.pageErrors).toEqual([])
    expect(tripwire.warnings).toEqual([])
    await assertFixtureInventory(SNAPSHOT_DIR, ['bubble.expected.md'])
  })
})
