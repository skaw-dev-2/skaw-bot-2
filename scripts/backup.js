import { spawnSync } from 'node:child_process';
import { access, mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { logger } from '../src/utils/logger.js';
import { buildPostgresClientEnv } from './postgresEnv.js';
import {
  assertBackupKey,
  encryptArchiveFile,
  getMissingBackupTables,
  listArchiveEntries,
} from './backupCrypto.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: path.join(__dirname, '..', '.env') });

function parseArgs(argv) {
  const args = {};
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (!token.startsWith('--')) continue;
    const [rawKey, inlineValue] = token.slice(2).split('=');
    if (typeof inlineValue !== 'undefined') {
      args[rawKey] = inlineValue;
      continue;
    }
    const nextToken = argv[index + 1];
    if (!nextToken || nextToken.startsWith('--')) {
      args[rawKey] = true;
      continue;
    }
    args[rawKey] = nextToken;
    index += 1;
  }
  return args;
}

function runCommand(command, args, label, env = process.env) {
  const executable = process.platform === 'win32' ? command + '.exe' : command;
  const result = spawnSync(executable, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    env,
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(label + ' could not start: ' + result.error.message);
  if (result.status !== 0) {
    throw new Error(label + ' failed: ' + (result.stderr || result.stdout || 'Unknown PostgreSQL client error'));
  }
  return (result.stdout || '').trim();
}

function timestamp() {
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\.\d{3}Z$/, 'Z');
}

function parseSchemaVersion() {
  const raw = Number.parseInt(process.env.SCHEMA_VERSION || '1', 10);
  return Number.isInteger(raw) && raw > 0 ? raw : 1;
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const databaseUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (!databaseUrl) throw new Error('Set POSTGRES_URL (or DATABASE_URL) in your local .env or environment.');
  const encryptionKey = assertBackupKey(process.env.BACKUP_ENCRYPTION_KEY);
  const backupDir = path.resolve(args['backup-dir'] || process.env.BACKUP_DIR || path.join(process.cwd(), 'database', 'backups'));
  const outputPath = path.resolve(args.output || path.join(backupDir, 'skaw-postgres-' + timestamp() + '.dump.enc'));
  if (!outputPath.endsWith('.dump.enc')) throw new Error('Encrypted backup output must end with .dump.enc.');
  const manifestPath = outputPath + '.manifest.json';
  for (const candidate of [outputPath, manifestPath]) {
    try {
      await access(candidate);
      throw new Error('Refusing to overwrite an existing backup file: ' + candidate);
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
  }
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'skaw-postgres-backup-'));
  const plainDumpPath = path.join(tempDir, 'database.dump');

  try {
    await mkdir(backupDir, { recursive: true });
    const pgDumpVersion = runCommand('pg_dump', ['--version'], 'pg_dump version check');
    runCommand('pg_restore', ['--version'], 'pg_restore version check');

    logger.info('Starting PostgreSQL backup. The raw dump will remain in a temporary directory and will not be committed to GitHub.', {
      event: 'backup.start',
      outputPath,
    });

    const postgresEnv = buildPostgresClientEnv(databaseUrl);
    runCommand('pg_dump', [
      '--format=custom',
      '--no-owner',
      '--no-privileges',
      '--file',
      plainDumpPath,
    ], 'PostgreSQL dump', postgresEnv);

    const archiveListing = await listArchiveEntries('pg_restore', plainDumpPath);
    const missingTables = getMissingBackupTables(archiveListing);
    if (missingTables.length > 0) {
      throw new Error('Backup validation failed. Required PostgreSQL tables are missing: ' + missingTables.join(', '));
    }

    const encrypted = await encryptArchiveFile(plainDumpPath, outputPath, encryptionKey);
    const schemaVersion = parseSchemaVersion();
    const manifest = {
      format: 'skaw-postgresql-backup',
      formatVersion: 1,
      createdAt: new Date().toISOString(),
      application: 'SKAW Bot',
      archive: path.basename(outputPath),
      archiveBytes: encrypted.sizeBytes,
      sha256: encrypted.sha256,
      databaseDumpFormat: 'pg_dump custom archive',
      pgDumpVersion,
      encryption: {
        algorithm: encrypted.algorithm,
        keyDerivation: encrypted.keyDerivation,
        keyDerivationParameters: encrypted.keyDerivationParameters,
      },
      schemaVersion,
      schemaLabel: process.env.SCHEMA_VERSION_LABEL || ('baseline-v' + schemaVersion),
      sourceCommit: process.env.GITHUB_SHA || process.env.SOURCE_COMMIT_SHA || null,
      includedTables: archiveListing.split(/\r?\n/)
        .map((line) => line.match(/\bTABLE\s+public\s+([a-zA-Z0-9_]+)\b/)?.[1])
        .filter(Boolean)
        .filter((value, index, all) => all.indexOf(value) === index)
        .sort(),
      coverage: 'Full database archive. Includes structured application tables and all rows in temp_data/cache_data, where most SKAW feature configuration and records are stored.',
    };

    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
    const finalStats = await stat(outputPath);
    if (finalStats.size >= 90 * 1024 * 1024) {
      logger.warn('Encrypted backup is at least 90 MiB. GitHub ordinary Git files have a 100 MB limit; verify the file size before committing it.', {
        event: 'backup.github_size_warning',
        sizeBytes: finalStats.size,
      });
    }
    logger.info('Encrypted PostgreSQL backup completed and archive listing validated.', {
      event: 'backup.completed',
      outputPath,
      manifestPath,
      sizeBytes: finalStats.size,
      sha256: encrypted.sha256,
      requiredTableCount: 17,
    });
    process.stdout.write(outputPath + '\n' + manifestPath + '\n');
  } catch (error) {
    await rm(outputPath, { force: true }).catch(() => {});
    await rm(manifestPath, { force: true }).catch(() => {});
    throw error;
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  logger.error('Encrypted backup command failed', {
    event: 'backup.failed',
    error: error.message,
  });
  process.exit(1);
});
