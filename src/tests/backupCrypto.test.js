import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildPostgresClientEnv } from '../../scripts/postgresEnv.js';
import {
  assertBackupKey,
  decryptArchiveFile,
  encryptArchiveFile,
  hashFile,
  getMissingBackupTables,
  REQUIRED_BACKUP_TABLES,
  readAndValidateManifest,
} from '../../scripts/backupCrypto.js';

const TEST_KEY = 'skaw-test-key-0123456789abcdef-keep-out-of-production';

async function withTempDir(callback) {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'skaw-backup-crypto-test-'));
  try {
    await callback(directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('backup encryption round-trips an archive without changing its bytes', async () => {
  await withTempDir(async (directory) => {
    const source = path.join(directory, 'source.dump');
    const encrypted = path.join(directory, 'source.dump.enc');
    const restored = path.join(directory, 'restored.dump');
    const contents = Buffer.from('SKAW PostgreSQL backup test data\n\u0000\u0001\u0002', 'utf8');
    await writeFile(source, contents);

    const metadata = await encryptArchiveFile(source, encrypted, TEST_KEY);
    await decryptArchiveFile(encrypted, restored, TEST_KEY);

    assert.deepEqual(await readFile(restored), contents);
    assert.equal(metadata.sha256, await hashFile(encrypted));
    assert.equal(metadata.sizeBytes, (await stat(encrypted)).size);
  });
});

test('backup decryption rejects an incorrect key and does not leave plaintext behind', async () => {
  await withTempDir(async (directory) => {
    const source = path.join(directory, 'source.dump');
    const encrypted = path.join(directory, 'source.dump.enc');
    const restored = path.join(directory, 'restored.dump');
    await writeFile(source, 'private database data');
    await encryptArchiveFile(source, encrypted, TEST_KEY);

    await assert.rejects(
      decryptArchiveFile(encrypted, restored, 'wrong-key-0123456789abcdef-0123456789'),
      /decryption failed|authenticate|Unsupported state/i,
    );
    await assert.rejects(stat(restored), { code: 'ENOENT' });
  });
});

test('backup decryption rejects an archive modified after encryption', async () => {
  await withTempDir(async (directory) => {
    const source = path.join(directory, 'source.dump');
    const encrypted = path.join(directory, 'source.dump.enc');
    const restored = path.join(directory, 'restored.dump');
    await writeFile(source, Buffer.alloc(512, 0x41));
    await encryptArchiveFile(source, encrypted, TEST_KEY);

    const file = await readFile(encrypted);
    file[file.length - 20] ^= 0x01;
    await writeFile(encrypted, file);

    await assert.rejects(decryptArchiveFile(encrypted, restored, TEST_KEY));
    await assert.rejects(stat(restored), { code: 'ENOENT' });
  });
});

test('backup keys must have at least 32 UTF-8 bytes', () => {
  assert.equal(assertBackupKey(TEST_KEY), TEST_KEY);
  assert.throws(() => assertBackupKey('too-short'), /at least 32/);
  assert.throws(() => assertBackupKey(undefined), /at least 32/);
});

test('manifest validation rejects mismatched file hashes', async () => {
  await withTempDir(async (directory) => {
    const archive = path.join(directory, 'source.dump.enc');
    const manifestPath = archive + '.manifest.json';
    await writeFile(archive, 'encrypted placeholder');
    await writeFile(manifestPath, JSON.stringify({
      format: 'skaw-postgresql-backup',
      formatVersion: 1,
      archive: path.basename(archive),
      archiveBytes: (await stat(archive)).size,
      sha256: '0'.repeat(64),
    }));

    await assert.rejects(readAndValidateManifest(archive, manifestPath), /SHA-256/);
  });
});

test('archive table inventory detects missing required SKAW tables', () => {
  const completeListing = REQUIRED_BACKUP_TABLES.map((name) => 'TABLE public ' + name).join('\n');
  assert.deepEqual(getMissingBackupTables(completeListing), []);
  assert.deepEqual(
    getMissingBackupTables('TABLE public guilds\nTABLE public temp_data'),
    REQUIRED_BACKUP_TABLES.filter((name) => !['guilds', 'temp_data'].includes(name)),
  );
});

test('PostgreSQL client environment keeps credentials out of command arguments', () => {
  const env = buildPostgresClientEnv(
    'postgresql://backup-user:p%40ss%3Aword@db.example.test:6543/skaw_prod?sslmode=require',
    { POSTGRES_URL: 'source-url-secret', DATABASE_URL: 'another-secret', POSTGRES_PASSWORD: 'source-password', NODE_ENV: 'production' },
  );
  assert.equal(env.PGHOST, 'db.example.test');
  assert.equal(env.PGPORT, '6543');
  assert.equal(env.PGDATABASE, 'skaw_prod');
  assert.equal(env.PGUSER, 'backup-user');
  assert.equal(env.PGPASSWORD, 'p@ss:word');
  assert.equal(env.PGSSLMODE, 'require');
  assert.equal(env.POSTGRES_URL, undefined);
  assert.equal(env.DATABASE_URL, undefined);
  assert.equal(env.POSTGRES_PASSWORD, undefined);
});
