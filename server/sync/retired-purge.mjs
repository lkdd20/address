// Rows retired for good never return: repairs judge them again only through a new revision, and inference only reads
// published rows. They are deleted with their evidence, index, inference and recovery rows (cascades); a source that
// later supplies a valid address imports it afresh. Translation-related retirements stay, since recovery may fix them.
export const PERMANENT_RETIREMENT_PREFIXES = ['address-structure-', 'administrative-names-', 'postcode-required-'];
export const PERMANENT_RETIREMENT = new RegExp(`^publication-validation:(?:${PERMANENT_RETIREMENT_PREFIXES.join('|')})`, 'u');

const delay = (milliseconds) => new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
const tables = ['address_pool', 'address_pool_evidence', 'address_generation_index', 'address_postcode_inference', 'translation_recovery'];

// Rows an import wrote within the last day are left alone: a running import stores postcode-less rows retired until its
// postcode inference publishes them, and the purge runs beside it.
const IN_FLIGHT_MS = 24 * 60 * 60_000;

export const purgePermanentRetirements = async ({ database, countryCode, prefixes = PERMANENT_RETIREMENT_PREFIXES, pageSize = 2_000, pauseMs = 100,
  now = () => new Date() }) => {
  const country = String(countryCode || '').toUpperCase();
  if (!prefixes.length) return { countryCode: country, deleted: 0 };
  const matches = prefixes.map(() => 'retired_at LIKE ?').join(' OR ');
  const patterns = prefixes.map((prefix) => `publication-validation:${prefix}%`);
  const seenBefore = new Date(now().getTime() - IN_FLIGHT_MS).toISOString();
  let deleted = 0;
  for (;;) {
    const ids = (await database.prepare(`DELETE FROM address_pool WHERE id IN (
        SELECT id FROM address_pool WHERE country_code=? AND active=0 AND (${matches}) AND last_seen_at<? LIMIT ?)
      RETURNING id`).bind(country, ...patterns, seenBefore, pageSize).all()).results;
    deleted += ids.length;
    if (ids.length < pageSize) break;
    await delay(pauseMs);
  }
  return { countryCode: country, deleted };
};

// A mass delete leaves dead rows the planner still counts; reclaiming them online keeps index scans fast. The space is
// reused by later imports rather than returned to the disk. Runs on its own client without a statement timeout.
export const vacuumAddressTables = async (client) => {
  await client.query("SET statement_timeout TO '0'");
  for (const table of tables) await client.query(`VACUUM (ANALYZE) address.${table}`);
};
