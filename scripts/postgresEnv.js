/**
 * Convert a PostgreSQL URL into libpq environment variables so pg_dump and
 * pg_restore do not receive database passwords in their process arguments.
 */
export function buildPostgresClientEnv(connectionString, baseEnv = process.env) {
  let url;
  try {
    url = new URL(connectionString);
  } catch {
    throw new Error('The PostgreSQL connection string is not a valid URL.');
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol)) {
    throw new Error('The database URL must use postgres:// or postgresql://.');
  }

  const env = { ...baseEnv };
  delete env.POSTGRES_URL;
  delete env.DATABASE_URL;
  delete env.POSTGRES_RESTORE_URL;
  delete env.POSTGRES_VERIFY_URL;
  delete env.POSTGRES_PASSWORD;

  const host = url.hostname.replace(/^\[|\]$/g, '');
  const database = decodeURIComponent(url.pathname.replace(/^\/+/, ''));
  if (!host || !database) throw new Error('The PostgreSQL URL must include a host and database name.');

  env.PGHOST = host;
  env.PGPORT = url.port || baseEnv.POSTGRES_PORT || '5432';
  env.PGDATABASE = database;
  env.PGUSER = url.username ? decodeURIComponent(url.username) : (baseEnv.POSTGRES_USER || 'postgres');
  env.PGPASSWORD = url.password ? decodeURIComponent(url.password) : (baseEnv.POSTGRES_PASSWORD || '');
  env.PGAPPNAME = 'skaw-postgres-backup';

  const urlSslMode = url.searchParams.get('sslmode');
  const configuredSsl = String(baseEnv.POSTGRES_SSL || '').toLowerCase();
  if (urlSslMode) env.PGSSLMODE = urlSslMode;
  else if (configuredSsl === 'false' || configuredSsl === '0') env.PGSSLMODE = 'disable';
  else if (configuredSsl === 'true' || configuredSsl === '1') env.PGSSLMODE = 'require';
  else if (baseEnv.RAILWAY_ENVIRONMENT || baseEnv.RAILWAY_PROJECT_ID || baseEnv.NODE_ENV === 'production') env.PGSSLMODE = 'require';

  return env;
}
