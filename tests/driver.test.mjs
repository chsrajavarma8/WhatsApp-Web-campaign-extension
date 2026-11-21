// WhatsApp driver tests: fast (no-reload) chat opening with automatic fallback.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createWhatsAppDriver } from '../whatsapp-tab.js';
import { DEFAULT_SETTINGS } from '../constants.js';

const WA = 'https://web.whatsapp.com/';

/** Fake chrome.tabs: one logged-in WhatsApp tab; a URL update = page reload. */
function makeChrome({ openChat }) {
  let pageId = 1;
  const calls = { reloads: 0, openChat: 0, prepare: 0, sendNow: 0 };
  const tab = { id: 7, active: true, url: WA };
  const chromeApi = {
    tabs: {
      query: async () => [tab],
      get: async (id) => (id === tab.id ? tab : Promise.reject(new Error('no tab'))),
      update: async (id, props) => {
        if (props.url) {
          calls.reloads++;
          pageId++;
        }
        return tab;
      },
      sendMessage: async (id, msg) => {
        switch (msg.type) {
          case 'WA_PING': return { ok: true, pageId, loginState: 'logged_in' };
          case 'WA_OPEN_CHAT': calls.openChat++; return openChat(calls.openChat);
          case 'WA_PREPARE': calls.prepare++; return { ok: true, verified: true };
          case 'WA_SEND_NOW': calls.sendNow++; return { ok: true };
          default: throw new Error(`unexpected ${msg.type}`);
        }
      },
    },
  };
  return { chromeApi, calls };
}

const send = (driver, settings = {}) =>
  driver.sendMessage({
    phone: '919876543210',
    message: 'Hi',
    settings: { ...DEFAULT_SETTINGS, delayBeforeSend: 0, ...settings },
    shouldContinue: () => true,
    wait: async () => true,
  });

const newDriver = (chromeApi) => createWhatsAppDriver({ chromeApi, sleep: async () => {}, isOnline: () => true });

test('fast mode opens the chat without reloading the page', async () => {
  const { chromeApi, calls } = makeChrome({ openChat: () => ({ ok: true, verified: true }) });
  const driver = newDriver(chromeApi);
  for (let i = 0; i < 3; i++) {
    const r = await send(driver);
    assert.equal(r.ok, true);
    assert.equal(r.method, 'fast');
  }
  assert.equal(calls.reloads, 0, 'no page reloads');
  assert.equal(calls.sendNow, 3);
});

test('falls back to reload for that contact when fast mode is not supported', async () => {
  const { chromeApi, calls } = makeChrome({ openChat: () => ({ ok: false, code: 'FAST_UNSUPPORTED', error: 'not handled' }) });
  const driver = newDriver(chromeApi);
  const r = await send(driver);
  assert.equal(r.ok, true);
  assert.equal(r.method, 'reload');
  assert.equal(calls.reloads, 1);
  assert.equal(calls.prepare, 1);
});

test('after 2 misses fast mode is skipped for the session; resetFastMode re-enables it', async () => {
  const { chromeApi, calls } = makeChrome({ openChat: () => ({ ok: false, code: 'FAST_UNSUPPORTED', error: 'x' }) });
  const driver = newDriver(chromeApi);
  await send(driver);
  await send(driver);
  await send(driver);
  await send(driver);
  assert.equal(calls.openChat, 2, 'stopped trying after 2 misses');
  assert.equal(calls.reloads, 4);
  driver.resetFastMode();
  await send(driver);
  assert.equal(calls.openChat, 3);
});

test('a real error from fast mode (number not on WhatsApp) is reported, not retried with reload', async () => {
  const { chromeApi, calls } = makeChrome({ openChat: () => ({ ok: false, code: 'INVALID_NUMBER', error: 'Number not on WhatsApp' }) });
  const driver = newDriver(chromeApi);
  const r = await send(driver);
  assert.equal(r.ok, false);
  assert.equal(r.code, 'INVALID_NUMBER');
  assert.equal(calls.reloads, 0);
  assert.equal(calls.sendNow, 0);
});

test('openMode "reload" always reloads and never tries fast mode', async () => {
  const { chromeApi, calls } = makeChrome({ openChat: () => ({ ok: true }) });
  const driver = newDriver(chromeApi);
  const r = await send(driver, { openMode: 'reload' });
  assert.equal(r.method, 'reload');
  assert.equal(calls.openChat, 0);
  assert.equal(calls.reloads, 1);
});

test('a successful fast open resets the miss counter', async () => {
  const results = ['FAST_UNSUPPORTED', 'OK', 'FAST_UNSUPPORTED', 'OK'];
  const { chromeApi, calls } = makeChrome({
    openChat: (n) => (results[n - 1] === 'OK' ? { ok: true } : { ok: false, code: 'FAST_UNSUPPORTED', error: 'x' }),
  });
  const driver = newDriver(chromeApi);
  for (let i = 0; i < 4; i++) await send(driver);
  assert.equal(calls.openChat, 4, 'never disabled because misses were not consecutive');
  assert.equal(calls.reloads, 2);
});
