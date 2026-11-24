// Regression tests for window-focus attribution. Production sources under
// src/background (helpers.ts, heartbeat.ts, main.ts) are transpiled with
// TypeScript into a temporary directory and run unmodified; the browser,
// storage, client, consent, config and aw-client modules are replaced with
// in-memory stubs. The browser stub models multiple windows: tabs.query with
// currentWindow: true only returns tabs of the focused window.
//
// Run with: node --test tests/window-focus.test.mjs
import { after, afterEach, beforeEach, mock, test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import ts from 'typescript'

const SRC_DIR = fileURLToPath(new URL('../src/background/', import.meta.url))
const require = createRequire(import.meta.url)

const STUB_BROWSER = `
export const state = { tabs: [], focusedWindowId: undefined }
export const listeners = {}
const event = (name) => {
  listeners[name] = []
  return { addListener: (fn) => listeners[name].push(fn) }
}
const browser = {
  tabs: {
    get: async (id) => {
      const tab = state.tabs.find((t) => t.id === id)
      if (!tab) throw new Error('No tab with id ' + id)
      return tab
    },
    query: async (query = {}) =>
      state.tabs.filter(
        (t) =>
          (!query.active || t.active) &&
          (!query.currentWindow || t.windowId === state.focusedWindowId),
      ),
    create: async () => ({}),
    onActivated: event('tabs.onActivated'),
    onUpdated: event('tabs.onUpdated'),
  },
  windows: {
    WINDOW_ID_NONE: -1,
    getLastFocused: async () => ({ id: state.focusedWindowId, focused: true }),
    get: async (id) => ({ id, focused: id === state.focusedWindowId }),
    onFocusChanged: event('windows.onFocusChanged'),
  },
  alarms: {
    create: () => {},
    onAlarm: event('alarms.onAlarm'),
  },
  runtime: {
    getURL: (path) => path,
    onInstalled: event('runtime.onInstalled'),
    onStartup: event('runtime.onStartup'),
    onMessage: event('runtime.onMessage'),
  },
  storage: {
    managed: { get: async () => ({}) },
    local: { get: async () => ({}) },
  },
  notifications: { create: () => {} },
}
export default browser
`

const STUB_STORAGE = `
export const state = {
  enabled: true,
  profile: undefined,
  heartbeatData: undefined,
  browserName: 'chrome',
  browserNameUserSelected: false,
}
export const getEnabled = async () => state.enabled
export const getProfileName = async () => state.profile
export const getHeartbeatData = async () => state.heartbeatData
export const setHeartbeatData = async (data) => {
  state.heartbeatData = data
}
export const getBrowserName = async () => state.browserName
export const getBrowserNameUserSelected = async () => state.browserNameUserSelected
export const setBrowserName = async (name) => {
  state.browserName = name
}
export const getConsentStatus = async () => ({ consent: true, required: false })
export const getHostname = async () => 'host'
export const setBaseUrl = async () => {}
export const setConsentStatus = async () => {}
export const setEnabled = async () => {}
export const setHostname = async () => {}
export const waitForEnabled = async () => {}
`

const STUB_CLIENT = `
export const sent = []
export const getBucketId = async () => 'bucket'
export const sendHeartbeat = async (client, bucketId, timestamp, data, pulsetime) => {
  sent.push({ timestamp, data: structuredClone(data), pulsetime })
}
export const getClient = () => ({ baseURL: 'http://127.0.0.1:5600' })
export const detectHostname = async () => 'host'
export const loadApiKey = async () => {}
`

const STUB_CONSENT = `
export const getIsConsentRequired = async () => false
export const installAction = () => 'enable'
`

const STUB_CONFIG = `
export default { requireConsent: false, heartbeat: { alarmName: 'heartbeat', intervalInSeconds: 60 } }
`

const STUB_AW_CLIENT = `
export class FetchError extends Error {}
`

// Production import specifier -> specifier to use in the transpiled fixture.
const MODULE_MAP = {
    'webextension-polyfill': './stub-browser.mjs',
    'aw-client': './stub-aw-client.mjs',
    '../config': './stub-config.mjs',
    './client': './stub-client.mjs',
    './consent': './stub-consent.mjs',
    '../storage': './stub-storage.mjs',
    './helpers': './helpers.mjs',
    './heartbeat': './heartbeat.mjs',
    'deep-equal': pathToFileURL(require.resolve('deep-equal')).href,
    'punycode.js': pathToFileURL(require.resolve('punycode.js')).href,
}

function transpile(source, fileName) {
    return ts.transpileModule(source, {
        fileName,
        compilerOptions: {
            target: ts.ScriptTarget.ES2022,
            module: ts.ModuleKind.ESNext,
            isolatedModules: true,
        },
    }).outputText
}

function rewriteImports(js) {
    return js.replace(
        /(\bfrom\s+|\bimport\s+)(['"])([^'"]+)\2/g,
        (_, kw, q, spec) => {
            if (!(spec in MODULE_MAP)) {
                throw new Error(`Unmapped import in production code: ${spec}`)
            }
            return `${kw}${q}${MODULE_MAP[spec]}${q}`
        },
    )
}

async function loadFixture() {
    const dir = await mkdtemp(join(tmpdir(), 'aw-window-focus-'))
    const cleanup = () => rm(dir, { recursive: true, force: true })
    try {
        const stubs = {
            'stub-browser.mjs': STUB_BROWSER,
            'stub-storage.mjs': STUB_STORAGE,
            'stub-client.mjs': STUB_CLIENT,
            'stub-consent.mjs': STUB_CONSENT,
            'stub-config.mjs': STUB_CONFIG,
            'stub-aw-client.mjs': STUB_AW_CLIENT,
        }
        for (const [name, source] of Object.entries(stubs)) {
            await writeFile(join(dir, name), source)
        }
        for (const name of ['helpers', 'heartbeat', 'main']) {
            const source = await readFile(join(SRC_DIR, `${name}.ts`), 'utf8')
            const js = rewriteImports(transpile(source, `${name}.ts`))
            await writeFile(join(dir, `${name}.mjs`), js)
        }
        const load = (name) => import(pathToFileURL(join(dir, name)).href)
        return {
            cleanup,
            // main.mjs is loaded lazily: importing it registers listeners and
            // sends the initial heartbeat as a side effect.
            loadMain: () => load('main.mjs'),
            heartbeat: await load('heartbeat.mjs'),
            browser: await load('stub-browser.mjs'),
            storage: await load('stub-storage.mjs'),
            client: await load('stub-client.mjs'),
        }
    } catch (error) {
        await cleanup()
        throw error
    }
}

const fixture = await loadFixture()
const { heartbeat, browser, storage, client } = fixture
after(() => fixture.cleanup())

const CLIENT = {}
const URL_A = 'https://a.test/'
const URL_B = 'https://b.test/'
const URL_X = 'https://x.test/'

function makeTab(id, windowId, url, active) {
    return {
        id,
        windowId,
        active,
        url,
        title: url,
        audible: false,
        incognito: false,
        groupId: -1,
    }
}

async function settle() {
    for (let i = 0; i < 20; i++) {
        await new Promise((resolve) => setImmediate(resolve))
    }
}

async function fire(name, ...args) {
    await Promise.all((browser.listeners[name] ?? []).map((fn) => fn(...args)))
    await settle()
}

beforeEach(() => {
    mock.method(console, 'debug', () => {})
    mock.method(console, 'info', () => {})
    mock.method(console, 'warn', () => {})
    mock.method(console, 'error', () => {})
    client.sent.length = 0
    Object.assign(storage.state, {
        enabled: true,
        profile: undefined,
        heartbeatData: undefined,
    })
    browser.state.tabs = []
    browser.state.focusedWindowId = undefined
})

afterEach(() => {
    mock.restoreAll()
    mock.timers.reset()
})

test('(b) activating a tab in an unfocused window is not recorded as the current tab', async () => {
    // Window 1 (focused) shows tab A; window 2 (background) shows tab B and
    // also has tab X.
    const a = makeTab(1, 1, URL_A, true)
    const b = makeTab(2, 2, URL_B, true)
    const x = makeTab(3, 2, URL_X, false)
    browser.state.tabs = [a, b, x]
    browser.state.focusedWindowId = 1

    await heartbeat.sendInitialHeartbeat(CLIENT)
    assert.deepEqual(
        client.sent.map((e) => e.data.url),
        [URL_A],
    )

    // Tab B closes itself in the background window; Chrome/Firefox then fire
    // tabs.onActivated for X in window 2 while window 1 stays focused.
    browser.state.tabs = [a, x]
    x.active = true
    await heartbeat.tabActivatedListener(CLIENT)({
        tabId: x.id,
        windowId: 2,
        previousTabId: b.id,
    })

    assert.deepEqual(
        client.sent.filter((e) => e.data.url === URL_X).map((e) => e.data.url),
        [],
        'a tab activated in an unfocused window must not be sent as a heartbeat',
    )
    assert.equal(storage.state.heartbeatData.url, URL_A)
})

test('(a) switching focus to another window stops attributing time to the previous window', async () => {
    mock.timers.enable({ apis: ['Date'], now: 0 })

    // Window 1 (focused) shows tab A; window 2 shows tab B.
    browser.state.tabs = [
        makeTab(1, 1, URL_A, true),
        makeTab(2, 2, URL_B, true),
    ]
    browser.state.focusedWindowId = 1

    await fixture.loadMain()
    await settle()
    assert.deepEqual(
        client.sent.map((e) => [e.data.url, e.timestamp.getTime()]),
        [[URL_A, 0]],
        'initial heartbeat for A at t=0',
    )

    // t=10s: the user focuses window 2 without changing tabs. No tab event
    // fires; only windows.onFocusChanged does.
    mock.timers.setTime(10_000)
    browser.state.focusedWindowId = 2
    await fire('windows.onFocusChanged', 2)

    // t=60s: the periodic heartbeat alarm fires.
    mock.timers.setTime(60_000)
    await fire('alarms.onAlarm', { name: 'heartbeat' })

    const aAfterSwitch = client.sent
        .filter((e) => e.data.url === URL_A && e.timestamp.getTime() > 10_000)
        .map((e) => ({
            url: e.data.url,
            t: e.timestamp.getTime(),
            pulsetime: e.pulsetime,
        }))
    assert.deepEqual(
        aAfterSwitch,
        [],
        'tab A (window 1) must not receive heartbeats after focus moved to window 2 at t=10s',
    )
    const bAt = client.sent
        .filter((e) => e.data.url === URL_B)
        .map((e) => e.timestamp.getTime())
    assert.ok(
        bAt.length > 0 && bAt[0] <= 10_000,
        `tab B should be recorded from the focus switch at t=10s, got ${JSON.stringify(bAt)}`,
    )
})
