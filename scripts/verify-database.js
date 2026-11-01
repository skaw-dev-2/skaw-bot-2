import dotenv from 'dotenv';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });
const { Pool } = pg;

const REQUIRED_TABLES = Object.freeze([
  'guilds', 'users', 'guild_users', 'birthdays', 'giveaways', 'ticket_data', 'afk_status',
  'welcome_configs', 'leveling_configs', 'user_levels', 'economy', 'verification_audit',
  'invite_tracking', 'application_roles', 'temp_data', 'cache_data', 'schema_migrations',
]);

const FEATURE_KEYS = Object.freeze([
  { name: 'Message Manager', pattern: '^guild:[0-9]+:message_manager$' },
  { name: 'Employee Logs Configuration', pattern: '^guild:[0-9]+:employee_logs$' },
  { name: 'Employee Logs Audit', pattern: '^guild:[0-9]+:employee_logs:audit$' },
  { name: 'Employee Log Records', pattern: '^guild:[0-9]+:employee_logs:record:' },
  { name: 'Employee Auto Role', pattern: '^guild:[0-9]+:employee_logs:auto_role$' },
  { name: 'Employee Directory Backfill', pattern: '^guild:[0-9]+:employee_directory:backfill_v1$' },
  { name: 'Employee Directory Index', pattern: '^guild:[0-9]+:employee_directory:index$' },
  { name: 'Employee Directory Members', pattern: '^guild:[0-9]+:employee_directory:member:' },
  { name: 'Employee Role Registry', pattern: '^guild:[0-9]+:employee_logs:role_registry$' },
  { name: 'Role Template System', pattern: '^guild:[0-9]+:role_templates:v1$' },
  { name: 'Company Structure', pattern: '^guild:[0-9]+:company_structure$' },
  { name: 'Role Access Backups', pattern: '^guild:[0-9]+:role_access:backups:v1$' },
  { name: 'Role Access Audit', pattern: '^guild:[0-9]+:role_access:audit:v1$' },
  { name: 'Auto Responder', pattern: '^guild:[0-9]+:auto_responder:v1$' },
  { name: 'Auto Message', pattern: '^guild:[0-9]+:auto_messages$' },
  { name: 'Counting Game', pattern: '^countingGame:' },
]);

async function run() {
  const databaseUrl = process.env.POSTGRES_VERIFY_URL;
  if (!databaseUrl) {
    throw new Error('Set POSTGRES_VERIFY_URL explicitly to the restored PostgreSQL database connection string.');
  }

  const sslEnv = process.env.POSTGRES_SSL?.toLowerCase();
  const ssl = sslEnv === 'false' || sslEnv === '0'
    ? false
    : sslEnv === 'true' || sslEnv === '1'
      ? { rejectUnauthorized: false }
      : (/sslmode=(require|verify-ca|verify-full|prefer)/i.test(databaseUrl)
        || process.env.RAILWAY_ENVIRONMENT
        || process.env.RAILWAY_PROJECT_ID
        || process.env.NODE_ENV === 'production')
        ? { rejectUnauthorized: false }
        : false;
  const pool = new Pool({
    connectionString: databaseUrl,
    ssl,
    connectionTimeoutMillis: 10000,
  });

  try {
    await pool.query('SELECT 1');
    const tableResult = await pool.query(
      'SELECT table_name FROM information_schema.tables WHERE table_schema = $1 AND table_type = $2',
      ['public', 'BASE TABLE'],
    );
    const tableNames = new Set(tableResult.rows.map((row) => row.table_name));
    const missingTables = REQUIRED_TABLES.filter((name) => !tableNames.has(name));

    process.stdout.write('POSTGRESQL RESTORE VERIFICATION\n');
    process.stdout.write('Connection: successful\nTables found: ' + tableNames.size + '\n');

    const rowCounts = new Map();
    for (const tableName of REQUIRED_TABLES) {
      if (!tableNames.has(tableName)) continue;
      const result = await pool.query('SELECT COUNT(*)::text AS count FROM public."' + tableName + '"');
      rowCounts.set(tableName, result.rows[0].count);
    }

    for (const tableName of REQUIRED_TABLES) {
      const status = rowCounts.has(tableName) ? rowCounts.get(tableName) + ' rows' : 'MISSING';
      process.stdout.write('- ' + tableName + ': ' + status + '\n');
    }

    if (tableNames.has('temp_data')) {
      process.stdout.write('\nSKAW FEATURE DATA INVENTORY (temp_data)\n');
      for (const feature of FEATURE_KEYS) {
        const result = await pool.query(
          'SELECT COUNT(*)::text AS count FROM public.temp_data WHERE key ~ $1',
          [feature.pattern],
        );
        const count = Number(result.rows[0].count);
        const label = count > 0 ? count + ' stored key(s)' : 'no stored keys (may be unused on this server)';
        process.stdout.write('- ' + feature.name + ': ' + label + '\n');
      }
    }

    if (missingTables.length > 0) {
      throw new Error('Required tables are missing: ' + missingTables.join(', '));
    }

    process.stdout.write('\nRESULT: all required application tables are present. Feature key counts are informational; zero can mean a feature has not been configured or used yet.\n');
  } finally {
    await pool.end();
  }
}

run().catch((error) => {
  process.stderr.write('POSTGRESQL RESTORE VERIFICATION: FAILED\n' + error.message + '\n');
  process.exit(1);
});
