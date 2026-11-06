import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAbsenceDateRange,
  buildAbsenceMonthOptions,
  buildRequestModal,
  buildStaffRequestDecisionRows,
  buildStaffRequestDecisionStatement,
  buildStaffRequestEmbed,
  buildStaffRequestSetupPayload,
  canSubmitStaffRequest,
  resolveDivisionRoleFromIds,
  STAFF_REQUEST_BASE_ROLE_ID,
} from '../services/staffRequestService.js';

test('built-in SKAW division roles are resolved from employee role IDs', () => {
  const division = resolveDivisionRoleFromIds(['1414623229288513586', STAFF_REQUEST_BASE_ROLE_ID], []);
  assert.deepEqual(division, {
    id: '1414623229288513586',
    name: 'Mechanic Division | SKAW',
  });
});

test('configured Management roles can submit requests and resolve to Management division', () => {
  const managementRoleId = '1414623053471547474';
  assert.equal(canSubmitStaffRequest([managementRoleId], [managementRoleId]), true);
  assert.deepEqual(resolveDivisionRoleFromIds([managementRoleId], [], [managementRoleId]), {
    id: null,
    name: 'Management',
    management: true,
  });
});

test('every employee with Company Staff role can submit; unrelated members cannot', () => {
  assert.equal(canSubmitStaffRequest([STAFF_REQUEST_BASE_ROLE_ID, '1414623154151882882'], ['1414623053471547474']), true);
  assert.equal(canSubmitStaffRequest(['1414623154151882882'], ['1414623053471547474']), false);
  assert.equal(canSubmitStaffRequest(['1555555555555555555'], ['1414623053471547474']), false);
});

test('Staff Request setup has independent Absence and Resignation channel selectors', () => {
  const payload = buildStaffRequestSetupPayload({
    absenceChannelId: '1414500416724406315',
    resignationChannelId: '1414500416724406316',
    managementRoleIds: ['1414623053471547474'],
  });
  const customIds = payload.components.flatMap(row => row.components).map(component => component.toJSON().custom_id);
  assert.ok(customIds.includes('skaw_sr_setup_absence_channel'));
  assert.ok(customIds.includes('skaw_sr_setup_resignation_channel'));
});

test('custom registered division roles are resolved', () => {
  const division = resolveDivisionRoleFromIds(['1555555555555555555'], [{
    id: '1555555555555555555',
    name: 'Marine Division | SKAW',
    category: 'division',
    active: true,
  }]);
  assert.deepEqual(division, {
    id: '1555555555555555555',
    name: 'Marine Division | SKAW',
  });
});

test('Builder division can be inferred from its registered SKAW employee position', () => {
  assert.deepEqual(resolveDivisionRoleFromIds(['1456912660510543945'], []), {
    id: null,
    name: 'Builder Division | SKAW',
    inferred: true,
  });
});

test('missing or inactive division role is not inferred', () => {
  assert.equal(resolveDivisionRoleFromIds(['1555555555555555555'], []), null);
  assert.equal(resolveDivisionRoleFromIds(['1555555555555555555'], [{
    id: '1555555555555555555',
    name: 'Old Division',
    category: 'division',
    active: false,
  }]), null);
});

test('members with multiple active division roles are asked to contact Management', () => {
  assert.throws(() => resolveDivisionRoleFromIds(
    ['1414623229288513586', '1414623154151882882'],
    [],
  ), /lebih dari satu Division Role/i);
});

test('absence embed includes the applicant Discord username beside the display name', () => {
  const embed = buildStaffRequestEmbed({
    requestId: 'SKAW-ABS-1234567890',
    type: 'absence',
    status: 'pending',
    applicantName: 'Christopher Marquez',
    applicantUsername: 'Castillo_DePablo',
    divisionRoleId: '1414623229288513586',
    dateRange: '03 Nov 2026 - 13 Nov 2026',
    reason: 'Banyak kerjaan OC',
    managementRoleIds: ['1414623053471547474'],
  }).toJSON();

  assert.match(embed.description, /ABSENCE FORM/);
  assert.match(embed.description, /Christopher Marquez \(@Castillo_DePablo\)/);
  assert.match(embed.description, /<@&1414623229288513586>/);
  assert.match(embed.description, /3 Nov - 13 Nov 2026/);
  assert.match(embed.description, /Banyak kerjaan OC/);
  assert.match(embed.description, /Permission to/);
  assert.match(embed.description, /Signed,/);
  assert.match(embed.fields.find(field => field.name === 'Approval Status').value, /Pending Approval/);
});

test('resignation embed includes optional note only when provided', () => {
  const withNote = buildStaffRequestEmbed({
    requestId: 'SKAW-RES-1234567890',
    type: 'resignation',
    status: 'approved',
    applicantName: 'Joaquin Quessham',
    applicantUsername: 'joaquin_quessham',
    divisionRoleId: '1414623229288513586',
    reason: 'Sudah fokus RL',
    note: 'Terima kasih sudah menerima saya.',
    managementRoleIds: ['1414623053471547474'],
  }).toJSON();

  assert.match(withNote.description, /RESIGNATION FORM/);
  assert.match(withNote.description, /Joaquin Quessham \(@joaquin_quessham\)/);
  assert.match(withNote.description, /Sudah fokus RL/);
  assert.match(withNote.description, /Terima kasih sudah menerima saya/);
  assert.match(withNote.fields.find(field => field.name === 'Approval Status').value, /Approved/);

  const withoutNote = buildStaffRequestEmbed({
    requestId: 'SKAW-RES-1234567891',
    type: 'resignation',
    status: 'pending',
    applicantName: 'Joaquin Quessham',
    divisionRoleId: '1414623229288513586',
    reason: 'Sudah fokus RL',
    note: '',
    managementRoleIds: ['1414623053471547474'],
  }).toJSON();
  assert.doesNotMatch(withoutNote.description, /> \*\*Note :\*\*/);
});

test('employee-supplied markdown is escaped in the review embed', () => {
  const embed = buildStaffRequestEmbed({
    requestId: 'SKAW-ABS-ESCAPE',
    type: 'absence',
    status: 'pending',
    applicantName: 'Name *with* formatting',
    divisionRoleId: '1414623229288513586',
    dateRange: '3 Nov - 13 Nov 2026',
    reason: 'Reason with **formatting**',
    managementRoleIds: ['1414623053471547474'],
  }).toJSON();
  const slash = String.fromCharCode(92);
  assert.ok(embed.description.includes('Name ' + slash + '*with' + slash + '* formatting'));
  assert.ok(embed.description.includes('Reason with ' + slash + '*' + slash + '*formatting' + slash + '*' + slash + '*'));
});

test('pending request controls provide Approve and Reject; completed controls are disabled', () => {
  const pendingRows = buildStaffRequestDecisionRows({
    requestId: 'SKAW-ABS-1234567890',
    type: 'absence',
    status: 'pending',
  }).map(row => row.toJSON());
  assert.deepEqual(pendingRows[0].components.map(component => component.label), ['Approve', 'Reject']);
  assert.deepEqual(pendingRows[0].components.map(component => component.disabled), [undefined, undefined]);
  assert.equal(pendingRows[1].components[0].label, 'Submit Absence');
  assert.equal(pendingRows[1].components[0].custom_id, 'skaw_sr_submit|SKAW-ABS-1234567890');

  const approvedRows = buildStaffRequestDecisionRows({
    requestId: 'SKAW-ABS-1234567890',
    type: 'absence',
    status: 'approved',
  }).map(row => row.toJSON());
  assert.equal(approvedRows[0].components.length, 1);
  assert.equal(approvedRows[0].components[0].label, 'Approved');
  assert.equal(approvedRows[0].components[0].disabled, true);
  assert.equal(approvedRows[1].components[0].label, 'Submit Absence');
});

test('resignation request controls contain a matching submit button', () => {
  const rows = buildStaffRequestDecisionRows({
    requestId: 'SKAW-RES-1234567890',
    type: 'resignation',
    status: 'pending',
  }).map(row => row.toJSON());
  assert.equal(rows[1].components[0].label, 'Submit Resignation');
  assert.equal(rows[1].components[0].custom_id, 'skaw_sr_submit|SKAW-RES-1234567890');
});

test('approval decisions are atomic and update only pending requests', () => {
  const statement = buildStaffRequestDecisionStatement(
    'SKAW-ABS-1234567890',
    '1414500416724406315',
    'rejected',
    '1414500416724406316',
    'Tanggal tidak sesuai.',
  );
  assert.match(statement.text, /status=\$3::varchar\(24\)/);
  assert.match(statement.text, /status='pending'/);
  assert.match(statement.text, /RETURNING \*/);
  assert.deepEqual(statement.values, [
    'SKAW-ABS-1234567890',
    '1414500416724406315',
    'rejected',
    '1414500416724406316',
    'Tanggal tidak sesuai.',
  ]);
  assert.throws(() => buildStaffRequestDecisionStatement('x', 'y', 'pending', 'z'), /Decision status/i);
});

test('absence form uses date dropdowns for start and end, and validates the selected range', () => {
  const absence = buildRequestModal('1414500416724406316', 'absence').toJSON();
  assert.equal(absence.components.length, 5);
  const fields = absence.components.map(component => component.component);
  assert.deepEqual(fields.map(component => component.custom_id), [
    'start_month', 'start_day', 'end_month', 'end_day', 'reason',
  ]);
  assert.deepEqual(fields.slice(0, 4).map(component => component.type), [3, 3, 3, 3]);
  assert.equal(fields[0].options.length, 25);
  assert.equal(fields[1].options.length, 31);
  assert.equal(fields[4].type, 4);

  assert.equal(
    buildAbsenceDateRange('2026-11', '06', '2026-11', '13'),
    '06 Nov 2026 - 13 Nov 2026',
  );
  assert.throws(() => buildAbsenceDateRange('2026-02', '30', '2026-03', '02'), /tidak valid/i);
  assert.throws(() => buildAbsenceDateRange('2026-11', '14', '2026-11', '13'), /tidak boleh setelah/i);
});

test('absence month options roll forward in Asia/Jakarta and include 25 months', () => {
  const options = buildAbsenceMonthOptions(new Date('2026-11-06T00:00:00.000Z'));
  assert.equal(options.length, 25);
  assert.equal(options[0].value, '2026-11');
  assert.equal(options[24].value, '2028-11');
});

test('resignation modal keeps its reason and optional note inputs', () => {
  const resignation = buildRequestModal('1414500416724406316', 'resignation').toJSON();
  assert.equal(resignation.components.length, 2);
  assert.equal(resignation.components[0].components[0].custom_id, 'reason');
  assert.equal(resignation.components[1].components[0].custom_id, 'note');
});

test('invalid request type and unsafe broadcast mentions are rejected', () => {
  assert.throws(() => buildStaffRequestEmbed({
    type: 'unknown', applicantName: 'A', reason: 'B',
  }), /Jenis pengajuan/i);
  assert.throws(() => buildStaffRequestEmbed({
    requestId: 'SKAW-ABS-X',
    type: 'absence',
    status: 'pending',
    applicantName: '@everyone',
    divisionRoleId: '1414623229288513586',
    dateRange: '3 Nov - 13 Nov 2026',
    reason: 'Busy',
  }), /@everyone/i);
});
