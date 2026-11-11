-- 0053 — a person decides an exit case the platform could not match.
--
-- The car is at an exit lane, no stay was found for it (`method = 'none'`):
-- the matcher found nothing clear, and the picker could not tell or was not
-- asked. A person who may let a car out looks at the exit's picture and the
-- possible cars, and decides one of two ways:
--
--   attendant_pick   it is one of the case's possible cars: the case names
--                    that stay and is priced as that stay, the same way a
--                    matched case is (credit for what the stay already paid
--                    included);
--   attendant_time   none of them: the person types when the car came in --
--                    the customer's word, or their own judgment -- with a
--                    reason, and the engine prices that time on the garage's
--                    own rules, the way the driver's word is priced.
--
-- The fee, or no fee, is the platform's own, never the person's. Nothing here
-- lets a car out whatever it owes: that is the let-out (0042), unchanged.
--
--   exits.decision   the record of the decision: how (`stay` or
--                    `entered_at`), the stay picked or the time typed, the
--                    reason, what it came to (`result`: fee, no_fee or
--                    not_priced, `amount_minor`, `currency`), who
--                    (`decided_by`, and the name a key said, `done_by`) and
--                    when (`decided_at`). Once per case: it is written only
--                    on a case with none.
--
-- Numbered 0053: open pull requests use 0049 to 0052.
--
-- Run as the database OWNER.

BEGIN;

ALTER TABLE exits
  ADD COLUMN decision jsonb
    CONSTRAINT exits_decision_is_a_record CHECK (
      decision IS NULL OR (
        jsonb_typeof(decision) = 'object'
        -- coalesced: a missing key makes ->> NULL, and a NULL CHECK passes
        AND coalesce(decision->>'how', '') IN ('stay', 'entered_at')
        AND coalesce(decision->>'result', '') IN ('fee', 'no_fee', 'not_priced')
        AND coalesce(jsonb_typeof(decision->'decided_by'), '') = 'string'
        AND length(decision->>'decided_by') BETWEEN 1 AND 300
        AND coalesce(jsonb_typeof(decision->'decided_at'), '') = 'string'
        AND coalesce(jsonb_typeof(decision->'amount_minor'), '') IN ('number', 'null')
        AND (decision->>'how' <> 'entered_at'
             OR (coalesce(jsonb_typeof(decision->'reason'), '') = 'string' AND length(decision->>'reason') BETWEEN 3 AND 200))
      )
    );

ALTER TABLE exits DROP CONSTRAINT exits_method_check;
ALTER TABLE exits ADD CONSTRAINT exits_method_check
  CHECK (method IN ('lane', 'single', 'picker', 'none', 'driver_word', 'attendant_pick', 'attendant_time'));

-- A matched case names its stay -- a person's pick included; an unmatched one names none.
ALTER TABLE exits DROP CONSTRAINT exits_method_names_a_stay;
ALTER TABLE exits ADD CONSTRAINT exits_method_names_a_stay
  CHECK ((method IN ('lane', 'single', 'picker', 'attendant_pick')) = (session_id IS NOT NULL));

-- The driver's word and a person's typed time are each an entry time, no
-- later than the exit and no more than 90 days before it (the longest stay
-- the engine prices).
ALTER TABLE exits DROP CONSTRAINT exits_word_is_a_time;
ALTER TABLE exits ADD CONSTRAINT exits_word_is_a_time CHECK (
  (method IN ('driver_word', 'attendant_time')) = (claimed_entry_at IS NOT NULL)
  AND (claimed_entry_at IS NULL OR (claimed_entry_at <= exit_at AND claimed_entry_at >= exit_at - interval '90 days'))
);

-- A person's decision is the only way to those two methods, and it is kept with them.
ALTER TABLE exits ADD CONSTRAINT exits_decided_by_a_person
  CHECK ((method IN ('attendant_pick', 'attendant_time')) = (decision IS NOT NULL));

COMMIT;
