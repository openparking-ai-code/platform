// HELD DOORS (src/held.js): with GARAGE_CLEANUP not `on`, the stuck-stays
// list, ending a stay from it, the garage walk and the two settings that
// belong to them answer 404 `not_switched_on`, after sign-in and permission,
// and write nothing. Switched on, the same doors answer (the control).
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createApp } from '../src/app.js';
import { pool, withTenant, createTenant, buildWorld } from './helpers.js';
import { generateDeviceToken, hashToken } from '../src/auth.js';
import { HELD_CODE } from '../src/held.js';

let server;
let base;
const was = process.env.GARAGE_CLEANUP;

const call = (tok, method, path, body) =>
  fetch(`${base}/api/v1${path}`, {
    method,
    headers: { 'content-type': 'application/json', ...(tok ? { authorization: `Bearer ${tok}` } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

async function garage(name) {
  const tenant = await createTenant(name);
  const world = await buildWorld(tenant, { hourlyMinor: 250 });
  const op = generateDeviceToken();
  await withTenant(tenant, (c) => c.query(`INSERT INTO operator_tokens (tenant_id, name, token_hash) VALUES ($1,'desk',$2)`, [tenant, hashToken(op)]));
  return { tenant, id: world.garage, op };
}

const doors = (g) => {
  const x = randomUUID();
  return [
    ['GET', `/garages/${g.id}/stays/stuck`],
    ['POST', `/garages/${g.id}/stays/${x}/end`, { left_at: new Date().toISOString(), reason: 'held' }],
    ['POST', `/garages/${g.id}/walks`, { client_ref: 'held-1' }],
    ['POST', `/garages/${g.id}/walks/${x}/sightings`, {}],
    ['POST', `/garages/${g.id}/walks/${x}/sightings/${x}/pick`, {}],
    ['POST', `/garages/${g.id}/walks/${x}/finish`, {}],
    ['GET', `/garages/${g.id}/walks/${x}/sightings/${x}/picture`],
    ['GET', `/garages/${g.id}/walks/${x}`],
  ];
};

before(async () => {
  server = createApp().listen(0);
  await new Promise((r) => server.once('listening', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

after(async () => {
  if (was === undefined) delete process.env.GARAGE_CLEANUP; else process.env.GARAGE_CLEANUP = was;
  await new Promise((r) => server.close(r));
  await pool.end();
});

test('switched off: every held door answers 404 not_switched_on and writes nothing', async () => {
  const g = await garage('held-off');
  for (const value of [undefined, '', 'off', 'ON', 'true', '1']) {
    if (value === undefined) delete process.env.GARAGE_CLEANUP; else process.env.GARAGE_CLEANUP = value;
    for (const [method, path, body] of doors(g)) {
      const res = await call(g.op, method, path, body);
      assert.equal(res.status, 404, `${method} ${path} with ${JSON.stringify(value)}`);
      assert.equal((await res.json()).code, HELD_CODE, `${method} ${path}`);
    }
  }
  const walks = await withTenant(g.tenant, (c) => c.query('SELECT count(*)::int AS n FROM walks WHERE garage_id = $1', [g.id]));
  assert.equal(walks.rows[0].n, 0, 'no walk was started');
});

test('switched off: sign-in is still asked first', async () => {
  delete process.env.GARAGE_CLEANUP;
  const g = await garage('held-noauth');
  for (const [method, path, body] of doors(g)) {
    assert.equal((await call(null, method, path, body)).status, 401, `${method} ${path}`);
  }
});

test('switched off: the two settings that belong to the held doors are refused; the others still save', async () => {
  delete process.env.GARAGE_CLEANUP;
  const g = await garage('held-settings');
  for (const body of [{ stuck_after_hours: 24 }, { walk_complete_percent: 80 }, { spaces: 40, stuck_after_hours: 24 }]) {
    const res = await call(g.op, 'PATCH', `/garages/${g.id}`, body);
    assert.equal(res.status, 404, JSON.stringify(body));
    assert.equal((await res.json()).code, HELD_CODE);
  }
  assert.equal((await call(g.op, 'PATCH', `/garages/${g.id}`, { spaces: 40 })).status, 200, 'spaces still save');
});

test('switched on (control): the same doors answer, and the stuck list reads', async () => {
  process.env.GARAGE_CLEANUP = 'on';
  const g = await garage('held-on');
  const res = await call(g.op, 'GET', `/garages/${g.id}/stays/stuck`);
  assert.equal(res.status, 200, await res.clone().text());
  for (const [method, path, body] of doors(g)) {
    const r = await call(g.op, method, path, body);
    const code = r.status === 204 ? null : (await r.json().catch(() => ({}))).code;
    assert.notEqual(code, HELD_CODE, `${method} ${path} is not held when on`);
  }
  assert.equal((await call(g.op, 'PATCH', `/garages/${g.id}`, { stuck_after_hours: 24 })).status, 200);
});
