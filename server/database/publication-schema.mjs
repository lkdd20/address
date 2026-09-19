export const publicationPreservationSchema = `
ALTER TABLE cn_community_sources ADD COLUMN IF NOT EXISTS accepted_strategy_version TEXT NOT NULL DEFAULT '';
ALTER TABLE cn_ingest_candidates ADD COLUMN IF NOT EXISTS postcode TEXT NOT NULL DEFAULT '';
UPDATE cn_community_sources AS source SET accepted_strategy_version=candidate.strategy_version
FROM cn_ingest_candidates candidate WHERE candidate.provider=source.provider
  AND candidate.provider_poi_id=source.provider_poi_id AND candidate.decision='accepted'
  AND candidate.response_hash=source.response_hash AND source.accepted_strategy_version='';
`;
