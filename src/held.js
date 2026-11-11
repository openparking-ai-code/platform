/**
 * HELD, NOT RETIRED (decided 2026-11-09): the stuck-stays list, ending a
 * stay from it, and the garage walk stay switched off until the walk is
 * worked out in detail. The walk belongs in the My Portal app: walk through
 * the garage, match the plates of the cars found to the current car
 * inventory (from the entry), and make the adjustments. That detail is
 * planned for when Open Parking starts.
 *
 * Off unless the deployment sets GARAGE_CLEANUP=on. Off, each of these doors
 * answers 404 `not_switched_on` after the caller's sign-in and permission
 * are checked, and writes nothing. The code, its tables and its tests stay,
 * so the walk can be rebuilt to that detail rather than from nothing. The
 * suite switches it on (test/helpers.js); test/held.test.js holds the off
 * state.
 */
import { HttpError } from './errors.js';

export const HELD_SETTING = 'GARAGE_CLEANUP';
export const HELD_CODE = 'not_switched_on';

/** True only for the exact word `on`. Read on every request, so a test may flip it. */
export function cleanupOn(env = process.env) {
  return env[HELD_SETTING] === 'on';
}

/** Express middleware: the door is held unless the setting is on. */
export function heldUnlessOn(req, res, next) {
  if (cleanupOn()) return next();
  return next(new HttpError(404, 'this is switched off on this deployment', HELD_CODE));
}
