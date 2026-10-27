import { spawnSync } from 'node:child_process';

console.warn('test-employee-logs-v1.3.mjs is retained for compatibility; running the current Employee Logs and Directory test suite.');
const result = spawnSync(process.execPath, [
    '--test',
    'src/tests/employeeRoleRegistry.test.js',
    'src/tests/employeeLogsAutoRole.test.js',
    'src/tests/employeeLogsAutoRoleDispatch.test.js',
    'src/tests/employeeLogsRecord.test.js',
    'src/tests/employeeLogsDirectoryIntegration.test.js',
    'src/tests/employeeDirectoryService.test.js',
], { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
