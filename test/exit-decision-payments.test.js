/**
 * A PERSON'S DECISION NEVER CANCELS ANOTHER LANE'S PAYMENT (0053).
 *
 * A car picked while a card is being taken for its stay at another exit lane
 * is refused (`409 stay_paying_elsewhere`), and that payment is left as it
 * was. Two decisions at once on one case, where the typed time wins: the
 * losing pick cancels nothing. A payment written while the decision waits for
 * the old case's lock is seen, and refused the same way. Each held by a break in
 * `scripts/exit-decision-fail-control.js`.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { pool, withTenant } from './helpers.js';
import { startHarness, cardGarage, enter, caseAt, pay, payAndPresent, close, rows, ago, RULE } from './exit-harness.js';

let h;

before(async () => {
  delete process.env.EXIT_PICKER_KEY_FILE;
  h = await startHarness();
});

after(async () => {
  await h?.stop();
  await pool.end();
});

const partial = { plate_characters: { state: 'read', rule: RULE, pattern: 'AB?????' } };

/** Two parked cars the exit could be; the first is paying at the exit lane on its own case; and a case no stay was found for. */
async function payingElsewhere(name) {
  const g = await cardGarage(h, name);
  const a = (await enter(h, g, { plate: 'AB12345', extra: partial })).res.session;
  await enter(h, g, { plate: 'AB67890', extra: partial });
  const paying = await caseAt(h, g, 'AB12345', { extra: { session_id: a.id } });
  assert.equal(paying.method, 'lane');
  const started = await pay(h, g, paying.id);
  assert.equal(started.payment.status, 'open');
  const unmatched = await caseAt(h, g, 'AB?????');
  assert.deepEqual([unmatched.method, unmatched.needs], ['none', 'driver_word']);
  return { g, a, paying, unmatched, intent: started.payment.payment_intent_id };
}

const decide = (g, id, body) => h.call(g.op, 'POST', `/garages/${g.world.garage}/exit-cases/${id}/decision`, body);

async function leftAlone(g, paying, intent, cancelsBefore) {
  assert.equal(h.stub.cancels.length, cancelsBefore, 'nothing was canceled at Stripe');
  if (intent) assert.ok(!h.stub.cancels.includes(intent));
  const [p] = await rows(g, 'SELECT status FROM exit_payments WHERE exit_id = $1', [paying.id]);
  assert.equal(p.status, 'open', "the other lane's payment is as it was");
  const [c] = await rows(g, 'SELECT closed_at FROM exits WHERE id = $1', [paying.id]);
  assert.equal(c.closed_at, null, "the other lane's case is still open");
}

test('a car picked while it is paying at another lane is refused, and that payment is left alone', async () => {
  const { g, a, paying, unmatched, intent } = await payingElsewhere('decide-paying-elsewhere');
  const before = h.stub.cancels.length;
  const res = await decide(g, unmatched.id, { stay: a.id });
  assert.equal(res.status, 409, await res.clone().text());
  assert.equal((await res.json()).code, 'stay_paying_elsewhere');
  await leftAlone(g, paying, intent, before);
  const [x] = await rows(g, 'SELECT method, decision FROM exits WHERE id = $1', [unmatched.id]);
  assert.deepEqual([x.method, x.decision], ['none', null], 'the case can still be decided');
});

test('two decisions at once where the typed time wins: the losing pick cancels nothing', async () => {
  const { g, a, paying, unmatched, intent } = await payingElsewhere('decide-race-typed-wins');
  const before = h.stub.cancels.length;
  const [picked, typed] = await Promise.all([
    decide(g, unmatched.id, { stay: a.id }),
    decide(g, unmatched.id, { entered_at: ago(120), reason: 'customer said two hours' }),
  ]);
  assert.equal(typed.status, 200, await typed.clone().text());
  assert.equal((await typed.json()).decision.how, 'entered_at');
  assert.equal(picked.status, 409, await picked.clone().text());
  assert.ok(['stay_paying_elsewhere', 'already_decided'].includes((await picked.json()).code));
  await leftAlone(g, paying, intent, before);
  const lines = await rows(g, "SELECT 1 FROM garage_changes WHERE action = 'exit.decide' AND outcome = 'done' AND subject_id = $1", [unmatched.id]);
  assert.equal(lines.length, 1, 'one decision, one line');
});

/** Until a request of this database waits on a row lock (the decision, behind the held case), at most 5 seconds. */
async function untilWaitingOnALock() {
  for (let i = 0; i < 100; i += 1) {
    const { rows: r } = await pool.query(
      "SELECT count(*)::int AS n FROM pg_stat_activity WHERE datname = current_database() AND wait_event_type = 'Lock'");
    if (r[0].n > 0) return;
    await new Promise((res) => setTimeout(res, 50));
  }
  throw new Error('the decision never waited on the held case');
}

test('a payment written while the decision waits for the old case is seen: refused, and left alone', async () => {
  const g = await cardGarage(h, 'decide-payment-window');
  const a = (await enter(h, g, { plate: 'AB12345', extra: partial })).res.session;
  await enter(h, g, { plate: 'AB67890', extra: partial });
  const old = await caseAt(h, g, 'AB12345', { extra: { session_id: a.id } });
  const unmatched = await caseAt(h, g, 'AB?????');
  const before = h.stub.cancels.length;

  // The other lane: its case held, and its payment written, not yet committed.
  let locked;
  let release;
  const isLocked = new Promise((r) => { locked = r; });
  const released = new Promise((r) => { release = r; });
  const holder = withTenant(g.tenant, async (c) => {
    await c.query('SELECT id FROM exits WHERE id = $1 FOR UPDATE', [old.id]);
    await c.query(
      `INSERT INTO exit_payments (tenant_id, garage_id, exit_id, session_id, channel, account_id, payment_intent_id,
                                  amount_minor, currency, stripe_status, started_by)
       VALUES ($1, $2, $3, $4, 'phone_reader', $5, 'pi_window' || replace(gen_random_uuid()::text, '-', ''),
               $6, 'usd', 'requires_payment_method', 'platform:exit')`,
      [g.tenant, g.world.garage, old.id, a.id, g.account, old.fee.fee_minor]);
    locked();
    await released;
  });
  await isLocked;
  const decision = decide(g, unmatched.id, { stay: a.id });
  await untilWaitingOnALock();
  release();
  await holder;
  const res = await decision;
  assert.equal(res.status, 409, await res.clone().text());
  assert.equal((await res.json()).code, 'stay_paying_elsewhere');
  await leftAlone(g, old, null, before);
});

test('a payment that succeeded on the old case while the pick waited is never canceled, and the "replaced" line says it was paid', async () => {
  const g = await cardGarage(h, 'decide-paid-window');
  const a = (await enter(h, g, { plate: 'AB12345', extra: partial })).res.session;
  await enter(h, g, { plate: 'AB67890', extra: partial });
  const old = await caseAt(h, g, 'AB12345', { extra: { session_id: a.id } });
  const unmatched = await caseAt(h, g, 'AB?????');
  const before = h.stub.cancels.length;

  let locked;
  let release;
  const isLocked = new Promise((r) => { locked = r; });
  const released = new Promise((r) => { release = r; });
  const holder = withTenant(g.tenant, async (c) => {
    await c.query('SELECT id FROM exits WHERE id = $1 FOR UPDATE', [old.id]);
    const { rows: written } = await c.query(
      `INSERT INTO exit_payments (tenant_id, garage_id, exit_id, session_id, channel, account_id, payment_intent_id,
                                  amount_minor, currency, stripe_status, started_by)
       VALUES ($1, $2, $3, $4, 'phone_reader', $5, 'pi_paid' || replace(gen_random_uuid()::text, '-', ''),
               $6, 'usd', 'requires_payment_method', 'platform:exit') RETURNING id`,
      [g.tenant, g.world.garage, old.id, a.id, g.account, old.fee.fee_minor]);
    // A payment begins open; this one is paid before the commit.
    await c.query(`UPDATE exit_payments SET status = 'succeeded', succeeded_at = now(), stripe_status = 'succeeded' WHERE id = $1`, [written[0].id]);
    locked();
    await released;
  });
  await isLocked;
  const decision = decide(g, unmatched.id, { stay: a.id });
  await untilWaitingOnALock();
  release();
  await holder;
  const res = await decision;
  assert.equal(res.status, 200, await res.clone().text());
  const { decision: d } = await res.json();
  assert.deepEqual([d.result, d.amount_minor], ['no_fee', 0], 'what the stay paid is credited');
  assert.equal(h.stub.cancels.length, before, 'a paid card is never canceled');
  const [p] = await rows(g, 'SELECT status FROM exit_payments WHERE exit_id = $1', [old.id]);
  assert.equal(p.status, 'succeeded');
  const [line] = await rows(g, "SELECT after FROM garage_changes WHERE action = 'exit.superseded' AND subject_id = $1", [old.id]);
  assert.deepEqual([line.after.payment, line.after.paid_minor], ['succeeded', old.fee.fee_minor], 'the line reads the case as it stands');
});

test('after a decision with a fee, the lane takes the card, the case is settled paid, and the close lets the car out', async () => {
  const g = await cardGarage(h, 'decide-then-pay');
  const unmatched = await caseAt(h, g, 'QQ99999');
  const res = await decide(g, unmatched.id, { entered_at: ago(120), reason: 'customer said two hours' });
  assert.equal(res.status, 200, await res.clone().text());
  const { decision, exit: decided } = await res.json();
  assert.equal(decision.result, 'fee');
  assert.equal(decided.needs, 'payment', 'the lane hands this fee to its reader');
  const started = await payAndPresent(h, g, unmatched.id);
  assert.equal(started.payment.amount_minor, decision.amount_minor, 'the card is asked for the decided fee');
  const closed = await close(h, g, unmatched.id);
  assert.equal(closed.status, 200, await closed.clone().text());
  const out = await closed.json();
  assert.deepEqual([out.session, out.exit.closed], [null, true]);
  const [p] = await rows(g, 'SELECT status FROM exit_payments WHERE exit_id = $1', [unmatched.id]);
  assert.equal(p.status, 'succeeded');
});
