import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scrypt as scryptCallback,
} from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { appendFile, mkdir, open, rename, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';

const scrypt = promisify(scryptCallback);
const MAGIC = Buffer.from('SKAWPGDUMP1', 'ascii');
const SALT_BYTES = 16;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const SCRYPT_OPTIONS = Object.freeze({ N: 32768, r: 8, p: 1, maxmem: 64 * 1024 * 1024 });
const HEADER_BYTES = MAGIC.length + SALT_BYTES + IV_BYTES;

export function assertBackupKey(value) {
  if (typeof value !== 'string' || Buffer.byteLength(value, 'utf8') < 32) {
    throw new Error('BACKUP_ENCRYPTION_KEY must contain at least 32 UTF-8 bytes. Generate a strong random key and keep it outside GitHub.');
  }
  return value;
}

async function deriveKey(passphrase, salt) {
  assertBackupKey(passphrase);
  return scrypt(passphrase, salt, KEY_BYTES, SCRYPT_OPTIONS);
}

export async function hashFile(filePath) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(filePath)) hash.update(chunk);
  return hash.digest('hex');
}

export async function encryptArchiveFile(inputPath, outputPath, passphrase) {
  assertBackupKey(passphrase);
  const salt = randomBytes(SALT_BYTES);
  const iv = randomBytes(IV_BYTES);
  const header = Buffer.concat([MAGIC, salt, iv]);
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(header);

  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = outputPath + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';

  try {
    await writeFile(temporaryPath, header, { flag: 'wx', mode: 0o600 });
    await pipeline(
      createReadStream(inputPath),
      cipher,
      createWriteStream(temporaryPath, { flags: 'a', mode: 0o600 }),
    );
    await appendFile(temporaryPath, cipher.getAuthTag());
    await rename(temporaryPath, outputPath);
    return {
      sizeBytes: (await stat(outputPath)).size,
      sha256: await hashFile(outputPath),
      algorithm: 'aes-256-gcm',
      keyDerivation: 'scrypt',
      keyDerivationParameters: SCRYPT_OPTIONS,
    };
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    throw error;
  }
}

export async function decryptArchiveFile(inputPath, outputPath, passphrase) {
  assertBackupKey(passphrase);
  const fileInfo = await stat(inputPath);
  if (fileInfo.size <= HEADER_BYTES + TAG_BYTES) {
    throw new Error('Encrypted backup is incomplete or too small.');
  }

  const handle = await open(inputPath, 'r');
  const header = Buffer.alloc(HEADER_BYTES);
  try {
    const result = await handle.read(header, 0, HEADER_BYTES, 0);
    if (result.bytesRead !== HEADER_BYTES || !header.subarray(0, MAGIC.length).equals(MAGIC)) {
      throw new Error('This file is not a supported SKAW encrypted PostgreSQL backup.');
    }
  } finally {
    await handle.close();
  }

  const saltStart = MAGIC.length;
  const salt = header.subarray(saltStart, saltStart + SALT_BYTES);
  const iv = header.subarray(saltStart + SALT_BYTES, HEADER_BYTES);
  const key = await deriveKey(passphrase, salt);
  const decipher = createDecipheriv('aes-256-gcm', key, iv);
  decipher.setAAD(header);

  let trailing = Buffer.alloc(0);
  const tagExtractor = new Transform({
    transform(chunk, encoding, callback) {
      const combined = trailing.length ? Buffer.concat([trailing, chunk]) : chunk;
      if (combined.length <= TAG_BYTES) {
        trailing = combined;
        callback();
        return;
      }
      const ciphertextEnd = combined.length - TAG_BYTES;
      this.push(combined.subarray(0, ciphertextEnd));
      trailing = combined.subarray(ciphertextEnd);
      callback();
    },
    flush(callback) {
      if (trailing.length !== TAG_BYTES) {
        callback(new Error('Encrypted backup is truncated; authentication tag is missing.'));
        return;
      }
      try {
        decipher.setAuthTag(trailing);
        callback();
      } catch (error) {
        callback(error);
      }
    },
  });

  await mkdir(path.dirname(outputPath), { recursive: true });
  const temporaryPath = outputPath + '.' + process.pid + '.' + randomBytes(6).toString('hex') + '.tmp';
  try {
    await pipeline(
      createReadStream(inputPath, { start: HEADER_BYTES }),
      tagExtractor,
      decipher,
      createWriteStream(temporaryPath, { flags: 'wx', mode: 0o600 }),
    );
    await rename(temporaryPath, outputPath);
    return outputPath;
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => {});
    if (/Unsupported state or unable to authenticate data/i.test(error.message)) {
      throw new Error('Backup decryption failed. The encryption key is incorrect or the backup file has been modified.');
    }
    throw error;
  }
}

export async function readAndValidateManifest(archivePath, manifestPath, expectedFormat = 'skaw-postgresql-backup') {
  const { readFile } = await import('node:fs/promises');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest?.format !== expectedFormat || manifest?.formatVersion !== 1) {
    throw new Error('Backup manifest is missing or has an unsupported format/version.');
  }
  if (manifest.archive !== path.basename(archivePath)) {
    throw new Error('Backup manifest does not belong to the selected archive.');
  }
  const fileInfo = await stat(archivePath);
  if (fileInfo.size !== manifest.archiveBytes) {
    throw new Error('Backup archive size does not match its manifest. The file may be incomplete.');
  }
  const actualHash = await hashFile(archivePath);
  if (actualHash !== manifest.sha256) {
    throw new Error('Backup SHA-256 does not match its manifest. The archive may have been modified or corrupted.');
  }
  return manifest;
}

export async function listArchiveEntries(pgRestorePath, dumpPath) {
  const { spawnSync } = await import('node:child_process');
  const executable = process.platform === 'win32' ? pgRestorePath + '.exe' : pgRestorePath;
  const result = spawnSync(executable, ['--list', dumpPath], {
    encoding: 'utf8',
    stdio: 'pipe',
    shell: false,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (result.error) throw new Error('Could not run pg_restore: ' + result.error.message);
  if (result.status !== 0) {
    throw new Error('pg_restore could not read the backup archive: ' + (result.stderr || result.stdout || 'Unknown error'));
  }
  return result.stdout || '';
}

export const REQUIRED_BACKUP_TABLES = Object.freeze([
  'guilds', 'users', 'guild_users', 'birthdays', 'giveaways', 'ticket_data', 'afk_status',
  'welcome_configs', 'leveling_configs', 'user_levels', 'economy', 'verification_audit',
  'invite_tracking', 'application_roles', 'temp_data', 'cache_data', 'schema_migrations',
]);

export function getMissingBackupTables(archiveListing) {
  const listedTables = new Set();
  for (const line of String(archiveListing).split(/\r?\n/)) {
    const match = line.match(/\bTABLE\s+public\s+([a-zA-Z0-9_]+)\b/);
    if (match) listedTables.add(match[1]);
  }
  return REQUIRED_BACKUP_TABLES.filter((name) => !listedTables.has(name));
}
