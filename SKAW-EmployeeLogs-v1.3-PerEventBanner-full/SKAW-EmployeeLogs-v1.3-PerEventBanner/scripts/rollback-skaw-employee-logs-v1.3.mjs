import fs from 'node:fs/promises';
import path from 'node:path';

const projectRoot = path.resolve(process.cwd());
const backupRoot = process.argv[2] ? path.resolve(process.argv[2]) : null;

async function main() {
    if (!backupRoot) throw new Error('Usage: node rollback-skaw-employee-logs-v1.3.mjs <backup-path> (run from the TitanBot repo root).');
    const manifestPath = path.join(backupRoot, 'manifest.json');
    const manifest = JSON.parse(await fs.readFile(manifestPath, 'utf8'));
    if (path.resolve(manifest.projectRoot) !== projectRoot) {
        throw new Error(`Backup ini dibuat untuk ${manifest.projectRoot}, bukan ${projectRoot}. Jalankan dari root repo yang benar.`);
    }

    for (const entry of [...manifest.entries].reverse()) {
        const target = path.resolve(projectRoot, entry.relative);
        if (target !== projectRoot && !target.startsWith(`${projectRoot}${path.sep}`)) throw new Error(`Unsafe target in backup manifest: ${entry.relative}`);
        if (entry.existed && entry.backupFile) {
            await fs.mkdir(path.dirname(target), { recursive: true });
            await fs.copyFile(entry.backupFile, target);
            console.log(`Restored ${entry.relative}`);
        } else {
            await fs.rm(target, { force: true });
            console.log(`Removed ${entry.relative}`);
        }
    }
    console.log('Rollback completed. Verify with git status --short.');
}

main().catch(error => {
    console.error(`Employee Logs rollback failed: ${error.message}`);
    process.exitCode = 1;
});
