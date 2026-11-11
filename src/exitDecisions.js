import { randomUUID } from 'node:crypto';
import { HttpError } from './errors.js';
import * as exits from './exits.js';
import { score } from './exitMatch.js';

/**
 * A PERSON DECIDES AN EXIT CASE THE PLATFORM COULD NOT MATCH (0053).
 *
 * The car is at an exit lane and no stay was found for it (`method: none`):
 * the matcher found nothing clear and the picker could not tell, or was not
 * asked. What a person needs to decide is read here in one shape -- the case
 * as the attendant's screen shows it (`presentCase`): the lane, the exit's
 * plate as the lane read it, the exit's pictures, what happened, the fee, the
 * possible cars with their entry pictures and why each is possible, and the
 * decision once there is one.
 *
 * The decision is one of two, once per case:
 *
 *   {stay}                   one of the case's possible cars: the case is
 *                            priced as that stay (`attendant_pick`);
 *   {entered_at, reason}     none of them: the time the car came in, typed,
 *                            with why, priced by the engine on the garage's
 *                            own rules (`attendant_time`).
 *
 * THE PLATFORM PRICES IT, never the person: the answer says fee, no fee, or
 * not priced. It lets no car out whatever it owes -- that is the let-out --
 * but a car whose decision comes to no fee is settled like any case at zero,
 * and a fee is paid at the lane as any fee is.
 */

/** The longest stay a typed entry time may claim: 90 days, the driver's word's own limit (the owner, 2026-11-08: "ok"). */
export const TYPED_MAX_DAYS = exits.WORD_MAX_DAYS;
/** A typed time's reason, counted as the attendant's app counts it. */
export const REASON_MIN = 3;
export const REASON_MAX = 200;
/** Pictures a car shows on the screen: the exit's and each possible car's. */
export const PICTURES_SHOWN = 4;
/** Decisions a minute for one key or person (Claude's choice). */
export const DECISIONS_PER_MINUTE = 30;

export const DECIDED_EVENT_KIND = 'exit_decided_by_person';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// A time with its offset, as the attendant's app sends it (an ISO string).
const AT_WITH_OFFSET = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;

const refused = (message) => new HttpError(400, message, 'decision_refused');
/** What a case may need for a person to decide it: no stay found, or a fee that could not be worked out. */
const DECIDABLE_NEEDS = Object.freeze(['driver_word', 'person']);
const conflict = (code, message) => new HttpError(409, message, code);

/**
 * The body, read strictly: exactly `{stay}` (an id), or exactly
 * `{entered_at, reason}` (a time with its offset; 3 to 200 characters once
 * trimmed). Anything else is `400 decision_refused`.
 */
export function decisionRequest(body) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : null;
  const keys = b ? Object.keys(b).sort().join(',') : '';
  if (keys === 'stay') {
    if (typeof b.stay !== 'string' || !UUID.test(b.stay)) throw refused('stay must be the id of one of the case\'s possible cars');
    return { how: 'stay', stay: b.stay.toLowerCase() };
  }
  if (keys === 'entered_at,reason') {
    if (typeof b.entered_at !== 'string' || !AT_WITH_OFFSET.test(b.entered_at.trim())) {
      throw new HttpError(400,
        'entered_at must be a date and time with its time zone offset, such as 2026-10-27T09:00:00-04:00', 'entry_time_without_offset');
    }
    const at = new Date(b.entered_at.trim());
    if (Number.isNaN(at.getTime())) throw refused('entered_at is not a valid time');
    const reason = typeof b.reason === 'string' ? b.reason.trim() : '';
    if (reason.length < REASON_MIN || reason.length > REASON_MAX) {
      throw refused(`reason is required with a typed time: ${REASON_MIN} to ${REASON_MAX} characters`);
    }
    return { how: 'entered_at', enteredAt: at, reason };
  }
  throw refused('send {stay} to pick one of the possible cars, or {entered_at, reason} to type when the car came in');
}

/**
 * Whether this case may be decided now, read again under its lock. A case
 * already decided is `409 already_decided` with the decision; a case that has
 * moved on another way names how.
 */
export function assertDecidable(row, ask) {
  if (!row) throw new HttpError(404, 'exit case not found', 'exit_not_found');
  if (row.decision) {
    const err = conflict('already_decided', 'this exit case has already been decided');
    err.details = { decision: presentDecision(row.decision) };
    throw err;
  }
  if (row.closed_at) throw conflict('exit_closed', 'the car has already left: this case is closed');
  if (row.person) throw conflict('exit_already_let_out', 'a person has already let this car out');
  // WHAT IS DECIDED HERE (the owner, 2026-11-08: "someone needs to put entry
  // time. Either they invent a time or take customer word for it and we
  // record, calculate the fee if there is any, collect the fee if there is
  // any and open the gate"): a car no stay was found for, and a car whose fee
  // could not be worked out (held). A car that is priced, paid or settled
  // needs no decision.
  const s = exits.settledOf(row);
  if (s.settled || !DECIDABLE_NEEDS.includes(s.needs)) {
    throw conflict('exit_needs_no_decision', 'this car needs no decision: it is priced, paid or settled');
  }
  if (row.payment && ['open', 'succeeded'].includes(row.payment.status)) {
    throw conflict('payment_in_progress', 'a payment has started on this exit case');
  }
  if (ask?.how === 'stay' && !(Array.isArray(row.candidates) && row.candidates.includes(ask.stay))) {
    throw new HttpError(400, 'that car is not one of this case\'s possible cars', 'stay_not_a_candidate');
  }
  if (ask?.how === 'entered_at') {
    const exitAt = new Date(row.exit_at);
    if (ask.enteredAt > exitAt) throw conflict('entry_after_exit', 'the entry time typed is after the car reached the exit');
    if (exitAt - ask.enteredAt > TYPED_MAX_DAYS * 86_400_000) {
      throw conflict('entry_too_old', `the entry time typed is more than ${TYPED_MAX_DAYS} days before the exit`);
    }
  }
}

/** What a quote comes to, in plain terms: a fee, no fee (covered or zero), or not priced. */
export function resultOf(quote) {
  if (!quote || quote.refusal) return { result: 'not_priced', amount_minor: null, currency: quote?.currency ?? null };
  const due = exits.dueOf(quote);
  if (due === null) return { result: 'not_priced', amount_minor: null, currency: quote.currency ?? null };
  return { result: due === 0 ? 'no_fee' : 'fee', amount_minor: due, currency: quote.currency };
}

/**
 * A decision the rates cannot price is not recorded: the case stays as it
 * was, to be decided again (another time, another car), and the answer names
 * the engine's reasons. No price is made up (Claude's choice; what the rates
 * cannot price is with the owner).
 */
export function refuseNotPriced(quote) {
  const codes = Array.isArray(quote?.refusal) ? [...new Set(quote.refusal.map((f) => f?.code).filter((c) => typeof c === 'string'))] : [];
  const err = new HttpError(422, "the garage's rates cannot work out a fee for this stay; nothing was recorded", 'not_priced');
  err.details = { reasons: codes };
  return err;
}

/** The record kept on the case (0053's `exits.decision`). */
export function decisionRecord({ ask, quote, enteredAt, by, doneBy, matchedStay = null, at = new Date() }) {
  return {
    id: randomUUID(),
    how: ask.how,
    stay: ask.how === 'stay' ? ask.stay : null,
    // A held case's own stay, when a typed time took its place: the car left
    // through this case, so its close ends that stay (`endMatchedStay`).
    ...(ask.how === 'entered_at' && matchedStay ? { matched_stay: matchedStay } : {}),
    entered_at: new Date(enteredAt).toISOString(),
    reason: ask.how === 'entered_at' ? ask.reason : null,
    ...resultOf(quote),
    decided_by: String(by).slice(0, 300),
    done_by: doneBy ?? null,
    decided_at: at.toISOString(),
  };
}

/** The decision as answered: the record, with `no_fee` said in so many words. */
export function presentDecision(d) {
  if (!d) return null;
  return {
    id: d.id,
    how: d.how,
    stay: d.stay,
    entered_at: d.entered_at,
    reason: d.reason,
    result: d.result,
    no_fee: d.result === 'no_fee',
    amount_minor: d.amount_minor,
    currency: d.currency,
    decided_by: d.decided_by,
    done_by: d.done_by,
    decided_at: d.decided_at,
    matched_stay: d.matched_stay ?? null,
  };
}

/** Writes the decision on a case that has none and still needs one (no stay found, or not priced); null when it moved. */
export async function recordDecision(client, tenantId, exitId, { method, sessionId, claimedEntryAt, quote, decision }) {
  const { rows } = await client.query(
    `UPDATE exits SET method = $3, session_id = $4, claimed_entry_at = $5, quote = $6, decision = $7
      WHERE tenant_id = $1 AND id = $2 AND decision IS NULL AND person IS NULL AND closed_at IS NULL
        AND (method = 'none' OR quote IS NULL OR COALESCE(jsonb_typeof(quote->'refusal'), 'null') <> 'null')
      RETURNING *`,
    [tenantId, exitId, method, sessionId, claimedEntryAt, JSON.stringify(quote), JSON.stringify(decision)],
  );
  return exits.withPayment(client, tenantId, rows[0] ?? null);
}

/**
 * The exit's plate as the lane read it. The platform keeps the plate as the
 * lane sends it at the exit: its sure characters folded onto look-alikes
 * (O as 0, I as 1, B as 8, S as 5) and `?` where a position was not sure --
 * never a whole plate. So `read` is `sure` (every position sure), `unsure`
 * (some not) or `none` (unreadable, not seen, or nothing sent); never
 * `agreed`, which this platform cannot say.
 */
export function exitPlate(row) {
  if (row.plate_state !== 'read' || !row.plate_pattern) return { plate: null, read: 'none', folded: false };
  return { plate: row.plate_pattern, read: row.plate_pattern.includes('?') ? 'unsure' : 'sure', folded: true };
}

/** What happened, as a code and a short plain sentence (Claude's wording, not the owner's). */
export function whatHappened(row) {
  const s = exits.settledOf(row);
  if (s.settled) return { code: null, words: null };
  if (s.needs === 'person') return { code: 'not_priced', words: 'The fee for this car could not be worked out.' };
  if (s.needs !== 'driver_word') return { code: null, words: null };
  const many = Array.isArray(row.candidates) && row.candidates.length > 0;
  if (!many) return { code: 'no_match', words: 'No car parked here could be matched to this car.' };
  const asked = row.picker && !['off', 'not_asked'].includes(row.picker.outcome);
  return asked
    ? { code: 'several_ai_unsure', words: 'More than one parked car could be this one, and the picture check could not tell which.' }
    : { code: 'several', words: 'More than one parked car could be this one.' };
}

/** Why a possible car is possible: the whole plate, part of it, or only its look. */
function whyOf(row, stay) {
  const exitId = {
    plate: row.plate_state ? { state: row.plate_state, rule: row.plate_rule, pattern: row.plate_pattern } : null,
    colour_code: row.colour_code,
    size: row.size,
  };
  const s = score(exitId, stay);
  if (s.excluded) return 'look';
  const pattern = row.plate_state === 'read' ? row.plate_pattern ?? '' : '';
  const sure = [...pattern].filter((c) => c !== '?').length;
  if (sure > 0 && s.agree === sure && !pattern.includes('?')) return 'plate';
  if (s.agree > 0) return 'partial_plate';
  return 'look';
}

/**
 * What the screen shows of each case in `rows`, read in four queries for any
 * number of cases: the lanes' names, the exits' pictures, the possible cars
 * and their entry pictures. Every read names this tenant and this garage.
 */
export async function caseViews(client, tenantId, garageId, rows) {
  const views = new Map();
  if (rows.length === 0) return views;
  const laneIds = [...new Set(rows.map((r) => r.lane_id))];
  const { rows: laneRows } = await client.query(
    'SELECT id, name FROM lanes WHERE tenant_id = $1 AND garage_id = $2 AND id = ANY($3::uuid[])',
    [tenantId, garageId, laneIds],
  );
  const laneName = new Map(laneRows.map((l) => [l.id, l.name]));
  const stayIds = [...new Set(rows.flatMap((r) => (Array.isArray(r.candidates) ? r.candidates : [])).filter((x) => UUID.test(String(x))))];
  const { rows: stayRows } = stayIds.length ? await client.query(
    `SELECT s.id, s.entry_at, s.open_event_id, s.entry_plate_state, s.entry_plate_rule, s.entry_plate_pattern,
            s.entry_colour_code, s.entry_size, v.plate,
            CASE WHEN v.ticket_ref IS NOT NULL THEN 'ticket' WHEN v.unread_ref IS NOT NULL THEN 'unread' ELSE 'plate' END AS identity_kind
       FROM sessions s JOIN vehicles v ON v.id = s.vehicle_id AND v.tenant_id = s.tenant_id
      WHERE s.tenant_id = $1 AND s.garage_id = $2 AND s.id = ANY($3::uuid[])`,
    [tenantId, garageId, stayIds],
  ) : { rows: [] };
  const stays = new Map(stayRows.map((s) => [s.id, s]));
  const eventIds = [...new Set([...rows.map((r) => r.event_id), ...stayRows.map((s) => s.open_event_id)])];
  const pictures = await picturesByEvent(client, tenantId, garageId, eventIds);
  for (const row of rows) views.set(row.id, presentCase(row, { laneName: laneName.get(row.lane_id) ?? null, stays, pictures }));
  return views;
}

async function picturesByEvent(client, tenantId, garageId, eventIds) {
  const byEvent = new Map();
  if (eventIds.length === 0) return byEvent;
  const { rows } = await client.query(
    `SELECT id, event_id FROM (
       SELECT p.id, p.event_id, p.taken_at, row_number() OVER (PARTITION BY p.event_id ORDER BY p.taken_at, p.id) AS n
         FROM entry_pictures p
        WHERE p.tenant_id = $1 AND p.garage_id = $2 AND p.event_id = ANY($3::text[])) ranked
      WHERE n <= $4 ORDER BY event_id, taken_at, id`,
    [tenantId, garageId, eventIds, PICTURES_SHOWN],
  );
  for (const r of rows) {
    if (!byEvent.has(r.event_id)) byEvent.set(r.event_id, []);
    byEvent.get(r.event_id).push(r.id);
  }
  return byEvent;
}

const KIND = Object.freeze({ driver_word: 'unmatched', person: 'held' });

/** One case as the attendant's screen reads it. */
export function presentCase(row, { laneName = null, stays = new Map(), pictures = new Map() } = {}) {
  const s = exits.settledOf(row);
  const exitPictures = pictures.get(row.event_id) ?? [];
  const happened = whatHappened(row);
  const fee = row.quote ? resultOf(row.quote) : null;
  return {
    id: row.id,
    lane: { id: row.lane_id, name: laneName },
    raised_at: row.created_at,
    exit_at: row.exit_at,
    kind: s.settled ? null : KIND[s.needs] ?? null,
    settled: s.settled,
    needs: s.needs ?? null,
    what_happened: happened.words,
    what_happened_code: happened.code,
    exit: { ...exitPlate(row), picture: exitPictures[0] ?? null, pictures: exitPictures },
    fee: fee && fee.result !== 'not_priced'
      ? { amount_minor: fee.amount_minor, currency: fee.currency, no_fee: fee.result === 'no_fee' }
      : null,
    candidates: (Array.isArray(row.candidates) ? row.candidates : [])
      .map((id) => stays.get(id))
      .filter(Boolean)
      .map((stay) => ({
        stay: stay.id,
        plate: stay.plate ?? stay.entry_plate_pattern ?? null,
        entered_at: stay.entry_at,
        pictures: pictures.get(stay.open_event_id) ?? [],
        why: whyOf(row, stay),
      })),
    decision: presentDecision(row.decision),
  };
}

/**
 * One picture a case shows, as the image itself: the exit's own (under the
 * case's lane event), or a possible car's entry picture -- and no other.
 * Through the garage: another garage's or account's case is not found.
 */
export async function casePicture(client, tenantId, garageId, exitId, pictureId) {
  const { rows } = await client.query(
    `SELECT p.content_type, p.image
       FROM exits e
       JOIN entry_pictures p ON p.tenant_id = e.tenant_id AND p.garage_id = e.garage_id
      WHERE e.tenant_id = $1 AND e.garage_id = $2 AND e.id = $3 AND p.id = $4
        AND (p.event_id = e.event_id
             OR p.event_id IN (SELECT s.open_event_id FROM sessions s
                                WHERE s.tenant_id = e.tenant_id AND s.garage_id = e.garage_id
                                  AND s.id IN (SELECT (jsonb_array_elements_text(e.candidates))::uuid)))`,
    [tenantId, garageId, exitId, pictureId],
  );
  return rows[0] ?? null;
}
