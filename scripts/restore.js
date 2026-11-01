import { spawnSync } from 'node:child_process';
import { mkdtemp, readdir, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
import { logger } from '../src/utils/logger.js';
import {
  assertBackupKey,
  decryptArchiveFile,
  getMissingBackupTables,
  listArchiveEntries,
  readAndValidateManifest,
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

function sameDatabaseEndpoint(first, second) {
  try {
    const a = new URL(first);
    const b = new URL(second);
    return a.protocol === b.protocol
      && a.hostname === b.hostname
      && (a.port || '') === (b.port || '')
      && a.pathname === b.pathname;
  } catch {
    return first === second;
  }
}

function runCommand(command, args, label) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: process.platform === 'win32',
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error(label + ' could not start: ' + result.error.message);
  if (result.status !== 0) {
    throw new Error(label + ' failed: ' + (result.stderr || result.stdout || 'Unknown PostgreSQL client error'));
  }
}

async function resolveLatestBackup(backupDir, allowPlaintext) {
  const entries = await readdir(backupDir, { withFileTypes: true });
  const extensions = allowPlaintext ? ['.dump.enc', '.dump'] : ['.dump.enc'];
  const candidates = entries
    .filter((entry) => entry.isFile() && extensions.some((extension) => entry.name.endsWith(extension)))
    .map((entry) => entry.name)
    .sort((left, right) => right.localeCompare(left));
  if (candidates.length === 0) {
    throw new Error('No encrypted .dump.enc backup files found in ' + backupDir + '.');
  }
  return path.join(backupDir, candidates[0]);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const backupDir = path.resolve(args['backup-dir'] || process.env.BACKUP_DIR || path.join(process.cwd(), 'database', 'backups'));
  const targetUrl = process.env.POSTGRES_RESTORE_URL;
  if (!targetUrl) throw new Error('Set POSTGRES_RESTORE_URL to the NEW/target PostgreSQL connection string. Restore will not fall back to POSTGRES_URL.');
  const sourceUrl = process.env.POSTGRES_URL || process.env.DATABASE_URL;
  if (sourceUrl && sameDatabaseEndpoint(sourceUrl, targetUrl)) {
    throw new Error('Restore stopped because POSTGRES_RESTORE_URL points to the same database as POSTGRES_URL/DATABASE_URL. Use a separate new target database.');
  }
  if (!args.confirm) throw new Error('Restore requires explicit confirmation. Re-run with --confirm after checking the target database.');

  const inputPath = args.input ? path.resolve(args.input) : await resolveLatestBackup(backupDir, args['allow-plaintext'] === true);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'skaw-postgres-restore-'));
  const plainDumpPath = path.join(tempDir, 'database.dump');
  let restoreInputPath = inputPath;

  try {
    runCommand('pg_restore', ['--version'], 'pg_restore version check');

    if (inputPath.endsWith('.dump.enc')) {
      const encryptionKey = assertBackupKey(process.env.BACKUP_ENCRYPTION_KEY);
      const manifestPath = args.manifest ? path.resolve(args.manifest) : inputPath + '.manifest.json';
      await readAndValidateManifest(inputPath, manifestPath);
      await decryptArchiveFile(inputPath, plainDumpPath, encryptionKey);
      restoreInputPath = plainDumpPath;
    } else if (inputPath.endsWith('.dump') && args['allow-plaintext'] === true) {
      logger.warn('Restoring a plaintext database dump. Keep this file local and delete it securely after use.', {
        event: 'restore.plaintext_warning',
      });
      if (!(await stat(inputPath)).isFile()) throw new Error('Plaintext dump path is not a file.');
    } else {
      throw new Error('Only encrypted .dump.enc backups are accepted. Use --allow-plaintext only for an older trusted local .dump file.');
    }

    const archiveListing = await listArchiveEntries('pg_restore', restoreInputPath);
    const missingTables = getMissingBackupTables(archiveListing);
    if (missingTables.length > 0) {
      throw new Error('Restore stopped before changing the target database. Required tables are missing: ' + missingTables.join(', '));
    }

    logger.warn('Starting database restore. The target database will be modified; this action cannot be undone.', {
      event: 'restore.start',
      inputFile: path.basename(inputPath),
      targetDatabaseConfigured: true,
    });

    runCommand('pg_restore', [
      '--clean',
      '--if-exists',
      '--no-owner',
      '--no-privileges',
      '--exit-on-error',
      '--single-transaction',
      '--dbname',
      targetUrl,
      restoreInputPath,
    ], 'PostgreSQL restore');

    logger.info('Database restore completed. Run npm run restore:verify with POSTGRES_VERIFY_URL set to this target database before starting the bot.', {
      event: 'restore.completed',
      inputFile: path.basename(inputPath),
    });
    process.stdout.write('Restore completed. Run: npm run restore:verify\n');
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  logger.error('Database restore command failed', {
    event: 'restore.failed',
    error: error.message,
  });
  process.exit(1);
});
