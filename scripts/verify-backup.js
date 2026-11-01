import { mkdtemp, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';
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
    const [key, inlineValue] = token.slice(2).split('=');
    if (typeof inlineValue !== 'undefined') args[key] = inlineValue;
    else if (!argv[index + 1] || argv[index + 1].startsWith('--')) args[key] = true;
    else args[key] = argv[++index];
  }
  return args;
}

async function resolveLatestBackup(backupDir) {
  const entries = await readdir(backupDir, { withFileTypes: true });
  const files = entries.filter((entry) => entry.isFile() && entry.name.endsWith('.dump.enc'))
    .map((entry) => entry.name).sort((a, b) => b.localeCompare(a));
  if (!files.length) throw new Error('No encrypted .dump.enc files found in ' + backupDir + '.');
  return path.join(backupDir, files[0]);
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const backupDir = path.resolve(args['backup-dir'] || process.env.BACKUP_DIR || path.join(process.cwd(), 'database', 'backups'));
  const archivePath = args.input ? path.resolve(args.input) : await resolveLatestBackup(backupDir);
  const manifestPath = args.manifest ? path.resolve(args.manifest) : archivePath + '.manifest.json';
  const key = assertBackupKey(process.env.BACKUP_ENCRYPTION_KEY);
  const manifest = await readAndValidateManifest(archivePath, manifestPath);
  const tempDir = await mkdtemp(path.join(os.tmpdir(), 'skaw-postgres-verify-'));
  const dumpPath = path.join(tempDir, 'verified.dump');

  try {
    await decryptArchiveFile(archivePath, dumpPath, key);
    const listing = await listArchiveEntries('pg_restore', dumpPath);
    const missingTables = getMissingBackupTables(listing);
    if (missingTables.length) throw new Error('Archive is readable but incomplete. Missing required tables: ' + missingTables.join(', '));

    const manifestTables = Array.isArray(manifest.includedTables) ? manifest.includedTables : [];
    const manifestListing = manifestTables.map((name) => 'TABLE public ' + name).join('\n');
    const missingManifestTables = getMissingBackupTables(manifestListing);
    if (missingManifestTables.length) {
      throw new Error('Manifest table inventory is incomplete: ' + missingManifestTables.join(', '));
    }

    process.stdout.write([
      'BACKUP VERIFICATION: PASSED',
      'Archive: ' + path.basename(archivePath),
      'Created: ' + manifest.createdAt,
      'Size: ' + manifest.archiveBytes + ' bytes',
      'SHA-256: ' + manifest.sha256,
      'Schema: ' + manifest.schemaLabel + ' (v' + manifest.schemaVersion + ')',
      'Tables: ' + manifestTables.length + ' listed; all required tables found',
      'Encryption: authenticated decryption succeeded',
      'PostgreSQL archive: pg_restore --list succeeded',
      '',
    ].join('\n'));
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }
}

run().catch((error) => {
  process.stderr.write('BACKUP VERIFICATION: FAILED\n' + error.message + '\n');
  process.exit(1);
});
