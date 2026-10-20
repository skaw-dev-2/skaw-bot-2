import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const projectRoot = path.resolve(process.cwd());
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const backupRoot = path.join(os.tmpdir(), `skaw-employee-logs-v1.3-backup-${stamp}`);

async function exists(filePath) {
    try { await fs.access(filePath); return true; } catch { return false; }
}

async function readUtf8(filePath) {
    return fs.readFile(filePath, 'utf8');
}

function safeTarget(root, relativePath) {
    const target = path.resolve(root, relativePath);
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
        throw new Error(`Unsafe target path: ${relativePath}`);
    }
    return target;
}

async function main() {
    const required = [
        'package.json',
        'src/app.js',
        'src/handlers/loaders/commandLoader.js',
    ];
    for (const relative of required) {
        if (!await exists(path.join(projectRoot, relative))) {
            throw new Error(`Jalankan installer dari root repo TitanBot. File tidak ditemukan: ${relative}. Current directory: ${projectRoot}`);
        }
    }

    const appTarget = path.join(projectRoot, 'src/app.js');
    let appText = await readUtf8(appTarget);
    const startupMarker = 'await this.loadHandlers();';
    if (!appText.includes(startupMarker)) {
        throw new Error('Hook startup tidak ditemukan pada src/app.js. Tidak ada file yang diubah. Periksa source app.js sebelum mencoba installer ini.');
    }

    const files = [
        ['src/commands/Utility/employee-logs.js', 'src/commands/Utility/employee-logs.js'],
        ['src/services/employeeLogsService.js', 'src/services/employeeLogsService.js'],
        ['src/services/employeeLogsInteractionService.js', 'src/services/employeeLogsInteractionService.js'],
        ['scripts/check-employee-logs-v1.3.mjs', 'scripts/check-employee-logs-v1.3.mjs'],
        ['scripts/test-employee-logs-v1.3.mjs', 'scripts/test-employee-logs-v1.3.mjs'],
    ];
    const manifest = [];

    await fs.mkdir(backupRoot, { recursive: true });
    try {
        for (const [sourceRelative, targetRelative] of files) {
            const sourcePath = safeTarget(packageRoot, sourceRelative);
            if (!await exists(sourcePath)) throw new Error(`Source paket tidak lengkap: ${sourceRelative}`);
        }

        const importLine = "import { startEmployeeLogsInteractionHandler } from './services/employeeLogsInteractionService.js';";
        if (!appText.includes(importLine)) {
            const classMarker = 'class TitanBot extends Client {';
            const classIndex = appText.indexOf(classMarker);
            if (classIndex < 0) throw new Error('Deklarasi class TitanBot tidak ditemukan. Tidak ada perubahan yang diterapkan.');
            appText = `${appText.slice(0, classIndex)}${importLine}\n${appText.slice(classIndex)}`;
        }

        if (!appText.includes('startEmployeeLogsInteractionHandler(this);')) {
            appText = appText.replace(startupMarker, `${startupMarker}\n      startEmployeeLogsInteractionHandler(this);`);
        }

        const allTargets = [...files.map(([, target]) => target), 'src/app.js'];
        for (const relative of allTargets) {
            const target = safeTarget(projectRoot, relative);
            const existed = await exists(target);
            let backupFile = null;
            if (existed) {
                backupFile = path.join(backupRoot, relative);
                await fs.mkdir(path.dirname(backupFile), { recursive: true });
                await fs.copyFile(target, backupFile);
            }
            manifest.push({ relative, existed, backupFile });
        }

        for (const [sourceRelative, targetRelative] of files) {
            const sourcePath = safeTarget(packageRoot, sourceRelative);
            const targetPath = safeTarget(projectRoot, targetRelative);
            await fs.mkdir(path.dirname(targetPath), { recursive: true });
            await fs.copyFile(sourcePath, targetPath);
            console.log(`Installed ${targetRelative}`);
        }
        await fs.writeFile(appTarget, appText, 'utf8');
        console.log('Patched src/app.js: registered Employee Logs interaction handler');
        await fs.writeFile(path.join(backupRoot, 'manifest.json'), JSON.stringify({ projectRoot, entries: manifest }, null, 2));
        console.log(`\nInstallation complete.\nBackup: ${backupRoot}\nNext: node scripts/check-employee-logs-v1.3.mjs\nThen review git diff before commit/push.`);
    } catch (error) {
        for (const entry of manifest.reverse()) {
            const target = safeTarget(projectRoot, entry.relative);
            try {
                if (entry.existed && entry.backupFile) {
                    await fs.mkdir(path.dirname(target), { recursive: true });
                    await fs.copyFile(entry.backupFile, target);
                } else {
                    await fs.rm(target, { force: true });
                }
            } catch { /* retain the original installer error */ }
        }
        throw error;
    }
}

main().catch(error => {
    console.error(`Employee Logs v1.3 installer failed: ${error.message}`);
    process.exitCode = 1;
});
