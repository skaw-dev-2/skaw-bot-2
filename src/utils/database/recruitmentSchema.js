export const RECRUITMENT_TABLE_STATEMENTS = [
  "CREATE TABLE IF NOT EXISTS skaw_recruitment_settings (guild_id VARCHAR(20) PRIMARY KEY, data JSONB NOT NULL DEFAULT '{}', version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)",
  "CREATE TABLE IF NOT EXISTS skaw_recruitment_profiles (id BIGSERIAL PRIMARY KEY, guild_id VARCHAR(20) NOT NULL, profile_key VARCHAR(80) NOT NULL, name VARCHAR(100) NOT NULL, profile_type VARCHAR(20) NOT NULL CHECK (profile_type IN ('employment', 'partnership')), division VARCHAR(100) NOT NULL DEFAULT '', emoji VARCHAR(20) NOT NULL DEFAULT '📄', channel_prefix VARCHAR(40) NOT NULL, data JSONB NOT NULL DEFAULT '{}', enabled BOOLEAN NOT NULL DEFAULT FALSE, archived BOOLEAN NOT NULL DEFAULT FALSE, sort_order INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1, created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE (guild_id, profile_key), UNIQUE (guild_id, id))",
  "CREATE TABLE IF NOT EXISTS skaw_recruitment_counters (guild_id VARCHAR(20) NOT NULL, counter_key VARCHAR(40) NOT NULL, current_value BIGINT NOT NULL DEFAULT 0, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (guild_id, counter_key))",
  "CREATE TABLE IF NOT EXISTS skaw_recruitment_applications (id BIGSERIAL PRIMARY KEY, guild_id VARCHAR(20) NOT NULL, application_id VARCHAR(40) NOT NULL, sequence_number BIGINT NOT NULL, interaction_id VARCHAR(30) NOT NULL, profile_id BIGINT NOT NULL, profile_snapshot JSONB NOT NULL, applicant_id VARCHAR(20) NOT NULL, applicant_tag VARCHAR(100) NOT NULL, channel_id VARCHAR(20), channel_name VARCHAR(100) NOT NULL, application_status VARCHAR(40) NOT NULL DEFAULT 'awaiting_submission', ticket_status VARCHAR(30) NOT NULL DEFAULT 'creating', claimed_by VARCHAR(20), priority VARCHAR(20) NOT NULL DEFAULT 'normal', submitted_at TIMESTAMP, closed_at TIMESTAMP, archived_at TIMESTAMP, transcript_html TEXT, data JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, last_activity_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE (guild_id, application_id), UNIQUE (guild_id, sequence_number), UNIQUE (guild_id, interaction_id), UNIQUE (guild_id, channel_id), FOREIGN KEY (guild_id, profile_id) REFERENCES skaw_recruitment_profiles(guild_id, id) ON DELETE RESTRICT)",
  "CREATE TABLE IF NOT EXISTS skaw_recruitment_events (id BIGSERIAL PRIMARY KEY, guild_id VARCHAR(20) NOT NULL, application_row_id BIGINT, application_id VARCHAR(40), action VARCHAR(60) NOT NULL, actor_id VARCHAR(20), actor_tag VARCHAR(100), metadata JSONB NOT NULL DEFAULT '{}', created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, FOREIGN KEY (application_row_id) REFERENCES skaw_recruitment_applications(id) ON DELETE SET NULL)",
  "CREATE TABLE IF NOT EXISTS skaw_recruitment_versions (id BIGSERIAL PRIMARY KEY, guild_id VARCHAR(20) NOT NULL, scope VARCHAR(20) NOT NULL, scope_id VARCHAR(80) NOT NULL, version INTEGER NOT NULL, snapshot JSONB NOT NULL, published BOOLEAN NOT NULL DEFAULT FALSE, actor_id VARCHAR(20), created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, UNIQUE (guild_id, scope, scope_id, version))"
];

export const RECRUITMENT_INDEX_STATEMENTS = [
  "CREATE INDEX IF NOT EXISTS idx_skaw_rec_profiles_guild_enabled ON skaw_recruitment_profiles(guild_id, enabled, archived, sort_order)",
  "CREATE INDEX IF NOT EXISTS idx_skaw_rec_apps_guild_created ON skaw_recruitment_applications(guild_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_skaw_rec_apps_guild_status ON skaw_recruitment_applications(guild_id, application_status, ticket_status)",
  "CREATE INDEX IF NOT EXISTS idx_skaw_rec_apps_profile ON skaw_recruitment_applications(guild_id, profile_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_skaw_rec_apps_applicant ON skaw_recruitment_applications(guild_id, applicant_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_skaw_rec_events_guild_created ON skaw_recruitment_events(guild_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_skaw_rec_events_application ON skaw_recruitment_events(application_id, created_at DESC)",
  "CREATE INDEX IF NOT EXISTS idx_skaw_rec_versions_scope ON skaw_recruitment_versions(guild_id, scope, scope_id, version DESC)"
];

export async function ensureRecruitmentSchema(queryable) {
  if (!queryable || typeof queryable.query !== 'function') {
    throw new Error('PostgreSQL query interface is required to initialize SKAW Recruitment.');
  }
  for (const statement of RECRUITMENT_TABLE_STATEMENTS) {
    await queryable.query(statement);
  }
  for (const statement of RECRUITMENT_INDEX_STATEMENTS) {
    await queryable.query(statement);
  }
  return true;
}
