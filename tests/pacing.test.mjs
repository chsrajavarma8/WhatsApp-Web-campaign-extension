// Pacing tests: "1 message every N" is measured start-to-start, survives
// restarts and pauses, follows live pace changes, and can be skipped.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CampaignRunner, createEmptyCampaign, nextDueAt, estimateFinish, describePace, formatDuration,
} from '../campaign-manager.js';
import { buildContacts } from '../contacts.js';
import { parseCSV } from '../csv-parser.js';
import { STATUS, CAMPAIGN_STATE, ERR, MIN_GAP_MS } from '../constants.js';

const tick = () => new Promise((r) => setImmediate(r));
const T0 = 1_700_000_000_000;

function makeClock() {
  const clock = { t: T0 };
  clock.now = () => clock.t;
  clock.sleep = async (ms) => {
    clock.t += ms;
    await tick();
  };
  return clock;
}

function makeStore(initial) {
  let data = structuredClone(initial);
  return {
    getCampaign: async () => structuredClone(data),
    saveCampaign: async (c) => { data = structuredClone(c); },
    peek: () => data,
  };
}

/** Driver whose open+send takes `workMs` of fake time; records send times. */
function makeDriver(clock, { workMs = 7000, behavior = {}, onSent = () => {} } = {}) {
  const d = { sent: [] };
  d.sendMessage = async ({ phone, settings, shouldContinue, wait }) => {
    await clock.sleep(workMs);
    if (!shouldContinue()) return { aborted: true };
    if (behavior[phone]) return behavior[phone];
    if (!(await wait(settings.delayBeforeSend))) return { aborted: true };
    d.sent.push({ phone, at: clock.t });
    await onSent(phone, d);
    return { ok: true, verified: true };
  };
  return d;
}

const CSV = 'Name,Phone\nA,919876543210\nB,918765432109\nC,917654321098\n';

function campaign(pace = 60) {
  const c = createEmptyCampaign();
  c.contacts = buildContacts(parseCSV(CSV).records, { nameColumn: 'Name', phoneColumn: 'Phone' });
  c.template = 'Hi {Name}';
  c.settings = { ...c.settings, delayBetween: pace, delayBeforeOpen: 1, delayBeforeSend: 1, maxPerSession: 100 };
  return c;
}

async function setup(pace, driverOpts, clock = makeClock()) {
  const store = makeStore(campaign(pace));
  const driver = makeDriver(clock, driverOpts);
  const runner = new CampaignRunner({ store, driver, sleep: clock.sleep, now: clock.now });
  await runner.init();
  return { runner, store, driver, clock };
}

const gaps = (sent) => sent.slice(1).map((s, i) => s.at - sent[i].at);

test('"1 per minute" means one message every 60s start-to-start, not 60s + work time', async () => {
  const { runner, driver } = await setup(60);
  await runner.start();
  await runner.whenIdle();
  assert.equal(driver.sent.length, 3);
  assert.deepEqual(gaps(driver.sent), [60000, 60000]);
});

test('15 and 30 minute paces are honoured exactly', async () => {
  for (const minutes of [15, 30]) {
    const { runner, driver } = await setup(minutes * 60);
    await runner.start();
    await runner.whenIdle();
    assert.deepEqual(gaps(driver.sent), [minutes * 60000, minutes * 60000], `${minutes} min`);
  }
});

test('if sending takes longer than the pace, there is still a minimum gap', async () => {
  const { runner, driver } = await setup(10, { workMs: 20000 });
  await runner.start();
  await runner.whenIdle();
  // start-to-start = 1s open delay + 20s work + 1s send delay + 5s minimum gap
  for (const g of gaps(driver.sent)) assert.equal(g, 22000 + MIN_GAP_MS);
});

test('a number not on WhatsApp does not cost a full pace interval', async () => {
  const { runner, driver } = await setup(1800, {
    behavior: { 918765432109: { ok: false, code: ERR.INVALID_NUMBER, error: 'Not on WhatsApp' } },
  });
  await runner.start();
  await runner.whenIdle();
  const st = runner.getState();
  assert.equal(st.contacts[1].status, STATUS.INVALID);
  assert.equal(driver.sent.length, 2);
  // A at t, wait 30 min, B (invalid), only the short gap, then C.
  const gap = driver.sent[1].at - driver.sent[0].at;
  assert.ok(gap < 1800000 + 30000, `gap ${gap} should be ~30 min plus one short attempt`);
});

test('pause + resume during a 30 min wait keeps the remaining wait (no early send)', async () => {
  const clock = makeClock();
  const ctx = await setup(1800, {}, clock);
  const { runner } = ctx;
  await runner.start();
  // Let the first message go out and the wait begin.
  while (!runner.getState().waitingUntil) await tick();
  const due = runner.getState().waitingUntil;
  assert.ok(due - clock.t > 25 * 60000, 'about 30 minutes to wait');
  await runner.pause();
  await runner.whenIdle();
  clock.t += 10 * 60000; // 10 minutes pass while paused
  await runner.resume();
  await runner.whenIdle();
  assert.equal(runner.getState().status, CAMPAIGN_STATE.COMPLETED);
  assert.ok(ctx.driver.sent[1].at >= due, 'second message not sent before the original due time');
});

test('a service-worker restart during the wait resumes and still honours the pace', async () => {
  const clock = makeClock();
  const first = await setup(900, {}, clock);
  await first.runner.start();
  while (!first.runner.getState().waitingUntil) await tick();
  const due = first.runner.getState().waitingUntil;
  // Simulate the worker dying: a new runner loads persisted state.
  first.runner.campaign = { ...first.runner.campaign, status: 'dead' }; // stop the old loop
  const store = makeStore(first.store.peek());
  const driver = makeDriver(clock);
  const runner = new CampaignRunner({ store, driver, sleep: clock.sleep, now: clock.now });
  await runner.init();
  await runner.recover({ browserRestarted: false });
  await runner.whenIdle();
  assert.equal(driver.sent.length, 2, 'the remaining two contacts were sent');
  assert.ok(driver.sent[0].at >= due, 'not sent before the persisted due time');
});

test('changing the pace mid-wait applies immediately; skipWait sends now', async () => {
  const { runner, driver, clock } = await setup(1800);
  await runner.start();
  while (!runner.getState().waitingUntil) await tick();
  const startedWait = clock.t;
  await runner.updateSetup({ settings: { delayBetween: 120 } });
  while (driver.sent.length < 2) await tick();
  assert.ok(driver.sent[1].at - startedWait < 130000, 'used the new 2 min pace');

  while (!runner.getState().waitingUntil) await tick();
  const skipAt = clock.t;
  await runner.skipWait();
  await runner.whenIdle();
  assert.equal(driver.sent.length, 3);
  assert.ok(driver.sent[2].at - skipAt < 15000, 'sent right after skipping');
  await assert.rejects(() => runner.skipWait(), /no wait/);
});

test('helpers: nextDueAt, estimateFinish, describePace, formatDuration', () => {
  const c = campaign(900);
  assert.equal(nextDueAt(c), 0);
  c.pace = { lastStartedAt: T0, lastFinishedAt: T0 + 10000, lastSent: true, skip: false };
  assert.equal(nextDueAt(c), T0 + 900000);
  c.pace.lastSent = false;
  assert.equal(nextDueAt(c), T0 + 10000 + MIN_GAP_MS);
  c.pace.skip = true;
  assert.equal(nextDueAt(c), 0);

  const fresh = campaign(900);
  const eta = estimateFinish(fresh, T0);
  assert.equal(eta, T0 + 2 * 900000 + 10000, '3 contacts at 15 min: two intervals + last send');

  assert.equal(describePace(30), '30 sec');
  assert.equal(describePace(60), '1 min');
  assert.equal(describePace(900), '15 min');
  assert.equal(describePace(1800), '30 min');
  assert.equal(describePace(3600), '1 hour');
  assert.equal(describePace(5400), '1 h 30 min');
  assert.equal(formatDuration(45000), '45s');
  assert.equal(formatDuration(185000), '3m 05s');
  assert.equal(formatDuration(4800000), '1h 20m');
});
