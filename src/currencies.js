/**
 * The currencies a new garage can keep its money in, in three groups. The
 * admin screen offers exactly this list (its src/garages.js), so the platform
 * takes what the screen offers and nothing else.
 *
 *   AMERICAS  every currency in use today (ISO 4217, list one, as of 2026) of
 *             North, Central and South America and the Caribbean;
 *   EUROPE    every one of a country or territory the UN's statistical
 *             regions (M49) place in Europe, and Turkey's;
 *   ALSO      Australia's, Japan's and New Zealand's.
 *
 * Change a group here, and the same group in the admin's src/garages.js, and
 * nowhere else.
 *
 * This list is asked only when a garage is created (src/garageFields.js). A
 * garage already saved in a currency left out here keeps it: its currency is
 * never changed, and every read, price and report of it goes on as before.
 *
 * Written down here, not asked of the runtime: what Node's own list holds
 * depends on the ICU it was built with, and has codes withdrawn years ago.
 */
const AMERICAS =
  'ARS AWG BBD BMD BOB BRL BSD BZD CAD CLP COP CRC CUP DOP FKP GTQ GYD HNL ' +
  'HTG JMD KYD MXN NIO PAB PEN PYG SRD SVC TTD USD UYU VED VES XCD XCG';
const EUROPE =
  'ALL BAM BYN CHF CZK DKK EUR GBP GIP HUF ISK MDL MKD NOK PLN RON RSD RUB SEK TRY UAH';
const ALSO = 'AUD JPY NZD';

export const CURRENCY_CODES = Object.freeze(`${AMERICAS} ${EUROPE} ${ALSO}`.split(' ').sort());

const KNOWN = new Set(CURRENCY_CODES);

/** Whether `code` is one of them, exactly as written: "usd" is not. */
export const isCurrency = (code) => typeof code === 'string' && KNOWN.has(code);
