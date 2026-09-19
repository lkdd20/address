# Country Address Contracts

Updated: 2026-09-13. Runtime contract: `src/domain/address-contracts.mjs`.

## Administrative abbreviations

The `admin1Code` field is published only for `US`, `CA`, `AU`, `BR`, `MX`, and `IT`. Every published record in those countries must carry the authoritative code and the formatter uses that code in the postal line. All other countries retain the full administrative name; a source-provided road abbreviation may be preserved but is never invented.

## Native scripts

| Code | Native script | Fixed administrative semantics |
|---|---|---|
| CN | Simplified Chinese | province-level, city, district/county |
| HK | Traditional Chinese | area (Hong Kong Island/Kowloon/New Territories), 18 district, locality |
| TW | Traditional Chinese | county/city, township/town/city/district, village/li (optional) |
| JP | Japanese | prefecture, municipality, town/chome |
| KR | Korean | province/metro, si/gun/gu, eup/myeon/dong or road address |
| TH | Thai | changwat, amphoe/khet, tambon/khwaeng |
| SA | Arabic | city, district, additional number |
| RU | Cyrillic | federal subject, locality, street/unit |

## Release gate

China requires a residential community, real numbered street address, six-digit postcode, validated administrative hierarchy and residential evidence. Other countries accept verified streets as well as existing precise addresses. Every record must retain its source, street, country-specific administrative fields, valid coordinates and native language.

Singapore additionally requires a source-backed six-digit postcode at every precision. Missing or ambiguous postcodes are never borrowed or generated. Existing source records without a valid postcode are retained but retired from publication; migration rebuilds the generation index and derived counts without reopening exhausted sources. Hong Kong and the other countries retain their existing postcode rules.

| `matchLevel` | Required precision | Postcode | Residential evidence |
|---|---|---|---|
| `street` | Non-China only; real named street and required administrative hierarchy; no house, building or unit | SG: source-backed six digits required. Elsewhere retain a verified unambiguous value; otherwise empty | Not required; property type is `unknown`, no residential claim |
| `premise` | Real street and house/building number | Country-specific requirements | Required for China and for a residential property label |
| `subpremise` | Premise fields plus a source-provided unit | Country-specific requirements | Same as premise |

A failed contract is rejected during import and checked again when read. A street is deduplicated by country, administrative hierarchy and normalized street name, not by coordinates, postcode or provider ID. Multiple points on the same street do not create extra addresses. Street administrative fields cannot be inferred from the nearest catalog point.

Native variants must pass the country script gate before publication. Alphanumeric premise identifiers and single-letter building or zone identifiers are allowed when attached to an address component suffix; ordinary foreign-language text is not. English and Simplified Chinese variants are generated during synchronization; the automatic backfill worker repairs legacy untranslated fields in bounded batches and yields while a source sync is active. The public translation endpoint validates every translated component and falls back to the complete native address instead of publishing a mixed-language line.

Country totals, administrative coverage, candidate SQL and the generation index share the reader's English and Simplified Chinese semantic-field script rules from `src/domain/address-localization.mjs`. Mixed-script variants are excluded even when the Chinese variant contains Han text elsewhere. House, unit and postcode identifiers are not inspected by this language rule. Residential counts remain a separate evidence-backed subset. Automatic publication validation retires invalid legacy rows and refreshes the generation index; index replacement is atomic. Country availability uses published totals. Non-China generation defaults to all eligible records; `residential=true` selects the residential subset.

Generator and shortcut selectors filter zero-availability entries before pagination. Non-China availability comes from the validated generation index, with the same region/city aliases and scopes as generation; China uses its published communities. Region hierarchy boundaries accept paths with or without a trailing slash. Exact catalog filters do not require a catalog centroid; generated address coordinates remain mandatory. Shared postcodes do not imply a unique city, and returned metadata belongs to the representative catalog row. Publication revisions invalidate option caches. Administrative coverage and completion denominators still retain official zero-address nodes.

Migrations verify and reconcile the publication index before deriving administrative coverage from its active rows. They rebuild coverage for every enabled, indexed or previously covered non-China country, including on retries where a previous attempt already retired invalid records. The coverage-only migration mode runs the same index checks and derived-statistics rebuild without reimporting addresses or changing source checkpoints. Ordinary coverage refreshes retain their direct publication and evidence checks.

Production audits sample at least 500 generated bundles per affected country and check address contracts, languages, evidence and sample diversity. Mobile numbers use randomized numbering-plan prefixes and suffixes validated with `libphonenumber-js/mobile`; the audit also checks country attribution and phone diversity. Format validation does not establish that a number is assigned or reachable.


## Translation recovery and provider compatibility revision 6 (2026-09-19)

- Recoverable source records remain stored when translation is unavailable. Discovery, due retries and cache-only reevaluation take bounded turns, so repeatedly cooling providers cannot monopolize recovery. Unchanged deterministic failures retain finite retries; effective provider configuration changes permit reevaluation without resetting source exhaustion or quota ledgers.
- Elapsed credential cooldowns become executable automatically; the broker still enforces live quotas. Repaired non-China records pass the full contract before transactional publication, index and count updates. China retains its existing residential contract.
- Model discovery preserves advertised endpoint and reasoning capabilities. No model is hardcoded; missing reasoning metadata is reported as unknown. The project explicitly sends low reasoning by default, including legacy default settings; advertised levels take precedence on model selection if low is unavailable. Provider omission defaults are not assumed. Prompts affect translation style only, never source facts.
- Numeric repair translates text spans and restores original numeric/alphanumeric tokens, including ordinal identifiers and leading zeros. Publication reads reject changed translated identifiers; date-only expiry remains valid through its UTC date. Source fields, coordinates, administrative identity and source execution fingerprints are unchanged.

- A separate cache-only scan runs automatically even when online providers are disabled or cooling down. It has its own persisted cursor, preserves failure history for unrepaired records, consumes no translation requests, and republishes only fully validated cached/canonical results. Scoped catch-up uses the same bounded code path, never manual queue/checkpoint edits.
- Recovery reads source evidence and prior recovery state in bounded groups; administrative name lookup uses indexed aliases while preserving ambiguous-name rejection. Publication rereads every candidate under the existing transaction locks before changing data.
- Cache catch-up fetches translations per bounded source group and computes all affected dataset totals in one grouped query, avoiding repeated evidence-table scans during publication.
- Recovery workers share a PostgreSQL advisory lease. A competing batch waits without dispatching requests, moving cursors or charging attempts; connection closure releases the lease after interruption. Publication still performs its own source fingerprint and contract checks inside the transaction.

## Per-key translation routing revision 7 (2026-09-19)

- OpenAI-compatible, DeepL and Youdao priorities belong to individual credentials. Legacy provider settings seed per-key routes once; dispatch pins the selected credential in both live requests and automatic recovery. Equal priorities rotate; one failed key does not disable sibling keys. Keyless Google retains one independently configurable route.
- The quality-first AI prompt preserves JSON cardinality, digits and identifiers. Model discovery resolves custom API prefixes and supports manual model IDs. All source, language, coordinate, administrative and publication gates remain unchanged.

## Policy and translation consistency revision 8 (2026-09-19)

- Administrative policy keys use lowercase UTF-8 hex, matching PostgreSQL coverage keys. Legacy aliases are normalized transactionally; canonical settings and explicit clears take precedence. Source exhaustion states and stored address facts are preserved.
- Catalog minimums honor explicit node targets. An overridden node without coverage counts as zero and remains unmet; official zero-address nodes stay in the coverage denominator.
- Initial online import translation follows enabled per-key priorities and pins each broker dispatch to its credential. Caller environment, fetch implementation and cancellation propagate to localization; deferred localization remains the default.
- Display translation caches include source component contents, country and native language. Corrected components invalidate old cache entries; unchanged inputs reuse validated translations. Numeric and HTTP-date Retry-After values are respected.
- Existing source, administrative, coordinate, identifier, language and publication gates remain enforced. DeepL credit accounting is unchanged; no periodic refill is introduced for one-time rewards.
