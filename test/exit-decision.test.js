/**
 * A PERSON DECIDES AN EXIT CASE THE PLATFORM COULD NOT MATCH (0053).
 *
 * What this file measures, each with a break in
 * `scripts/exit-decision-fail-control.js`:
 *
 *   * the list and one case carry what the attendant's screen shows: the
 *     lane's name, the exit's plate and how sure, the exit's picture, what
 *     happened, the possible cars with their pictures and why, the fee, the
 *     decision -- and the list's older fields are unchanged;
 *   * a case's pictures are its exit's and its possible cars' only, through
 *     its own garage only;
 *   * a pick must be one of the case's possible cars, and prices that stay;
 *   * a typed time needs its offset and a reason, no later than the exit and
 *     no more than 90 days before it, and is priced by the engine;
 *   * a fee of zero answers `no_fee`, as plainly as a fee;
 *   * once per case: `409 already_decided`, with the decision;
 *   * only a car no stay was found for; never one already let out;
 *   * who and when on the case, one change-log line, an event with no plate;
 *   * a stay picked that has another open case supersedes it;
 *   * another account's key finds no case; decisions are limited a minute.
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld, storePlan, flatHourlyPlan, activateGarage } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { startRateEngine } from './rate-engine.js';
import { DECISIONS_PER_MINUTE } from '../src/exitDecisions.js';

const RULE = 'opvid-plate-chars/1';
const JPEG = await sharp({ create: { width: 64, height: 48, channels: 3, background: { r: 30, g: 30, b: 200 } } }).jpeg().toBuffer();

let engine;
let server;
let base;

before(async () => {
  delete process.env.EXIT_PICKER_KEY_FILE;
  engine = await startRateEngine();
  process.env.RATE_ENGINE_URL = engine.url;
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (server) await new Promise((r) => server.close(r));
  await engine?.stop();
  await pool.end();
});

async function token(tenantId, laneId, name) {
  const t = generateDeviceToken();
  await withTenant(tenantId, (c) =>
    c.query('INSERT INTO lane_devices (tenant_id, lane_id, name, token_hash) VALUES ($1,$2,$3,$4)', [tenantId, laneId, name, hashToken(t)]));
  return t;
}

async function garage(name, { hourlyMinor = 250 } = {}) {
  const tenant = await createTenant(name);
  const world = await buildWorld(tenant, { hourlyMinor });
  const op = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'desk',$2)`, [tenant, hashToken(op)]));
  return { tenant, world, entry: await token(tenant, world.entryLane, 'entry'), exit: await token(tenant, world.exitLane, 'exit'), op };
}

const call = (tok, method, path, body, headers = {}) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${tok}`, ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const read = (pattern) => ({ state: 'read', rule: RULE, pattern });

async function enter(g, plate, pattern, minutes = 90) {
  const eventId = randomUUID();
  const res = await call(g.entry, 'POST', '/lane/sessions/open', {
    event_id: eventId, plate, entry_at: ago(minutes), entry_confirmation: 'confirmed', plate_characters: read(pattern),
  });
  assert.equal(res.status, 201, await res.clone().text());
  return { eventId, session: (await res.json()).session };
}

async function picture(tok, eventId) {
  const res = await call(tok, 'POST', '/lane/pictures', { picture_ref: randomUUID().slice(0, 30), event_id: eventId, taken_at: ago(1), image: JPEG.toString('base64') });
  assert.equal(res.status, 201, await res.clone().text());
}

async function atExit(g, body, eventId = randomUUID()) {
  const res = await call(g.exit, 'POST', '/lane/exits', { event_id: eventId, exit_at: ago(0.5), ...body });
  assert.ok([200, 201].includes(res.status), await res.clone().text());
  return (await res.json()).exit;
}

const casePath = (g, id) => `/garages/${g.world.garage}/exit-cases/${id}`;
const decide = (g, id, body, headers) => call(g.op, 'POST', `${casePath(g, id)}/decision`, body, headers);
const oneCase = async (g, id) => {
  const res = await call(g.op, 'GET', casePath(g, id));
  assert.equal(res.status, 200, await res.clone().text());
  return (await res.json()).case;
};

/** Two parked cars the exit's plate could be, both with pictures, and the exit's own picture: a case no stay was found for. */
async function twoPossible(g, prefix = 'AB') {
  const a = await enter(g, `${prefix}12345`, `${prefix}?????`);
  const b = await enter(g, `${prefix}67890`, `${prefix}?????`);
  for (const s of [a, b]) await picture(g.entry, s.eventId);
  const eventId = randomUUID();
  await picture(g.exit, eventId);
  const exit = await atExit(g, { plate_characters: read(`${prefix}?????`) }, eventId);
  assert.deepEqual([exit.method, exit.needs], ['none', 'driver_word']);
  return { a, b, exit };
}

test('the list and one case carry what the screen shows, and the list keeps its older fields', async () => {
  const g = await garage('decide-shape');
  const { a, b, exit } = await twoPossible(g);
  const list = await (await call(g.op, 'GET', `/garages/${g.world.garage}/exits`)).json();
  const listed = list.exits.find((e) => e.id === exit.id);
  // The older fields, as before.
  for (const key of ['id', 'method', 'settled', 'needs', 'lane_id', 'candidates', 'picker', 'person', 'fee', 'created_at']) {
    assert.ok(key in listed, key);
  }
  assert.deepEqual([...listed.candidates].sort(), [a.session.id, b.session.id].sort(), 'the stay ids, as before');
  assert.equal(listed.decision, null);

  const c = await oneCase(g, exit.id);
  assert.deepEqual(listed.case, c, 'the list carries the same case the one-case read answers');
  assert.deepEqual(c.lane, { id: g.world.exitLane, name: 'Exit 1' });
  assert.equal(c.kind, 'unmatched');
  assert.deepEqual([c.exit.plate, c.exit.read], ['AB?????', 'unsure']);
  assert.ok(c.exit.picture, 'the exit picture');
  assert.equal(c.what_happened_code, 'several');
  assert.equal(typeof c.what_happened, 'string');
  assert.equal(c.fee, null, 'not priced yet');
  assert.equal(c.decision, null);
  assert.equal(c.candidates.length, 2);
  for (const car of c.candidates) {
    assert.ok([a.session.id, b.session.id].includes(car.stay));
    assert.ok(['AB12345', 'AB67890'].includes(car.plate));
    assert.equal(car.pictures.length, 1);
    assert.equal(car.why, 'partial_plate');
    assert.ok(car.entered_at);
  }
});

test("a case's pictures are its exit's and its possible cars' only, through its own garage", async () => {
  const g = await garage('decide-pictures');
  const { exit } = await twoPossible(g);
  const elsewhere = await enter(g, 'ZZ99999', 'ZZ99999');
  await picture(g.entry, elsewhere.eventId);
  const notShown = (await withTenant(g.tenant, (cl) => cl.query('SELECT id FROM entry_pictures WHERE event_id = $1', [elsewhere.eventId]))).rows[0].id;
  const c = await oneCase(g, exit.id);
  for (const id of [c.exit.picture, c.candidates[0].pictures[0], c.candidates[1].pictures[0]]) {
    const res = await call(g.op, 'GET', `${casePath(g, exit.id)}/pictures/${id}`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'image/jpeg');
    assert.equal(res.headers.get('cache-control'), 'private, no-store');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.deepEqual([...bytes.subarray(0, 2)], [0xff, 0xd8], 'the image itself (re-encoded when it was kept)');
  }
  assert.equal((await call(g.op, 'GET', `${casePath(g, exit.id)}/pictures/${notShown}`)).status, 404, 'a picture of another car');
  // A second garage of the same account, which the key reaches: the case is not found through it.
  const second = { garage: (await withTenant(g.tenant, (cl) => cl.query(
    `INSERT INTO garages (tenant_id, name, timezone, currency) VALUES ($1, 'Second Garage', 'America/New_York', 'USD') RETURNING id`,
    [g.tenant]))).rows[0].id };
  assert.equal((await call(g.op, 'GET', `/garages/${second.garage}/exit-cases/${exit.id}`)).status, 404, 'the same account, another garage');
  assert.equal((await call(g.op, 'GET', `/garages/${second.garage}/exit-cases/${exit.id}/pictures/${c.exit.picture}`)).status, 404,
    "the same account, another garage's path to the picture");
  const viaSecond = await call(g.op, 'POST', `/garages/${second.garage}/exit-cases/${exit.id}/decision`, { stay: c.candidates[0].stay });
  assert.equal(viaSecond.status, 404, 'decided through another garage');
  const other = await garage('decide-pictures-other');
  assert.equal((await call(other.op, 'GET', `${casePath(g, exit.id)}/pictures/${c.exit.picture}`)).status, 404, "another account's key");
  assert.equal((await call(other.op, 'GET', `/garages/${other.world.garage}/exit-cases/${exit.id}/pictures/${c.exit.picture}`)).status, 404,
    'another garage, the same case id');
  assert.equal((await call(other.op, 'GET', `/garages/${other.world.garage}/exit-cases/${exit.id}`)).status, 404);
  assert.equal((await call(other.op, 'POST', `/garages/${other.world.garage}/exit-cases/${exit.id}/decision`, { stay: c.candidates[0].stay })).status, 404);
});

test('a pick must be one of the possible cars; it prices that stay, once, with who and when', async () => {
  const g = await garage('decide-pick');
  const { a, exit } = await twoPossible(g);
  const stranger = await enter(g, 'QQ11111', 'QQ11111');
  for (const body of [{}, { stay: 'nope' }, { stay: a.session.id, extra: 1 }, { entered_at: ago(60) }]) {
    const res = await decide(g, exit.id, body);
    assert.equal(res.status, 400, JSON.stringify(body));
  }
  const notOne = await decide(g, exit.id, { stay: stranger.session.id });
  assert.equal(notOne.status, 400);
  assert.equal((await notOne.json()).code, 'stay_not_a_candidate');

  const res = await decide(g, exit.id, { stay: a.session.id }, { 'x-done-by': encodeURIComponent('Ana Núñez') });
  assert.equal(res.status, 200, await res.clone().text());
  const { decision, exit: after } = await res.json();
  assert.equal(decision.how, 'stay');
  assert.equal(decision.stay, a.session.id);
  assert.equal(decision.result, 'fee');
  assert.equal(decision.no_fee, false);
  assert.ok(decision.amount_minor > 0);
  assert.equal(decision.currency, 'USD');
  assert.match(decision.decided_by, /^key:/);
  assert.equal(decision.done_by, 'Ana Núñez');
  assert.ok(decision.decided_at);
  assert.deepEqual([after.method, after.session_id, after.needs], ['attendant_pick', a.session.id, 'payment']);
  assert.equal(after.fee.fee_minor, decision.amount_minor, 'the amount is the fee the lane asks for');

  const polled = (await (await call(g.exit, 'GET', `/lane/exits/${exit.id}`)).json()).exit;
  assert.deepEqual([polled.method, polled.fee.fee_minor, polled.needs], ['attendant_pick', decision.amount_minor, 'payment']);
  const c = await oneCase(g, exit.id);
  assert.deepEqual(c.decision, decision);
  assert.deepEqual(c.fee, { amount_minor: decision.amount_minor, currency: 'USD', no_fee: false });

  const again = await decide(g, exit.id, { stay: a.session.id });
  assert.equal(again.status, 409);
  const said = await again.json();
  assert.equal(said.code, 'already_decided');
  assert.deepEqual(said.details.decision, decision, 'the second answer carries the first decision');

  const lines = await withTenant(g.tenant, async (cl) =>
    (await cl.query("SELECT after, done_by FROM garage_changes WHERE action = 'exit.decide' AND outcome = 'done'")).rows);
  assert.equal(lines.length, 1);
  assert.equal(lines[0].done_by, 'Ana Núñez');
  const events = await withTenant(g.tenant, async (cl) =>
    (await cl.query("SELECT detail FROM events WHERE kind = 'exit_decided_by_person' AND garage_id = $1", [g.world.garage])).rows);
  assert.equal(events.length, 1);
  assert.doesNotMatch(JSON.stringify([events, lines]), /AB12345|AB67890|AB\?/, 'no plate in the event or the line');
});

test('a typed time needs its offset and a reason, within the exit and 90 days, and the engine prices it', async () => {
  const g = await garage('decide-time');
  await enter(g, 'XYZ1234', 'XYZ1234');
  const exit = await atExit(g, { plate_characters: read('QQQ9999') });
  const c = await oneCase(g, exit.id);
  assert.deepEqual([c.candidates, c.what_happened_code], [[], 'no_match']);

  const noOffset = await decide(g, exit.id, { entered_at: '2026-10-27T09:00:00', reason: 'customer said nine' });
  assert.equal((await noOffset.json()).code, 'entry_time_without_offset');
  assert.equal((await decide(g, exit.id, { entered_at: ago(120), reason: 'x' })).status, 400, 'a reason of 3 or more');
  assert.equal((await decide(g, exit.id, { entered_at: ago(120), reason: 'y'.repeat(201) })).status, 400);
  const late = await decide(g, exit.id, { entered_at: new Date(Date.now() + 60_000).toISOString(), reason: 'after the exit' });
  assert.equal((await late.json()).code, 'entry_after_exit');
  const old = await decide(g, exit.id, { entered_at: new Date(Date.now() - 91 * 86_400_000).toISOString(), reason: 'too long ago' });
  assert.equal((await old.json()).code, 'entry_too_old');

  const res = await decide(g, exit.id, { entered_at: ago(120), reason: '  customer said about two hours  ' });
  assert.equal(res.status, 200, await res.clone().text());
  const { decision, exit: after } = await res.json();
  assert.deepEqual([decision.how, decision.result, decision.amount_minor, decision.reason], ['entered_at', 'fee', 500, 'customer said about two hours']);
  assert.deepEqual([after.method, after.session_id, after.needs], ['attendant_time', null, 'payment']);

  const closed = await call(g.exit, 'POST', '/lane/sessions/close', { event_id: randomUUID(), exit_id: exit.id, exit_at: ago(0.2), exit_confirmation: 'confirmed' });
  assert.equal(closed.status, 200, await closed.clone().text());
  assert.equal((await closed.json()).session, null, 'no stay is invented for a typed time');
});

test('a fee of zero answers no_fee, as plainly as a fee, and the lane is settled', async () => {
  const g = await garage('decide-zero', { hourlyMinor: 0 });
  const exit = await atExit(g, { plate_characters: read('NIL0000') });
  const res = await decide(g, exit.id, { entered_at: ago(45), reason: 'customer word' });
  assert.equal(res.status, 200, await res.clone().text());
  const { decision, exit: after } = await res.json();
  assert.deepEqual([decision.result, decision.no_fee, decision.amount_minor, decision.currency], ['no_fee', true, 0, 'USD']);
  assert.deepEqual([after.settled, after.why], [true, 'zero_fee']);
  const c = await oneCase(g, exit.id);
  assert.deepEqual(c.fee, { amount_minor: 0, currency: 'USD', no_fee: true });
  const polled = (await (await call(g.exit, 'GET', `/lane/exits/${exit.id}`)).json()).exit;
  assert.deepEqual([polled.settled, polled.why], [true, 'zero_fee'], 'the lane reads it settled: the gate opens');
  const closed = await call(g.exit, 'POST', '/lane/sessions/close', { event_id: randomUUID(), exit_id: exit.id, exit_at: ago(0.2), exit_confirmation: 'confirmed' });
  assert.equal(closed.status, 200, await closed.clone().text());
  assert.equal((await closed.json()).exit.closed, true, 'and the close lets the car out, owing nothing');
});

test('only a car that needs a decision, and never one a person let out', async () => {
  const g = await garage('decide-only-unmatched');
  const { session } = await enter(g, 'MATCH12', 'MATCH12');
  const matched = await atExit(g, { plate_characters: read('MATCH12') });
  assert.equal(matched.session_id, session.id);
  const r1 = await decide(g, matched.id, { entered_at: ago(30), reason: 'trying anyway' });
  assert.equal((await r1.json()).code, 'exit_needs_no_decision', 'a matched, priced car needs no decision');

  // The let-out route is retired (410, nothing written), but past let-outs stay on record:
  // one written before the retirement is never decided again.
  const lone = await atExit(g, { plate_characters: read('LONE999') });
  assert.equal((await call(g.op, 'POST', `/garages/${g.world.garage}/exits/${lone.id}/let-out`, { reason: 'paper ticket' })).status, 410);
  await withTenant(g.tenant, (c) => c.query(
    `UPDATE exits SET person = $2 WHERE id = $1`,
    [lone.id, { by: 'operator:desk', reason: 'paper ticket', at: new Date().toISOString() }]));
  const r2 = await decide(g, lone.id, { entered_at: ago(30), reason: 'after the let-out' });
  assert.equal((await r2.json()).code, 'exit_already_let_out');
  assert.equal((await decide(g, randomUUID(), { entered_at: ago(30), reason: 'nothing' })).status, 404);
});

test("a stay picked that has another open case supersedes it, as a car coming back does", async () => {
  const g = await garage('decide-supersede');
  const { a, exit } = await twoPossible(g, 'CD');
  const prior = await atExit(g, { session_id: a.session.id });
  assert.equal(prior.method, 'lane');
  const res = await decide(g, exit.id, { stay: a.session.id });
  assert.equal(res.status, 200, await res.clone().text());
  const old = (await (await call(g.exit, 'GET', `/lane/exits/${prior.id}`)).json()).exit;
  assert.equal(old.closed, true);
  assert.deepEqual(old.ended, { why: 'superseded', superseded_by: exit.id });
  const lines = await withTenant(g.tenant, async (cl) =>
    (await cl.query("SELECT actor_kind FROM garage_changes WHERE action = 'exit.superseded' AND subject_id = $1", [prior.id])).rows);
  assert.deepEqual(lines.map((l) => l.actor_kind), ['key'], 'the line names who picked');
});

test('decisions are limited a minute for each key', async () => {
  const g = await garage('decide-limit');
  const id = randomUUID();
  for (let i = 0; i < DECISIONS_PER_MINUTE; i += 1) assert.equal((await decide(g, id, {})).status, 400);
  const res = await decide(g, id, {});
  assert.equal(res.status, 429);
  assert.equal((await res.json()).code, 'too_many_decisions');
  assert.ok(Number(res.headers.get('retry-after')) >= 1);
});

test('the database holds the shapes: a decision only with a person\'s method, and a typed time within 90 days', async () => {
  const g = await garage('decide-db');
  const insert = (method, decision, days = 1) => withTenant(g.tenant, (c) => c.query(
    `INSERT INTO exits (tenant_id, garage_id, lane_id, event_id, exit_at, method, claimed_entry_at, decision)
     VALUES ($1, $2, $3, 'db' || replace(gen_random_uuid()::text, '-', ''), now(), $4,
             CASE WHEN $4 IN ('driver_word', 'attendant_time') THEN now() - make_interval(days => $6) END, $5)`,
    [g.tenant, g.world.garage, g.world.exitLane, method, decision === null ? null : JSON.stringify(decision), days]));
  const good = { how: 'entered_at', result: 'fee', decided_by: 'key:desk', decided_at: new Date().toISOString(), amount_minor: 100, reason: 'customer word' };
  await assert.rejects(insert('attendant_time', null), /exits_decided_by_a_person/);
  await assert.rejects(insert('driver_word', good), /exits_decided_by_a_person/);
  await assert.rejects(insert('attendant_time', { ...good, reason: null }), /exits_decision_is_a_record/);
  await assert.rejects(insert('attendant_time', { ...good, decided_by: '' }), /exits_decision_is_a_record/);
  await assert.rejects(insert('attendant_time', good, 91), /exits_word_is_a_time/);
  await insert('attendant_time', good, 89);
});

/** As if the engine had refused this case's stay: held, needing a person. */
const heldByEngine = (g, exitId) => withTenant(g.tenant, (c) => c.query(
  `UPDATE exits SET quote = quote || '{"refusal": [{"kind": "gap", "code": "GAP_TEST_ONLY"}]}'::jsonb WHERE id = $1`, [exitId]));

test('a held car -- matched, its fee not worked out -- is decided by a typed time: priced, and its stay ended when it leaves', async () => {
  const g = await garage('decide-held-time');
  const { session } = await enter(g, 'HELD123', 'HELD123');
  const matched = await atExit(g, { plate_characters: read('HELD123') });
  assert.equal(matched.session_id, session.id);
  await heldByEngine(g, matched.id);
  const c = await oneCase(g, matched.id);
  assert.deepEqual([c.kind, c.needs, c.what_happened_code], ['held', 'person', 'not_priced']);
  const res = await decide(g, matched.id, { entered_at: ago(120), reason: 'customer said two hours' });
  assert.equal(res.status, 200, await res.clone().text());
  const { decision, exit: after } = await res.json();
  assert.deepEqual([decision.result, decision.amount_minor], ['fee', 500]);
  assert.deepEqual([after.method, after.session_id, after.needs], ['attendant_time', null, 'payment']);
  const before = await withTenant(g.tenant, async (cl) => (await cl.query('SELECT exit_at FROM sessions WHERE id = $1', [session.id])).rows[0]);
  assert.equal(before.exit_at, null, 'the car is still at the exit: its stay is open');
  const closed = await call(g.exit, 'POST', '/lane/sessions/close', { event_id: randomUUID(), exit_id: matched.id, exit_at: ago(0.1), exit_confirmation: 'confirmed' });
  assert.equal(closed.status, 200, await closed.clone().text());
  const after_ = await withTenant(g.tenant, async (cl) => (await cl.query('SELECT exit_at, ended FROM sessions WHERE id = $1', [session.id])).rows[0]);
  assert.ok(after_.exit_at, 'the car has left: its matched stay is ended, not left open');
  assert.deepEqual([after_.ended.reason, after_.ended.exit_cases, after_.ended.decision.amount_minor], ['ended', [matched.id], 500]);
});

test('a held car picks its own stay again: priced now, and its own case is not replaced', async () => {
  const g = await garage('decide-held-pick');
  const { session } = await enter(g, 'HELD234', 'HELD234');
  const matched = await atExit(g, { plate_characters: read('HELD234') });
  await heldByEngine(g, matched.id);
  const res = await decide(g, matched.id, { stay: session.id });
  assert.equal(res.status, 200, await res.clone().text());
  const { decision, exit: after } = await res.json();
  assert.equal(decision.result, 'fee');
  assert.deepEqual([after.method, after.session_id, after.closed, after.needs], ['attendant_pick', session.id, false, 'payment']);
  const lines = await withTenant(g.tenant, async (cl) =>
    (await cl.query("SELECT 1 FROM garage_changes WHERE action = 'exit.superseded' AND subject_id = $1", [matched.id])).rows);
  assert.equal(lines.length, 0, 'nothing replaced');
});

test("a car the driver gave a time for that could not be priced is decided by a typed time", async () => {
  const g = await garage('decide-held-word');
  const exit = await atExit(g, { plate_characters: read('WORD999') });
  assert.equal((await call(g.exit, 'POST', `/lane/exits/${exit.id}/word`, { entry_at: ago(60) })).status, 200);
  await heldByEngine(g, exit.id);
  assert.equal((await oneCase(g, exit.id)).needs, 'person');
  const res = await decide(g, exit.id, { entered_at: ago(120), reason: 'customer said two hours' });
  assert.equal(res.status, 200, await res.clone().text());
  const { exit: after } = await res.json();
  assert.deepEqual([after.method, after.claimed_entry_at !== null, after.needs], ['attendant_time', true, 'payment']);
});

/** A garage of `spaces` (or none) whose plan `plan` is stored as it is, with its lanes, a key and lane tokens. */
async function plannedGarage(name, { spaces = null, plan }) {
  const tenant = await createTenant(name);
  const built = await withTenant(tenant, async (c) => {
    const id = (await c.query(
      "INSERT INTO garages (tenant_id, name, timezone, currency, spaces) VALUES ($1, 'Planned', 'America/New_York', 'USD', $2) RETURNING id",
      [tenant, spaces])).rows[0].id;
    const lane = async (n, d) => (await c.query('INSERT INTO lanes (tenant_id, garage_id, name, direction) VALUES ($1,$2,$3,$4) RETURNING id', [tenant, id, n, d])).rows[0].id;
    const entryLane = await lane('Entry 1', 'entry');
    const exitLane = await lane('Exit 1', 'exit');
    await storePlan(c, tenant, id, plan);
    await activateGarage(c, tenant, id);
    return { garage: id, entryLane, exitLane };
  });
  const op = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'desk',$2)`, [tenant, hashToken(op)]));
  return { tenant, world: built, op, entry: await token(tenant, built.entryLane, 'entry'), exit: await token(tenant, built.exitLane, 'exit') };
}

/** 10.00 an hour, and 20% more on the time when the garage is at least half full at entry. */
function busyPlan() {
  const plan = flatHourlyPlan({ hourlyMinor: 1000, version: 'busy-v1' });
  plan.rules.push({
    id: 'busy', type: 'fill_level', stage: 'ADJUST', space_classes: ['standard'],
    threshold_bp: 5000, percent_bp: 2000, rounding: 'up', raises_specials: 'yes', raises_vip_extra: 'no',
  });
  return plan;
}

test('a typed time at a garage that charges more when full is priced on how full it was then, from the platform\'s own record', async () => {
  const g = await plannedGarage('decide-busy', { spaces: 2, plan: busyPlan() });
  // Two cars came in three hours ago and are still inside: full since then.
  await enter(g, 'BUSY111', 'BUSY111', 180);
  await enter(g, 'BUSY222', 'BUSY222', 180);
  const late = await atExit(g, { plate_characters: read('QQQ1111') });
  const busy = await decide(g, late.id, { entered_at: ago(120), reason: 'customer said two hours' });
  assert.equal(busy.status, 200, await busy.clone().text());
  assert.equal((await busy.json()).decision.amount_minor, 2400, 'two hours at 10.00, 20% more: the garage was full then');
  const early = await atExit(g, { plate_characters: read('QQQ2222') });
  const quiet = await decide(g, early.id, { entered_at: ago(240), reason: 'customer said four hours' });
  assert.equal(quiet.status, 200, await quiet.clone().text());
  assert.equal((await quiet.json()).decision.amount_minor, 4000, 'four hours at 10.00: empty when it came in, no busy price');
});

test('a typed time from before the garage\'s first rates is priced on those first rates', async () => {
  const startAt = ago(30);
  const g = await plannedGarage('decide-first-rates', { plan: flatHourlyPlan({ version: 'late-start', effectiveFrom: startAt }) });
  const exit = await atExit(g, { plate_characters: read('EARLY12') });
  const res = await decide(g, exit.id, { entered_at: ago(120), reason: 'customer said two hours' });
  assert.equal(res.status, 200, await res.clone().text());
  assert.deepEqual([(await res.json()).decision.amount_minor], [500], 'two hours at 2.50, on the first rates');
  const kept = await withTenant(g.tenant, async (c) => (await c.query('SELECT quote FROM exits WHERE id = $1', [exit.id])).rows[0]);
  assert.equal(kept.quote.priced_on_first_rates.plan_version, 'late-start', 'the quote says so');
  const plan = await withTenant(g.tenant, async (c) => (await c.query('SELECT document FROM rate_plans WHERE garage_id = $1', [g.world.garage])).rows[0]);
  assert.equal(Date.parse(plan.document.effective_from), Date.parse(startAt), 'the rates themselves are not changed');
});

test('what the rates cannot price is not recorded: the reasons are named, and the case waits for another decision', async () => {
  // A garage that charges more when full but has no number of spaces: how full it was cannot be known.
  const g = await plannedGarage('decide-not-priced', { spaces: null, plan: busyPlan() });
  const exit = await atExit(g, { plate_characters: read('NOSPACE') });
  const res = await decide(g, exit.id, { entered_at: ago(120), reason: 'customer said two hours' });
  assert.equal(res.status, 422, await res.clone().text());
  const body = await res.json();
  assert.equal(body.code, 'not_priced');
  assert.ok(body.details.reasons.includes('GAP_NO_OCCUPANCY_AT_ENTRY'), JSON.stringify(body.details));
  const kept = await withTenant(g.tenant, async (c) => (await c.query('SELECT method, decision FROM exits WHERE id = $1', [exit.id])).rows[0]);
  assert.deepEqual([kept.method, kept.decision], ['none', null], 'nothing recorded: the case can be decided again');
});

test('a picked car from before the garage\'s first rates is priced on those first rates', async () => {
  const g = await plannedGarage('decide-pick-first-rates', { plan: flatHourlyPlan({ version: 'late-start-pick', effectiveFrom: ago(30) }) });
  const { session } = await enter(g, 'EARLY99', 'EARLY99', 120);
  const matched = await atExit(g, { plate_characters: read('EARLY99') });
  assert.deepEqual([matched.session_id, matched.needs], [session.id, 'person'], 'the stay came in before any rate: held');
  const res = await decide(g, matched.id, { stay: session.id });
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal((await res.json()).decision.amount_minor, 500, 'two hours at 2.50, on the first rates');
  const kept = await withTenant(g.tenant, async (c) => (await c.query('SELECT quote FROM exits WHERE id = $1', [matched.id])).rows[0]);
  assert.equal(kept.quote.priced_on_first_rates.plan_version, 'late-start-pick');
});
