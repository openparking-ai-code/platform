#!/usr/bin/env node
/**
 * The control for a person's decision on an exit case no stay was found for
 * (0053).
 *
 * Every property below is broken, one at a time, and
 * `test/exit-decision.test.js` with `test/exit-decision-payments.test.js` is
 * REQUIRED to go red -- with at least one
 * test still green, so a break that stops the file running is not mistaken
 * for one the tests caught. A pass is the failure.
 *
 * SOURCE breaks are applied to a COPY of the tree in a temporary directory; no
 * tracked file is edited. `node_modules` is symlinked rather than reinstalled.
 *
 *   pick_any_stay                a stay that is not one of the case's possible cars is priced
 *   decided_twice                a second decision is taken
 *   matched_case_decided         a matched, priced case is decided again
 *   held_not_decidable           a held car (its fee not worked out) cannot be decided, only let out
 *   not_priced_recorded          a decision the rates cannot price is recorded, and the case is stuck
 *   own_case_replaced            a held car picking its own stay replaces its own case
 *   typed_time_no_fullness       a typed time is priced with no figure for how full the garage was
 *   first_rates_ignored          a typed time from before the first rates is refused, not priced on them
 *   pick_first_rates_ignored     a picked car from before the first rates is refused, not priced on them
 *   matched_stay_left_open       a held car decided by a typed time leaves its matched stay open after it has gone
 *   let_out_case_decided         a case a person let out is decided
 *   typed_after_exit             a typed time after the exit is priced
 *   typed_too_old                a typed time beyond 90 days is priced
 *   typed_without_reason         a typed time is taken without a reason
 *   zero_said_as_fee             a fee of zero is answered as a fee
 *   decider_unnamed              the decision does not say who
 *   decision_unlogged            the decision leaves no line in the change log
 *   picture_any_event            a case serves any picture of its account
 *   picture_any_garage           a case's picture is served through another garage
 *   case_any_garage              one case is read through another garage
 *   pick_not_superseding         a picked stay's other open case is left open
 *   no_limit                     decisions are not limited
 *   lane_name_missing            the case does not name its lane
 *   pick_cancels_first           a pick cancels the picked car's payment at another lane before it has won
 *   pick_over_open_payment       a car paying at another lane is picked, its case closed under the card
 *   payment_window_missed        a payment written while the decision waited is not seen
 *   replaced_line_stale          the "replaced" line reads the old case as the first read saw it
 *
 * SCHEMA breaks build a SCRATCH DATABASE from a copy of `migrations/` with one
 * statement of 0053 edited, so the property genuinely never existed there.
 *
 *   decision_without_method      a decision may sit on a case of another method
 *   typed_time_any_age           a typed time may be any age
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  cpSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import pg from 'pg';

const ROOT = resolve(import.meta.dirname, '..');
const SCRATCH = process.env.EXIT_DECISION_SCRATCH_DB || 'openparking_exit_decision_control';

const SOURCE_BREAKS = [
  {
    name: 'pick_any_stay',
    why: "a stay that is not one of the case's possible cars is priced",
    file: 'src/exitDecisions.js',
    from: "  if (ask?.how === 'stay' && !(Array.isArray(row.candidates) && row.candidates.includes(ask.stay))) {",
    to: '  if (false) {',
  },
  {
    name: 'decided_twice',
    why: 'a second decision is taken',
    file: 'src/exitDecisions.js',
    from: '  if (row.decision) {',
    to: '  if (false) {',
  },
  {
    name: 'matched_case_decided',
    why: 'a matched, priced case is decided again',
    file: 'src/exitDecisions.js',
    from: '  if (s.settled || !DECIDABLE_NEEDS.includes(s.needs)) {',
    to: '  if (s.settled) {',
    // The write's own guard too: each alone keeps a priced case as it is.
    also: [{ file: 'src/exitDecisions.js', from: "        AND (method = 'none' OR quote IS NULL OR COALESCE(jsonb_typeof(quote->'refusal'), 'null') <> 'null')", to: '' }],
  },
  {
    name: 'held_not_decidable',
    why: 'a held car (its fee not worked out) cannot be decided, only let out',
    file: 'src/exitDecisions.js',
    from: "const DECIDABLE_NEEDS = Object.freeze(['driver_word', 'person']);",
    to: "const DECIDABLE_NEEDS = Object.freeze(['driver_word']);",
  },
  {
    name: 'not_priced_recorded',
    why: 'a decision the rates cannot price is recorded, and the case is stuck',
    file: 'src/app.js',
    from: "        if (exitDecisions.resultOf(quote).result === 'not_priced') throw exitDecisions.refuseNotPriced(quote);\n",
    to: '',
  },
  {
    name: 'own_case_replaced',
    why: 'a held car picking its own stay replaces its own case',
    file: 'src/app.js',
    from: "[prior = null] = (await exits.openCasesOfStay(client, tenantId, ask.stay, { lock: true })).filter((c) => c.id !== row.id);",
    to: '[prior = null] = await exits.openCasesOfStay(client, tenantId, ask.stay, { lock: true });',
  },
  {
    name: 'let_out_case_decided',
    why: 'a case a person let out is decided',
    file: 'src/exitDecisions.js',
    from: "  if (row.person) throw conflict('exit_already_let_out'",
    to: "  if (false) throw conflict('exit_already_let_out'",
  },
  {
    name: 'typed_after_exit',
    why: 'a typed time after the exit is priced',
    file: 'src/exitDecisions.js',
    from: '    if (ask.enteredAt > exitAt) throw',
    to: '    if (false) throw',
  },
  {
    name: 'typed_too_old',
    why: 'a typed time beyond 90 days is priced',
    file: 'src/exitDecisions.js',
    from: '    if (exitAt - ask.enteredAt > TYPED_MAX_DAYS * 86_400_000) {',
    to: '    if (false) {',
  },
  {
    name: 'typed_without_reason',
    why: 'a typed time is taken without a reason',
    file: 'src/exitDecisions.js',
    from: '    if (reason.length < REASON_MIN || reason.length > REASON_MAX) {',
    to: '    if (false) {',
  },
  {
    name: 'zero_said_as_fee',
    why: 'a fee of zero is answered as a fee',
    file: 'src/exitDecisions.js',
    from: "result: due === 0 ? 'no_fee' : 'fee'",
    to: "result: 'fee'",
  },
  {
    name: 'decider_unnamed',
    why: 'the decision does not say who',
    file: 'src/exitDecisions.js',
    from: "    done_by: doneBy ?? null,\n",
    to: '    done_by: null,\n',
  },
  {
    name: 'decision_unlogged',
    why: 'the decision leaves no line in the change log',
    file: 'src/app.js',
    from: "          action: 'exit.decide',",
    to: "          action: 'exit.let_out',",
  },
  {
    name: 'picture_any_event',
    why: 'a case serves any picture of its account',
    file: 'src/exitDecisions.js',
    from: '        AND (p.event_id = e.event_id\n',
    to: '        AND (true\n',
  },
  {
    name: 'picture_any_garage',
    why: "a case's picture is served through another garage",
    file: 'src/exitDecisions.js',
    from: '      WHERE e.tenant_id = $1 AND e.garage_id = $2 AND e.id = $3 AND p.id = $4',
    to: '      WHERE e.tenant_id = $1 AND $2::uuid IS NOT NULL AND e.id = $3 AND p.id = $4',
  },
  {
    name: 'case_any_garage',
    why: 'one case is read through another garage',
    file: 'src/app.js',
    from: '        const row = await exits.caseById(client, req.tenantId, garage.id, req.params.exitId);\n        if (!row) return null;',
    to: "        const row = (await client.query('SELECT e.*, NULL::jsonb AS payment, NULL::jsonb AS stay_payment FROM exits e WHERE e.id = $1', [req.params.exitId])).rows[0];\n        if (!row) return null;",
  },
  {
    name: 'pick_not_superseding',
    why: "a picked stay's other open case is left open",
    file: 'src/app.js',
    from: "          await exits.endCase(client, tenantId, prior.id, { why: 'superseded', by_exit: row.id });",
    to: '',
  },
  {
    name: 'no_limit',
    why: 'decisions are not limited',
    file: 'src/app.js',
    from: '      if (!limit.allowed) {\n        const refusal = new HttpError(429, `at most ${exitDecisions.DECISIONS_PER_MINUTE}',
    to: '      if (false) {\n        const refusal = new HttpError(429, `at most ${exitDecisions.DECISIONS_PER_MINUTE}',
  },
  {
    name: 'pick_cancels_first',
    why: "a pick cancels the picked car's payment at another lane before it has won",
    file: 'src/app.js',
    from: '      const out = await changeTx(req, (client) => decide(client));',
    to: "      if (ask.how === 'stay') await settlePriorCase({ tenantId, garageId: req.params.garageId, sessionId: ask.stay, eventId: '' });\n      const out = await changeTx(req, (client) => decide(client));",
  },
  {
    name: 'pick_over_open_payment',
    why: 'a car paying at another lane is picked, its case closed under the card',
    file: 'src/app.js',
    from: "          if (now?.payment?.status === 'open') {\n            throw conflict('stay_paying_elsewhere',",
    to: "          if (false) {\n            throw conflict('stay_paying_elsewhere',",
  },
  {
    name: 'payment_window_missed',
    why: 'a payment written while the decision waited is not seen',
    file: 'src/app.js',
    from: "          if (now?.payment?.status === 'open') {\n            throw conflict('stay_paying_elsewhere',",
    to: "          if (prior?.payment?.status === 'open') {\n            throw conflict('stay_paying_elsewhere',",
  },
  {
    name: 'replaced_line_stale',
    why: 'the "replaced" line reads the old case as the first read saw it',
    file: 'src/app.js',
    // The decision's own line (src/app.js, the attendant's pick): the lane's exit
    // has a `prior = now;` of its own, further in, and it comes first in the file.
    from: '          // The fresh picture from here on: what the replaced case paid, for its line.\n          prior = now;\n',
    to: '          // The fresh picture from here on: what the replaced case paid, for its line.\n',
  },
  {
    name: 'typed_time_no_fullness',
    why: 'a typed time is priced with no figure for how full the garage was',
    file: 'src/app.js',
    // The decision's typed time, not the driver's word: since the driver's word
    // is priced on fullness too it has a line like this one, earlier in the file.
    from: 'const session = { entry_at: ask.enteredAt, currency: garage.currency, occupancy_at_entry_bp: occupancy };',
    to: 'const session = { entry_at: ask.enteredAt, currency: garage.currency, occupancy_at_entry_bp: null };',
  },
  {
    name: 'first_rates_ignored',
    why: 'a typed time from before the first rates is refused, not priced on them',
    file: 'src/app.js',
    from: 'session, vehicle: null, exitAt: new Date(row.exit_at), firstRatesBefore: true,',
    to: 'session, vehicle: null, exitAt: new Date(row.exit_at), firstRatesBefore: false,',
  },
  {
    name: 'pick_first_rates_ignored',
    why: 'a picked car from before the first rates is refused, not priced on them',
    file: 'src/app.js',
    from: 'session: open, vehicle, exitAt: new Date(row.exit_at), firstRatesBefore: true,',
    to: 'session: open, vehicle, exitAt: new Date(row.exit_at), firstRatesBefore: false,',
  },
  {
    name: 'matched_stay_left_open',
    why: "a held car decided by a typed time leaves its matched stay open after it has gone",
    file: 'src/app.js',
    from: '            if (exitCase.decision?.matched_stay) await endMatchedStay(',
    to: '            if (false) await endMatchedStay(',
  },
  {
    name: 'lane_name_missing',
    why: 'the case does not name its lane',
    file: 'src/exitDecisions.js',
    from: '    lane: { id: row.lane_id, name: laneName },',
    to: '    lane: { id: row.lane_id, name: null },',
  },
];

const ADDED_0053 = '0053_exit_case_decision.sql';

const SCHEMA_BREAKS = [
  {
    name: 'decision_without_method',
    why: 'a decision may sit on a case of another method',
    edits: [{
      file: ADDED_0053,
      from: "  CHECK ((method IN ('attendant_pick', 'attendant_time')) = (decision IS NOT NULL));",
      to: '  CHECK (true);',
    }],
  },
  {
    name: 'typed_time_any_age',
    why: 'a typed time may be any age',
    edits: [{
      file: ADDED_0053,
      from: "  AND (claimed_entry_at IS NULL OR (claimed_entry_at <= exit_at AND claimed_entry_at >= exit_at - interval '90 days'))",
      to: '  AND (claimed_entry_at IS NULL OR claimed_entry_at <= exit_at)',
    }],
  },
];

const SUITE = ['--test', 'test/exit-decision.test.js', 'test/exit-decision-payments.test.js'];

function stage() {
  const dir = mkdtempSync(join(tmpdir(), 'openparking-exit-decision-control-'));
  for (const entry of ['src', 'test', 'scripts', 'migrations', 'package.json']) {
    cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  }
  symlinkSync(join(ROOT, 'node_modules'), join(dir, 'node_modules'), 'dir');
  return dir;
}

function run(dir, extraEnv = {}) {
  return spawnSync(process.execPath, SUITE, {
    cwd: dir,
    env: { ...process.env, ...extraEnv },
    stdio: 'pipe',
    encoding: 'utf8',
  });
}

function counts(result) {
  const line = (label) => {
    const match = result.stdout.match(new RegExp(`^[ℹ#] ${label} (\\d+)\\s*$`, 'm'));
    return match ? Number(match[1]) : null;
  };
  return { pass: line('pass'), fail: line('fail') };
}

/**
 * A break is a control only when the suite RAN and went red: at least one test
 * failed AND at least one passed. All failed is a file that could not run --
 * an anchor that moved, a scratch database that did not build -- and it is
 * reported as not a control, never as "fails as required".
 */
function judge(name, why, result) {
  const { pass, fail } = counts(result);
  const label = name.padEnd(36);
  if (result.status === 0 || !fail) {
    console.error(`  ${label} *** PASSED WHEN ${why.toUpperCase()} — the suite is not measuring this ***`);
    return false;
  }
  if (!pass) {
    console.error(`  ${label} *** NOT A CONTROL — ${pass} passed, ${fail} failed: the break fails everything ***`);
    return false;
  }
  console.log(`  ${label} fails as required when ${why} — ${pass} passed, ${fail} failed`);
  return true;
}

function required(name) {
  const value = process.env[name];
  if (!value) {
    console.error(`${name} is required`);
    process.exit(1);
  }
  return value;
}

const adminUrl = required('DATABASE_URL');
const appPassword = required('APP_DB_PASSWORD');

const host = new URL(adminUrl).host;
const scratchAdmin = new URL(adminUrl);
scratchAdmin.pathname = `/${SCRATCH}`;
const scratchApp = new URL(`postgres://openparking_app@${host}/${SCRATCH}`);
scratchApp.password = appPassword;
const maintenance = new URL(required('SUPERUSER_URL'));
maintenance.pathname = '/postgres';

const scratchEnv = {
  DATABASE_URL: scratchAdmin.toString(),
  APP_DATABASE_URL: scratchApp.toString(),
};

async function withAdmin(url, fn) {
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.end();
  }
}

/** A scratch database built from `migrations/` with one statement of 0053 edited. */
async function buildScratch(dir, brk) {
  await withAdmin(maintenance.toString(), async (c) => {
    await c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`);
  });

  const partial = mkdtempSync(join(tmpdir(), 'openparking-exit-decision-migrations-'));
  for (const file of readdirSync(join(ROOT, 'migrations')).filter((f) => f.endsWith('.sql'))) {
    copyFileSync(join(ROOT, 'migrations', file), join(partial, file));
  }
  for (const edit of brk.edits) {
    const path = join(partial, edit.file);
    const sql = readFileSync(path, 'utf8');
    if (!sql.includes(edit.from)) {
      rmSync(partial, { recursive: true, force: true });
      return { ok: false, where: edit.file };
    }
    writeFileSync(path, sql.replace(edit.from, edit.to));
  }

  for (const script of ['scripts/prepare-database.js', 'scripts/migrate.js']) {
    const result = spawnSync(process.execPath, [script], {
      cwd: dir,
      env: { ...process.env, ...scratchEnv, MIGRATIONS_DIR: partial },
      encoding: 'utf8',
    });
    if (result.status !== 0) {
      console.error(result.stdout, result.stderr);
      throw new Error(`${script} failed against the scratch database`);
    }
  }
  rmSync(partial, { recursive: true, force: true });
  return { ok: true };
}

let failures = 0;

const intactDir = stage();
try {
  console.log('== control A: the suite must PASS intact ==');
  const intact = run(intactDir);
  const { pass, fail } = counts(intact);
  if (intact.status === 0 && pass > 0 && fail === 0) {
    console.log(`  control A OK — ${pass} passed`);
  } else {
    console.error(`  CONTROL A FAILED — the suite does not pass even intact: ${pass} passed, ${fail} failed`);
    console.error(intact.stdout);
    console.error(intact.stderr);
    failures += 1;
  }
} finally {
  rmSync(intactDir, { recursive: true, force: true });
}

console.log('\n== control B: each SOURCE break must make it FAIL ==');
for (const brk of SOURCE_BREAKS) {
  const dir = stage();
  try {
    const path = join(dir, brk.file);
    const source = readFileSync(path, 'utf8');
    if (!source.includes(brk.from)) {
      console.error(`  ${brk.name.padEnd(36)} *** ANCHOR NOT FOUND in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    // Exactly once: an anchor found twice breaks whichever comes first, which
    // may be another route's line, and the control then measures nothing.
    if (source.split(brk.from).length !== 2) {
      console.error(`  ${brk.name.padEnd(36)} *** ANCHOR FOUND MORE THAN ONCE in ${brk.file} ***`);
      failures += 1;
      continue;
    }
    writeFileSync(path, source.replace(brk.from, brk.to));
    let moved = null;
    for (const more of brk.also ?? []) {
      const morePath = join(dir, more.file);
      const moreSource = readFileSync(morePath, 'utf8');
      if (moreSource.split(more.from).length !== 2) { moved = more.file; break; }
      writeFileSync(morePath, moreSource.replace(more.from, more.to));
    }
    if (moved) {
      console.error(`  ${brk.name.padEnd(36)} *** ANCHOR NOT FOUND EXACTLY ONCE in ${moved} ***`);
      failures += 1;
      continue;
    }
    if (!judge(brk.name, brk.why, run(dir))) failures += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

console.log('\n== control C: each SCHEMA break must make it FAIL ==');
for (const brk of SCHEMA_BREAKS) {
  const dir = stage();
  try {
    const built = await buildScratch(dir, brk);
    if (!built.ok) {
      console.error(`  ${brk.name.padEnd(36)} *** ANCHOR NOT FOUND in ${built.where} ***`);
      failures += 1;
      continue;
    }
    if (!judge(brk.name, brk.why, run(dir, scratchEnv))) failures += 1;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// The scratch database is a database with a property removed: dropped, so
// nothing is later run against it by accident.
await withAdmin(maintenance.toString(), (c) =>
  c.query(`DROP DATABASE IF EXISTS ${pg.escapeIdentifier(SCRATCH)}`),
);

if (failures) {
  console.error(`\n${failures} control(s) failed. Do not trust the exit decision tests.`);
  process.exit(1);
}
console.log('\nall controls OK — the suite fails on every property a person\'s exit decision rests on.');
