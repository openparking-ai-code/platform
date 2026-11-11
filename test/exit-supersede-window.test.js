/**
 * THE NARROW WINDOW: a payment is written on an exit case while another
 * request waits for that case's lock. Postgres hands the lock over with the
 * row as it was read, so the waiter must read again to see the payment.
 * Each place a case is closed is held to it, each by a break in
 * `scripts/exit-let-out-fail-control.js`:
 *
 *   a second case for the same stay (0045): an open payment is canceled at
 *   Stripe first, then the old case replaced; a paid one is written paid on
 *   the "replaced" line;
 *   the lane's close: refused while the payment is open (503, the lane sends
 *   it again, and the payment is settled first);
 *   a person ending the stay: refused, `stay_payment_moving`;
 *   the car's return closing its old stay (0048): the payment canceled at
 *   Stripe first, then the old case closed.
 *
 * Never a closed case with a card that can still be taken; never a paid card
 * canceled.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { pool, withTenant } from './helpers.js';
import { startHarness, cardGarage, enter, ago, rows, close, RULE } from './exit-harness.js';

let h;

before(async () => {
  delete process.env.EXIT_PICKER_KEY_FILE;
  h = await startHarness();
});

after(async () => {
  await h?.stop();
  await pool.end();
});

/** Until a request of this database waits on a row lock, at most 5 seconds. */
async function untilWaitingOnALock() {
  for (let i = 0; i < 100; i += 1) {
    const { rows: r } = await pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r[0].n > 0) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('the new case never waited on the held case');
}

/** An intent at the stand-in, on the garage's account, as a payment's start makes one. */
async function intentAt(g, amountMinor) {
  const res = await fetch(`${h.stub.base}/v1/payment_intents`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded', authorization: 'Bearer stub', 'stripe-account': g.account },
    body: new URLSearchParams({ amount: String(amountMinor), currency: 'usd', 'payment_method_types[]': 'card_present', capture_method: 'automatic' }).toString(),
  });
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).id;
}

const atExit = async (g, sessionId) => {
  const res = await h.call(g.exit, 'POST', '/lane/exits', { event_id: randomUUID(), exit_at: ago(0.5), session_id: sessionId });
  return { status: res.status, body: await res.json() };
};

/**
 * Holds case `caseId`, writes a payment on it -- open (with a real intent at
 * the stand-in) or succeeded -- and keeps it uncommitted until `act` is
 * waiting on the lock; then commits, and answers what `act` answered.
 */
async function inTheWindow(g, { caseId, sessionId, amountMinor, paid = false }, act) {
  const intent = paid ? `pi_paid${randomUUID().replace(/-/g, '')}` : await intentAt(g, amountMinor);
  let locked;
  let release;
  const isLocked = new Promise((r) => { locked = r; });
  const released = new Promise((r) => { release = r; });
  const holder = withTenant(g.tenant, async (c) => {
    await c.query('SELECT id FROM exits WHERE id = $1 FOR UPDATE', [caseId]);
    const { rows: written } = await c.query(
      `INSERT INTO exit_payments (tenant_id, garage_id, exit_id, session_id, channel, account_id, payment_intent_id,
                                  amount_minor, currency, stripe_status, started_by)
       VALUES ($1, $2, $3, $4, 'phone_reader', $5, $6, $7, 'usd', 'requires_payment_method', 'platform:exit') RETURNING id`,
      [g.tenant, g.world.garage, caseId, sessionId, g.account, intent, amountMinor]);
    // A payment begins open; this one is paid before the commit.
    if (paid) {
      await c.query(`UPDATE exit_payments SET status = 'succeeded', succeeded_at = now(), stripe_status = 'succeeded' WHERE id = $1`, [written[0].id]);
    }
    locked();
    await released;
  });
  await isLocked;
  const pending = act();
  await untilWaitingOnALock();
  release();
  await holder;
  return { out: await pending, intent };
}

const paymentOf = async (g, caseId) => (await rows(g, 'SELECT status FROM exit_payments WHERE exit_id = $1', [caseId]))[0]?.status;
const caseRow = async (g, caseId) => (await rows(g, 'SELECT closed_at, ended FROM exits WHERE id = $1', [caseId]))[0];

/** A stay with an open case at the exit lane, nothing paid yet. */
async function stayAtExit(g, plate) {
  const stay = (await enter(h, g, { plate })).res.session;
  const first = await atExit(g, stay.id);
  assert.equal(first.status, 201, JSON.stringify(first.body));
  return { stay, old: first.body.exit };
}

test('a second case: an open payment written while it waited is canceled at Stripe before the old case is replaced', async () => {
  const g = await cardGarage(h, 'window-second-open');
  const { stay, old } = await stayAtExit(g, 'WIN1234');
  const { out, intent } = await inTheWindow(g, { caseId: old.id, sessionId: stay.id, amountMinor: old.fee.fee_minor }, () => atExit(g, stay.id));
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const o = await caseRow(g, old.id);
  assert.ok(o.closed_at, 'the old case is superseded');
  assert.equal(o.ended.why, 'superseded');
  assert.equal(await paymentOf(g, old.id), 'canceled', 'never a closed case with a card that can still be taken');
  assert.ok(h.stub.cancels.includes(intent), 'canceled at Stripe first');
});

test('a second case: a payment that succeeded while it waited is never canceled, and the "replaced" line says it was paid', async () => {
  const g = await cardGarage(h, 'window-second-paid');
  const { stay, old } = await stayAtExit(g, 'WIN2345');
  const cancels = h.stub.cancels.length;
  const { out, intent } = await inTheWindow(g, { caseId: old.id, sessionId: stay.id, amountMinor: old.fee.fee_minor, paid: true }, () => atExit(g, stay.id));
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.exit.fee.fee_minor, 0, 'what it paid is credited');
  assert.equal(await paymentOf(g, old.id), 'succeeded');
  assert.equal(h.stub.cancels.length, cancels);
  assert.ok(!h.stub.cancels.includes(intent));
  const [line] = await rows(g, "SELECT after FROM garage_changes WHERE action = 'exit.superseded' AND subject_id = $1", [old.id]);
  assert.deepEqual([line.after.payment, line.after.paid_minor], ['succeeded', old.fee.fee_minor], 'the line reads the case as it stands');
});

test("the lane's close: a payment written while it waited is seen, and the close is refused for the lane to send again", async () => {
  const g = await cardGarage(h, 'window-close');
  const { stay, old } = await stayAtExit(g, 'WIN3456');
  const cancels = h.stub.cancels.length;
  const { out } = await inTheWindow(g, { caseId: old.id, sessionId: stay.id, amountMinor: old.fee.fee_minor },
    async () => {
      const res = await close(h, g, old.id);
      return { status: res.status, body: await res.json() };
    });
  assert.equal(out.status, 503, JSON.stringify(out.body));
  assert.equal(out.body.code, 'payment_unsettled');
  assert.equal((await caseRow(g, old.id)).closed_at, null, 'the case is not closed under a live card');
  assert.equal(await paymentOf(g, old.id), 'open');
  assert.equal(h.stub.cancels.length, cancels);
  const [s] = await rows(g, 'SELECT exit_at FROM sessions WHERE id = $1', [stay.id]);
  assert.equal(s.exit_at, null, 'the stay is still open');
});

test('a person ending the stay: a payment written while it waited is seen, and the end is refused', async () => {
  const g = await cardGarage(h, 'window-end');
  const { stay, old } = await stayAtExit(g, 'WIN4567');
  const cancels = h.stub.cancels.length;
  const { out } = await inTheWindow(g, { caseId: old.id, sessionId: stay.id, amountMinor: old.fee.fee_minor },
    async () => {
      const res = await h.call(g.op, 'POST', `/garages/${g.world.garage}/stays/${stay.id}/end`, { outcome: 'abandoned', reason: 'left on foot' });
      return { status: res.status, body: await res.json() };
    });
  assert.equal(out.status, 409, JSON.stringify(out.body));
  assert.equal(out.body.code, 'stay_payment_moving');
  assert.equal((await caseRow(g, old.id)).closed_at, null);
  assert.equal(await paymentOf(g, old.id), 'open');
  assert.equal(h.stub.cancels.length, cancels);
});

test("the car's return: a payment written on its old case while the entry waited is canceled at Stripe before the old case is closed", async () => {
  const g = await cardGarage(h, 'window-return');
  const plate = 'WIN5678';
  const { stay, old } = await stayAtExit(g, plate);
  const { out, intent } = await inTheWindow(g, { caseId: old.id, sessionId: stay.id, amountMinor: old.fee.fee_minor },
    async () => {
      const res = await h.call(g.entry, 'POST', '/lane/sessions/open', {
        event_id: randomUUID(), plate, entry_at: ago(0.2), entry_confirmation: 'confirmed',
        plate_characters: { state: 'read', rule: RULE, pattern: plate },
      });
      return { status: res.status, body: await res.json() };
    });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  const o = await caseRow(g, old.id);
  assert.ok(o.closed_at, 'the old case is closed with its stay');
  assert.equal(o.ended.why, 'stay_ended');
  assert.equal(await paymentOf(g, old.id), 'canceled', 'never a closed case with a card that can still be taken');
  assert.ok(h.stub.cancels.includes(intent), 'canceled at Stripe first');
});
