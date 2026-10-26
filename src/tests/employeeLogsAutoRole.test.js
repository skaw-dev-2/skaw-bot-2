import test from 'node:test';
import assert from 'node:assert/strict';
import {
    SKAW_EMPLOYEE_ROLE_CATALOG,
    classifyEmployeeRoleChange,
} from '../services/employeeLogsAutoRoleService.js';
import { buildEmployeeLogEmbed, buildEmployeeLogEditRow } from '../services/employeeLogsService.js';

const R = {
    civilian: '1415329997396119603',
    retired: '1429469335654633593',
    mechanicDivision: '1414623229288513586',
    mechanicTrainee: '1414629137389322244',
    mechanicJunior: '1414629274282885120',
    mechanicSenior: '1414629366574354512',
    chiefMechanic: '1466363836951957801',
    deputyMechanic: '1466365041468117083',
    truckerDivision: '1414623154151882882',
    truckerJunior: '1414629772218339480',
    warning1: '1429470453575061515',
    warning2: '1429470577286189176',
    blacklist: '1414628838557614222',
};

const types = decisions => decisions.map(item => item.type);

test('catalog contains the 37 supplied SKAW roles', () => {
    assert.equal(Object.keys(SKAW_EMPLOYEE_ROLE_CATALOG).length, 37);
    assert.equal(SKAW_EMPLOYEE_ROLE_CATALOG[R.mechanicTrainee].name, 'Mechanic Traine | SKAW');
});

test('Civilian to an active employee role creates one Sign-In', () => {
    const decisions = classifyEmployeeRoleChange(
        [R.civilian],
        [R.mechanicDivision, R.mechanicTrainee],
        '12345678901234567',
    );
    assert.deepEqual(types(decisions), ['sign_in']);
    assert.equal(decisions[0].data.position, R.mechanicTrainee);
});

test('Division then first Trainee role is not a false Promotion', () => {
    const decisions = classifyEmployeeRoleChange(
        [R.mechanicDivision],
        [R.mechanicDivision, R.mechanicTrainee],
        '12345678901234567',
    );
    assert.deepEqual(types(decisions), []);
});

test('Temporary rank removal back to a Division marker is not a false Demotion', () => {
    const decisions = classifyEmployeeRoleChange(
        [R.mechanicDivision, R.mechanicSenior],
        [R.mechanicDivision],
        '12345678901234567',
    );
    assert.deepEqual(types(decisions), []);
});

test('Junior to Senior in the same division creates Promotion', () => {
    const decisions = classifyEmployeeRoleChange(
        [R.mechanicDivision, R.mechanicJunior],
        [R.mechanicDivision, R.mechanicSenior],
        '12345678901234567',
    );
    assert.deepEqual(types(decisions), ['promotion']);
    assert.equal(decisions[0].data.previousRank, R.mechanicJunior);
    assert.equal(decisions[0].data.newRank, R.mechanicSenior);
});

test('Employee rank to Chief Mechanic is a Promotion', () => {
    const decisions = classifyEmployeeRoleChange(
        [R.mechanicDivision, R.mechanicJunior],
        [R.mechanicDivision, R.chiefMechanic],
        '12345678901234567',
    );
    assert.deepEqual(types(decisions), ['promotion']);
});

test('Chief Mechanic to Mechanic Senior is a Demotion', () => {
    const decisions = classifyEmployeeRoleChange(
        [R.mechanicDivision, R.chiefMechanic],
        [R.mechanicDivision, R.mechanicSenior],
        '12345678901234567',
    );
    assert.deepEqual(types(decisions), ['demote']);
});

test('Moving from Mechanic Senior to Trucker Junior is Mutation', () => {
    const decisions = classifyEmployeeRoleChange(
        [R.mechanicDivision, R.mechanicSenior],
        [R.truckerDivision, R.truckerJunior],
        '12345678901234567',
    );
    assert.deepEqual(types(decisions), ['mutation']);
    assert.equal(decisions[0].data.fromRole, R.mechanicSenior);
    assert.equal(decisions[0].data.toRole, R.truckerJunior);
});

test('Removing active employee roles creates Sign-Out', () => {
    const decisions = classifyEmployeeRoleChange(
        [R.mechanicDivision, R.mechanicSenior],
        [R.retired],
        '12345678901234567',
    );
    assert.deepEqual(types(decisions), ['sign_out']);
    assert.equal(decisions[0].data.position, R.mechanicSenior);
});

test('Retired/Civilian transition creates Sign-Out even if one stale rank role remains', () => {
    const decisions = classifyEmployeeRoleChange(
        [R.mechanicDivision, R.mechanicTrainee],
        [R.retired, R.mechanicTrainee],
        '12345678901234567',
    );
    assert.deepEqual(types(decisions), ['sign_out']);
});

test('Adding a Warning role creates a Warning record with the correct level', () => {
    const decisions = classifyEmployeeRoleChange(
        [R.mechanicDivision, R.mechanicSenior, R.warning1],
        [R.mechanicDivision, R.mechanicSenior, R.warning1, R.warning2],
        '12345678901234567',
    );
    assert.deepEqual(types(decisions), ['warning']);
    assert.equal(decisions[0].data.warn, '2/2');
});

test('Adding Blacklist role creates one Blacklist record', () => {
    const decisions = classifyEmployeeRoleChange(
        [R.mechanicDivision, R.mechanicSenior],
        [R.mechanicDivision, R.mechanicSenior, R.blacklist],
        '12345678901234567',
    );
    assert.deepEqual(types(decisions), ['blacklist']);
});

const renderSamples = [
    ['sign_in', { userId: '12345678901234567', position: R.mechanicTrainee }, 'EMPLOYEE SIGN-IN'],
    ['sign_out', { userId: '12345678901234567', position: R.mechanicSenior, automatic: true }, 'EMPLOYEE SIGN-OUT'],
    ['promotion', { userId: '12345678901234567', previousRank: R.mechanicJunior, newRank: R.mechanicSenior }, 'EMPLOYEE PROMOTION'],
    ['demote', { userId: '12345678901234567', previousRank: R.chiefMechanic, newRank: R.mechanicSenior }, 'EMPLOYEE DEMOTION'],
    ['dismissal', { userId: '12345678901234567', position: R.mechanicSenior }, 'EMPLOYEE DISMISSAL'],
    ['resignation', { userId: '12345678901234567', position: R.mechanicSenior }, 'EMPLOYEE RESIGNATION'],
    ['mutation', { userId: '12345678901234567', fromRole: R.mechanicSenior, toRole: R.truckerJunior }, 'EMPLOYEE MUTATION'],
    ['warning', { userId: '12345678901234567', position: R.mechanicSenior, warn: '1/2' }, 'EMPLOYEE WARNING'],
    ['blacklist', { userId: '12345678901234567', position: R.mechanicSenior }, 'PERSONNEL BLACKLIST'],
    ['others', { userId: '12345678901234567', position: R.mechanicSenior, activityTitle: 'Special Activity', activityDescription: 'Additional activity detail.' }, 'OTHER EMPLOYEE ACTIVITY'],
];

test('all ten activity templates render with the approved heading and divider without body emoji', () => {
    for (const [type, data, heading] of renderSamples) {
        const embed = buildEmployeeLogEmbed(type, {
            ...data,
            displayName: 'Kevin Monterrey',
            recordedBy: '12345678901234567',
            recordId: 'SKAW-EL-20261026-TEST123456',
            recordedAt: '2026-10-26T04:00:00.000Z',
        });
        const description = embed.toJSON?.().description || embed.description;
        assert.ok(description.startsWith(`## ${heading}\n`), `${type} heading`);
        assert.ok(description.includes('Kevin Monterrey (**<@12345678901234567>**)'), `${type} uses server display name plus real mention`);
        assert.ok(description.includes('━━━━━━━━━━━━━━━━━━━━━━━━━━━━'), `${type} divider`);
        assert.ok(description.includes('**SKAW Management.**'), `${type} signature`);
        assert.ok(description.includes('-# Record ID: SKAW-EL-20261026-TEST123456'), `${type} record id`);
        assert.ok(description.includes('-# Published:'), `${type} timestamp`);
        assert.doesNotMatch(description, /[😀-🙏]/u, `${type} should not contain emoji in the body`);
    }
});

test('empty Notes are omitted and non-empty Notes render a notes section', () => {
    const base = { userId: '12345678901234567', position: R.mechanicSenior, recordedBy: '12345678901234567' };
    const withoutNotesEmbed = buildEmployeeLogEmbed('sign_in', { ...base, notes: '' });
    const withNotesEmbed = buildEmployeeLogEmbed('sign_in', { ...base, notes: 'Check documents.', recordId: 'SKAW-EL-TEST' });
    const withoutNotes = withoutNotesEmbed.toJSON?.().description || withoutNotesEmbed.description;
    const withNotes = withNotesEmbed.toJSON?.().description || withNotesEmbed.description;
    assert.doesNotMatch(withoutNotes, /ADDITIONAL NOTES/);
    assert.match(withNotes, /\*\*ADDITIONAL NOTES\*\*/);
    assert.match(withNotes, /Check documents\./);
});

test('published record button label and pencil icon are correct', () => {
    const row = buildEmployeeLogEditRow('SKAW-EL-TEST');
    const component = row.toJSON?.().components?.[0] || row.components?.[0]?.data || row.components?.[0];
    assert.equal(component.label, 'Edit');
    assert.equal(component.emoji?.name || component.emoji, '✏️');
});
