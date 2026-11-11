/**
 * THE RATE ENGINE AT ITS PIN (`rate-engine.pin`): what a garage's specials
 * cost, as the engine the platform runs prices them. Asked through the plan
 * try (`POST /garages/:id/rate-plans/try`), which prices with the real engine
 * and stores nothing.
 *
 *   * a fixed discount and a fixed increase charge the same whichever order
 *     the garage lists them in (the engine at an earlier main charged 4.00
 *     for one order and 2.00 for the other);
 *   * a stay cheaper than its fixed discount is free, not refused (the engine
 *     the platform ran before refused it, and the stay closed unpriced);
 *   * a percent and a fixed discount charge the cheaper order whichever the
 *     garage lists (the engine before charged the order listed).
 *
 * The control is the pin itself: run with the engine at the old pin, the
 * second and third fail; at the engine's earlier main, the first and third.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, flatHourlyPlan } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';

let engine;
let server;
let base;
let tenant;
let op;
let garageId;

before(async () => {
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  tenant = await createTenant('engine-pin');
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
  const token = generateDeviceToken();
  garageId = await withTenant(tenant, async (c) => {
    await c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'ops',$2)`, [tenant, hashToken(token)]);
    return (await c.query(
      `INSERT INTO garages (tenant_id, name, timezone, currency, transient_available) VALUES ($1, 'Pin', 'America/New_York', 'USD', true) RETURNING id`,
      [tenant])).rows[0].id;
  });
  op = (path, body) => fetch(`${base}/api/v1${path}`, {
    method: 'POST', headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` }, body: JSON.stringify(body),
  });
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await engine?.stop();
  await pool.end();
});

/** A weekend special that takes off, or adds, a fixed amount. */
const weekend = (id, direction, minor, kind = 'fixed') => ({
  id, type: 'time_window', stage: 'ADJUST', space_classes: ['standard'], label: id,
  applies_on: { kind: 'days_of_week', days: ['sat', 'sun'] },
  enter_from: '00:00', enter_by: '23:59', exit_by: '23:59', day_span: 'any_span',
  effect: { kind: 'adjust', direction, amount: kind === 'fixed' ? { kind, minor } : { kind, percent_bp: minor }, rounding: 'down' },
});

/** 3.00 an hour and the specials given, in the order given. */
function plan(specials) {
  const p = flatHourlyPlan({ hourlyMinor: 300, version: 'pin-specials', effectiveFrom: '2026-01-01T00:00:00-05:00' });
  p.rules.push(...specials);
  p.adjust_order = specials.length > 1 ? specials.map((s) => s.id) : null;
  return p;
}

/** One Saturday hour, tried on `specials` (this garage states no taxes, so the fee is the subtotal). */
async function saturdayHour(specials) {
  const res = await op(`/garages/${garageId}/rate-plans/try`, { plan: plan(specials), stays: [{ entry: '2026-09-12T10:00', exit: '2026-09-12T11:00' }] });
  assert.equal(res.status, 200, JSON.stringify(await res.clone().json()));
  const [stay] = (await res.json()).stays;
  return stay;
}

test('a fixed discount and a fixed increase charge the same whichever order they are listed in', async () => {
  const off = weekend('weekend-off', 'discount', 500);
  const fee = weekend('event-fee', 'increase', 400);
  const discountFirst = await saturdayHour([off, fee]);
  const increaseFirst = await saturdayHour([fee, off]);
  assert.deepEqual([discountFirst.refused, discountFirst.fee_minor], [false, 200], '3.00 - 5.00 + 4.00');
  assert.deepEqual([increaseFirst.refused, increaseFirst.fee_minor], [false, 200], '3.00 + 4.00 - 5.00');
});

test('a stay cheaper than its fixed discount is free, not refused', async () => {
  const stay = await saturdayHour([weekend('weekend-off', 'discount', 500)]);
  assert.equal(stay.refused, false, JSON.stringify(stay.findings ?? null));
  assert.equal(stay.fee_minor, 0);
});

test('a percent and a fixed discount charge the cheaper order whichever the garage lists', async () => {
  const fifth = weekend('fifth-off', 'discount', 2000, 'percent');
  const dollar = weekend('dollar-off', 'discount', 100);
  // One Saturday hour at 3.00: 20% off then 1.00 off is 1.40; 1.00 off then 20% off is 1.60.
  const percentFirst = await saturdayHour([fifth, dollar]);
  const fixedFirst = await saturdayHour([dollar, fifth]);
  assert.deepEqual([percentFirst.refused, percentFirst.fee_minor], [false, 140]);
  assert.deepEqual([fixedFirst.refused, fixedFirst.fee_minor], [false, 140], 'the cheaper order, not the order listed');
});
