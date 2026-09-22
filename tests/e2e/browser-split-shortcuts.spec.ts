import { createServer } from 'node:http'
import { expect, test } from './helpers/orca-app'
import type { Page } from '@stablyai/playwright-test'
import { focusActiveTerminalInput } from './helpers/terminal'
import { ensureTerminalVisible, waitForActiveWorktree, waitForSessionReady } from './helpers/store'

const modifier = process.platform === 'darwin' ? 'Meta' : 'Control'
const guestModifier: 'meta' | 'control' = process.platform === 'darwin' ? 'meta' : 'control'

type TerminalBrowserSplitFixture = {
  browserGroupId: string
  browserTabId: string
  terminalGroupId: string
}

type BrowserSplitFixture = {
  firstBrowserGroupId: string
  firstBrowserPageId: string
  firstBrowserTabId: string
  secondBrowserGroupId: string
  secondBrowserPageId: string
  secondBrowserTabId: string
}

/** Preserves the active terminal beside a browser to test shortcuts across content types. */
async function createTerminalBrowserSplit(page: Page): Promise<TerminalBrowserSplitFixture> {
  return page.evaluate(() => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('Active worktree unavailable')
    }
    const terminalTabId = state.activeTabIdByWorktree[worktreeId] ?? state.activeTabId ?? undefined
    if (
      !terminalTabId ||
      !(state.tabsByWorktree[worktreeId] ?? []).some((tab) => tab.id === terminalTabId)
    ) {
      throw new Error('Active terminal tab unavailable')
    }
    const terminalGroupId = state.ensureWorktreeRootGroup(worktreeId)
    const browserGroupId = state.createEmptySplitGroup(worktreeId, terminalGroupId, 'right')
    if (!browserGroupId) {
      throw new Error('Browser split unavailable')
    }
    const browserTab = state.createBrowserTab(worktreeId, 'about:blank', {
      activate: true,
      focusAddressBar: false,
      targetGroupId: browserGroupId
    })
    const browserPageId = browserTab.activePageId
    if (!browserPageId) {
      throw new Error('Active browser page unavailable')
    }
    return {
      browserGroupId,
      browserTabId: browserTab.id,
      terminalGroupId
    }
  })
}

/** Seeds two browser splits; a served URL avoids the about:blank overlay during guest click tests. */
async function createBrowserSplit(page: Page, url = 'about:blank'): Promise<BrowserSplitFixture> {
  return page.evaluate((url) => {
    const store = window.__store
    if (!store) {
      throw new Error('Store unavailable')
    }
    const state = store.getState()
    const worktreeId = state.activeWorktreeId
    if (!worktreeId) {
      throw new Error('Active worktree unavailable')
    }
    const terminalGroupId = state.ensureWorktreeRootGroup(worktreeId)
    const firstBrowserGroupId = state.createEmptySplitGroup(worktreeId, terminalGroupId, 'right')
    if (!firstBrowserGroupId) {
      throw new Error('First browser split unavailable')
    }
    const firstBrowserTab = state.createBrowserTab(worktreeId, url, {
      activate: true,
      focusAddressBar: false,
      targetGroupId: firstBrowserGroupId
    })
    const secondBrowserGroupId = state.createEmptySplitGroup(
      worktreeId,
      firstBrowserGroupId,
      'right'
    )
    if (!secondBrowserGroupId) {
      throw new Error('Second browser split unavailable')
    }
    const secondBrowserTab = state.createBrowserTab(worktreeId, url, {
      activate: true,
      focusAddressBar: false,
      targetGroupId: secondBrowserGroupId
    })
    const [firstBrowserPageId, secondBrowserPageId] = [
      firstBrowserTab.activePageId,
      secondBrowserTab.activePageId
    ]
    if (!firstBrowserPageId || !secondBrowserPageId) {
      throw new Error('Active browser page unavailable')
    }
    return {
      firstBrowserGroupId,
      firstBrowserPageId,
      firstBrowserTabId: firstBrowserTab.id,
      secondBrowserGroupId,
      secondBrowserPageId,
      secondBrowserTabId: secondBrowserTab.id
    }
  }, url)
}

/** Scopes address-bar lookup to one overlay because both browser splits can be visible. */
function browserAddressBar(page: Page, browserTabId: string) {
  return page.locator(
    `[data-browser-overlay-tab-id="${browserTabId}"] [data-orca-browser-address-bar="true"]`
  )
}

/** Establishes host-renderer focus before testing a transition into a separate browser guest. */
async function focusBrowserAddressBar(page: Page, browserTabId: string): Promise<void> {
  const browserOverlay = page.locator(`[data-browser-overlay-tab-id="${browserTabId}"]`)
  const addressBar = browserAddressBar(page, browserTabId)
  const addressBarForm = browserOverlay.locator(
    'form:has(> [data-orca-browser-address-bar="true"])'
  )
  await expect(addressBarForm).toBeVisible()
  await addressBar.focus()
  await expect(addressBar).toBeFocused()
}

function browserFindInput(page: Page) {
  return page.getByPlaceholder('Find in page...')
}

function browserFindCloseButton(page: Page) {
  return browserFindInput(page).locator('xpath=..').getByTitle('Close')
}

function browserSplitFindInput(page: Page, browserTabId: string) {
  return page
    .locator(`[data-browser-overlay-tab-id="${browserTabId}"]`)
    .getByPlaceholder('Find in page...')
}

async function waitForBrowserGuestRegistration(
  page: Page,
  browserTabId: string,
  browserPageId: string
): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(
        async ({ targetBrowserPageId, targetBrowserTabId }) => {
          const overlay = document.querySelector(
            `[data-browser-overlay-tab-id="${targetBrowserTabId}"]`
          )
          const webview = overlay?.querySelector('webview') as Electron.WebviewTag | null
          try {
            if (!webview) {
              return false
            }
            const webContentsId = webview.getWebContentsId()
            const registered = await window.api.browser.isGuestRegistered({
              browserPageId: targetBrowserPageId,
              webContentsId
            })
            if (!registered) {
              return false
            }
            return true
          } catch {
            return false
          }
        },
        {
          targetBrowserPageId: browserPageId,
          targetBrowserTabId: browserTabId
        }
      )
    )
    .toBe(true)
}

async function pressFindInBrowserGuest(
  page: Page,
  browserTabId: string,
  browserPageId: string
): Promise<void> {
  await waitForBrowserGuestRegistration(page, browserTabId, browserPageId)
  await page.evaluate(
    async ({ targetBrowserTabId, inputModifier }) => {
      const overlay = document.querySelector(
        `[data-browser-overlay-tab-id="${targetBrowserTabId}"]`
      )
      const webview = overlay?.querySelector('webview') as Electron.WebviewTag | null
      if (!webview) {
        throw new Error('Registered browser guest unavailable')
      }
      webview.focus()
      await webview.sendInputEvent({
        type: 'keyDown',
        keyCode: 'F',
        modifiers: [inputModifier]
      })
      await webview.sendInputEvent({
        type: 'keyUp',
        keyCode: 'F',
        modifiers: [inputModifier]
      })
    },
    { targetBrowserTabId: browserTabId, inputModifier: guestModifier }
  )
}

function terminalFindInput(page: Page) {
  return page.locator('[data-terminal-search-root] input:visible')
}

async function waitForFocusedGroup(page: Page, groupId: string): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const state = window.__store?.getState()
        const worktreeId = state?.activeWorktreeId
        return worktreeId ? state.activeGroupIdByWorktree[worktreeId] : null
      })
    )
    .toBe(groupId)
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
      })
  )
}

async function focusBrowserGroup(page: Page, groupId: string): Promise<void> {
  await page.evaluate((targetGroupId) => {
    const state = window.__store?.getState()
    const worktreeId = state?.activeWorktreeId
    if (state && worktreeId) {
      state.focusGroup(worktreeId, targetGroupId)
    }
  }, groupId)
  await waitForFocusedGroup(page, groupId)
}

test.describe('browser split shortcuts', () => {
  test.beforeEach(async ({ orcaPage }) => {
    await waitForSessionReady(orcaPage)
    await waitForActiveWorktree(orcaPage)
    await orcaPage.evaluate(() => window.__store!.getState().updateSettings({ uiLanguage: 'en' }))
    await ensureTerminalVisible(orcaPage)
  })

  test('routes repeated Find shortcuts to the focused terminal or browser split', async ({
    orcaPage
  }) => {
    const fixture = await createTerminalBrowserSplit(orcaPage)

    await orcaPage.evaluate(({ terminalGroupId }) => {
      const state = window.__store?.getState()
      const worktreeId = state?.activeWorktreeId
      if (state && worktreeId) {
        state.focusGroup(worktreeId, terminalGroupId)
      }
    }, fixture)
    await focusActiveTerminalInput(orcaPage)
    await waitForFocusedGroup(orcaPage, fixture.terminalGroupId)
    await orcaPage.keyboard.press(`${modifier}+f`)
    await expect(terminalFindInput(orcaPage)).toBeFocused()
    await expect(browserFindInput(orcaPage)).toBeHidden()
    await orcaPage.keyboard.press('Escape')

    await focusBrowserGroup(orcaPage, fixture.browserGroupId)
    await focusBrowserAddressBar(orcaPage, fixture.browserTabId)
    await orcaPage.keyboard.press(`${modifier}+f`)
    await expect(browserFindInput(orcaPage)).toBeFocused()
    await expect(terminalFindInput(orcaPage)).toBeHidden()
    await browserFindCloseButton(orcaPage).click()
    await expect(browserFindInput(orcaPage)).toBeHidden()

    await orcaPage.keyboard.press(`${modifier}+f`)
    await expect(browserFindInput(orcaPage)).toBeFocused()
    await browserFindCloseButton(orcaPage).click()

    await orcaPage.evaluate(({ browserTabId }) => {
      window.__store?.getState().closeBrowserTab(browserTabId)
    }, fixture)
    await expect(
      orcaPage.locator(`[data-browser-overlay-tab-id="${fixture.browserTabId}"]`)
    ).toHaveCount(0)

    await focusActiveTerminalInput(orcaPage)
    await orcaPage.keyboard.press(`${modifier}+f`)
    await expect(terminalFindInput(orcaPage)).toBeFocused()
    await expect(browserFindInput(orcaPage)).toBeHidden()
  })

  test('opens Find only in the browser split whose guest owns the shortcut', async ({
    orcaPage
  }) => {
    const fixture = await createBrowserSplit(orcaPage)

    await pressFindInBrowserGuest(orcaPage, fixture.firstBrowserTabId, fixture.firstBrowserPageId)

    await expect(browserSplitFindInput(orcaPage, fixture.firstBrowserTabId)).toBeVisible()
    await expect(browserSplitFindInput(orcaPage, fixture.secondBrowserTabId)).toBeHidden()
    await expect
      .poll(() =>
        orcaPage.evaluate(
          ({ browserPageId, browserTabId }) =>
            window.__store
              ?.getState()
              .browserPagesByWorkspace[browserTabId]?.find((page) => page.id === browserPageId)
              ?.loadError?.code ?? null,
          {
            browserPageId: fixture.firstBrowserPageId,
            browserTabId: fixture.firstBrowserTabId
          }
        )
      )
      .toBeNull()
  })

  test('routes guest clicks and Ctrl+Tab to the owning split', async ({
    orcaPage,
    electronApp
  }) => {
    const server = createServer((_request, response) => {
      response.setHeader('Content-Type', 'text/html')
      response.end(
        '<title>Split focus fixture</title><input id="target" autofocus><script>document.addEventListener("mousedown", () => document.body.dataset.clicked = "true")</script>'
      )
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    try {
      const address = server.address()
      if (!address || typeof address === 'string') {
        throw new Error('HTTP fixture unavailable')
      }
      const url = `http://127.0.0.1:${address.port}/`
      const fixture = await createBrowserSplit(orcaPage, url)
      const previous = await orcaPage.evaluate(
        ({ fixture, url }) => {
          const state = window.__store!.getState()
          const worktreeId = state.activeWorktreeId!
          const groups = [fixture.firstBrowserGroupId, fixture.secondBrowserGroupId]
          const originals = [fixture.firstBrowserTabId, fixture.secondBrowserTabId]
          const previous = groups.map(
            (targetGroupId) =>
              state.createBrowserTab(worktreeId, url, {
                activate: true,
                focusAddressBar: false,
                targetGroupId
              }).id
          )
          const tabs = window.__store!.getState().unifiedTabsByWorktree[worktreeId]
          for (const id of originals) {
            state.activateTab(tabs.find((t) => t.entityId === id)!.id)
          }
          return previous
        },
        { fixture, url }
      )
      const guestIds: number[] = []
      for (const [tabId, pageId] of [
        [fixture.firstBrowserTabId, fixture.firstBrowserPageId],
        [fixture.secondBrowserTabId, fixture.secondBrowserPageId]
      ]) {
        await waitForBrowserGuestRegistration(orcaPage, tabId, pageId)
        const guest = orcaPage.locator(`[data-browser-overlay-tab-id="${tabId}"] webview`)
        await expect
          .poll(() =>
            guest.evaluate((element) => {
              // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: locator selects Electron's webview element.
              return (element as Electron.WebviewTag).executeJavaScript('document.title')
            })
          )
          .toBe('Split focus fixture')
        guestIds.push(
          await guest.evaluate((element) => {
            // oxlint-disable-next-line typescript/consistent-type-assertions -- SAFETY: locator selects Electron's webview element.
            return (element as Electron.WebviewTag).getWebContentsId()
          })
        )
      }
      /** Pane actions render only in the focused split, providing a visible ownership signal. */
      const focusedControls = (groupId: string) =>
        orcaPage.locator(
          `[data-tab-group-strip-id="${groupId}"] button[aria-haspopup="menu"][data-slot="tooltip-trigger"]`
        )
      await focusBrowserAddressBar(orcaPage, fixture.firstBrowserTabId)
      for (const index of [1, 0, 1, 0]) {
        await electronApp.evaluate(({ webContents }, guestId) => {
          const guest = webContents.fromId(guestId)
          if (!guest) {
            throw new Error('Browser guest unavailable')
          }
          guest.sendInputEvent({ type: 'mouseDown', x: 20, y: 15, button: 'left', clickCount: 1 })
          guest.sendInputEvent({ type: 'mouseUp', x: 20, y: 15, button: 'left', clickCount: 1 })
        }, guestIds[index])
        const groupId = index === 0 ? fixture.firstBrowserGroupId : fixture.secondBrowserGroupId
        const otherId = index === 0 ? fixture.secondBrowserGroupId : fixture.firstBrowserGroupId
        await expect(focusedControls(groupId)).toBeVisible()
        await expect(focusedControls(otherId)).toHaveCount(0)
        await expect
          .poll(() =>
            electronApp.evaluate(
              ({ webContents }, id) =>
                webContents.fromId(id)?.executeJavaScript('document.body.dataset.clicked'),
              guestIds[index]
            )
          )
          .toBe('true')
      }
      await electronApp.evaluate(({ webContents }, id) => {
        const guest = webContents.fromId(id)
        if (!guest) {
          throw new Error('Browser guest unavailable')
        }
        guest.sendInputEvent({ type: 'keyDown', keyCode: 'Tab', modifiers: ['control'] })
        guest.sendInputEvent({ type: 'keyUp', keyCode: 'Control' })
      }, guestIds[0])
      await expect(orcaPage.locator(`[data-tab-id="${previous[0]}"]`)).toHaveAttribute(
        'data-active',
        'true'
      )
      await expect(
        orcaPage.locator(`[data-tab-id="${fixture.secondBrowserTabId}"]`)
      ).toHaveAttribute('data-active', 'true')
      await expect(orcaPage.locator(`[data-tab-id="${previous[1]}"]`)).toHaveAttribute(
        'data-active',
        'false'
      )
    } finally {
      server.closeAllConnections()
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve()))
      )
    }
  })

  test('keeps browser Find available when split focus state is temporarily missing', async ({
    orcaPage
  }) => {
    const fixture = await createTerminalBrowserSplit(orcaPage)
    await focusBrowserGroup(orcaPage, fixture.browserGroupId)
    const addressBar = browserAddressBar(orcaPage, fixture.browserTabId)
    await focusBrowserAddressBar(orcaPage, fixture.browserTabId)

    await orcaPage.evaluate(() => {
      const store = window.__store
      const worktreeId = store?.getState().activeWorktreeId
      if (!store || !worktreeId) {
        throw new Error('Active worktree unavailable')
      }
      store.setState((state) => {
        const activeGroupIdByWorktree = { ...state.activeGroupIdByWorktree }
        delete activeGroupIdByWorktree[worktreeId]
        return { activeGroupIdByWorktree }
      })
    })
    await expect(addressBar).toBeFocused()

    await orcaPage.keyboard.press(`${modifier}+f`)
    await expect(browserFindInput(orcaPage)).toBeFocused()
    await expect(terminalFindInput(orcaPage)).toBeHidden()
  })

  test('keeps browser Find available when the focused split ID is stale', async ({ orcaPage }) => {
    const fixture = await createTerminalBrowserSplit(orcaPage)
    await focusBrowserGroup(orcaPage, fixture.browserGroupId)
    const addressBar = browserAddressBar(orcaPage, fixture.browserTabId)
    await focusBrowserAddressBar(orcaPage, fixture.browserTabId)

    await orcaPage.evaluate(() => {
      const store = window.__store
      const worktreeId = store?.getState().activeWorktreeId
      if (!store || !worktreeId) {
        throw new Error('Active worktree unavailable')
      }
      store.setState((state) => ({
        activeGroupIdByWorktree: {
          ...state.activeGroupIdByWorktree,
          [worktreeId]: 'removed-group'
        }
      }))
    })
    await expect(addressBar).toBeFocused()

    await orcaPage.keyboard.press(`${modifier}+f`)
    await expect(browserFindInput(orcaPage)).toBeFocused()
    await expect(terminalFindInput(orcaPage)).toBeHidden()
  })
})
