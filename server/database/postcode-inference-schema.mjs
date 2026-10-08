export const postcodeInferenceSchema = `
CREATE TABLE IF NOT EXISTS address_postcode_inference (
  address_id TEXT PRIMARY KEY REFERENCES address_pool(id) ON DELETE CASCADE,
  postcode TEXT NOT NULL DEFAULT '',
  method TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT '',
  checked_revision TEXT NOT NULL,
  updated_at TEXT NOT NULL
);`;
