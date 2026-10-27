import { spawnSync } from 'node:child_process';

console.warn('check-employee-logs-v1.3.mjs is retained for compatibility; forwarding to the current Employee Logs v2 checker.');
const result = spawnSync(process.execPath, ['scripts/check-employee-logs-v2.mjs'], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
