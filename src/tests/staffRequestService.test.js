import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildAbsenceDateRange,
  buildAbsenceDateOptions,
  buildAbsenceDatePickerPayload,
  formatAbsenceDuration,
  getAbsenceReminderTargetDate,
  isAbsencePeriodExpired,
  buildStaffRequestLogEmbed,
  buildStaffRequestApplicantDm,
  buildResignationRoleTransition,
  STAFF_REQUEST_CIVILIAN_ROLE_ID,
  STAFF_REQUEST_RETIRED_ROLE_ID,
  buildStaffRequestRoleMetadata,
  isStaffRequestRoleWithinHierarchy,
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

test('Staff Request role metadata includes active built-in and registered position roles only', () => {
  const metadata = buildStaffRequestRoleMetadata({
    registryRoles: [
      { id: '22222222222222222', name: 'Marine Senior | SKAW', category: 'rank', department: 'marine', level: 3, active: true },
      { id: '33333333333333333', name: 'Marine Division | SKAW', category: 'division', department: 'marine', active: true },
      { id: '44444444444444444', name: 'Old Warning | SKAW', category: 'warning', department: 'marine', active: true },
      { id: '55555555555555555', name: 'Inactive Rank | SKAW', category: 'rank', department: 'marine', level: 2, active: false },
    ],
  });
  assert.ok(metadata.has('1414629366574354512'));
  assert.ok(metadata.has('22222222222222222'));
  assert.ok(metadata.has('33333333333333333'));
  assert.equal(metadata.has('44444444444444444'), false);
  assert.equal(metadata.has('55555555555555555'), false);
  assert.equal(metadata.has(STAFF_REQUEST_BASE_ROLE_ID), false);
});

test('Staff Request role selection respects SKAW level and Discord role hierarchy', () => {
  const metadata = buildStaffRequestRoleMetadata();
  const highest = {
    id: '1414629366574354512',
    position: 30,
    comparePositionTo(other) { return this.position - other.position; },
  };
  const member = {
    id: 'user-1',
    roles: {
      cache: new Map([
        [STAFF_REQUEST_BASE_ROLE_ID, { id: STAFF_REQUEST_BASE_ROLE_ID }],
        [highest.id, highest],
      ]),
      highest,
    },
  };
  const lowerRole = {
    id: '1414629274282885120',
    position: 20,
    comparePositionTo(other) { return this.position - other.position; },
  };
  const higherLevelRole = {
    id: '1466363836951957801',
    position: 29,
    comparePositionTo(other) { return this.position - other.position; },
  };
  const discordHigherRole = {
    id: '1414629137389322244',
    position: 31,
    comparePositionTo(other) { return this.position - other.position; },
  };
  assert.equal(isStaffRequestRoleWithinHierarchy(lowerRole, member, metadata, 'guild-owner', 'everyone'), true);
  assert.equal(isStaffRequestRoleWithinHierarchy(higherLevelRole, member, metadata, 'guild-owner', 'everyone'), false);
  assert.equal(isStaffRequestRoleWithinHierarchy(discordHigherRole, member, metadata, 'guild-owner', 'everyone'), false);
  assert.equal(isStaffRequestRoleWithinHierarchy(discordHigherRole, { id: 'guild-owner', roles: member.roles }, metadata, 'guild-owner', 'everyone'), true);
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
    logChannelId: '1414500416724406317',
    managementRoleIds: ['1414623053471547474'],
  });
  const customIds = payload.components.flatMap(row => row.components).map(component => component.toJSON().custom_id);
  assert.ok(customIds.includes('skaw_sr_setup_absence_channel'));
  assert.ok(customIds.includes('skaw_sr_setup_resignation_channel'));
  assert.ok(customIds.includes('skaw_sr_setup_logs_channel'));
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

test('absence embed renders the applicant as a clickable Discord mention beside the display name', () => {
  const embed = buildStaffRequestEmbed({
    requestId: 'SKAW-ABS-1234567890',
    type: 'absence',
    status: 'pending',
    applicantId: '1414500416724406316',
    applicantName: 'Christopher Marquez',
    applicantUsername: 'Castillo_DePablo',
    divisionRoleId: '1414623229288513586',
    dateRange: '03 Nov 2026 - 13 Nov 2026',
    dateStart: '2026-11-03',
    dateEnd: '2026-11-13',
    reason: 'Banyak kerjaan OC',
    managementRoleIds: ['1414623053471547474'],
  }).toJSON();

  assert.match(embed.description, /ABSENCE FORM/);
  assert.ok(embed.description.includes('Christopher Marquez (<@1414500416724406316>)'));
  assert.doesNotMatch(embed.description, /\(@Castillo/);
  assert.match(embed.description, /<@&1414623229288513586>/);
  assert.match(embed.description, /03 Nov 2026 - 13 Nov 2026/);
  assert.match(embed.description, /Duration/);
  assert.match(embed.description, /1 week/);
  assert.match(embed.description, /240 hours/);
  assert.match(embed.description, /Banyak kerjaan OC/);
  assert.equal(embed.fields.some(field => field.name === 'Request ID'), false);
  assert.equal(embed.fields.some(field => field.name === 'Decision Date'), false);
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
  assert.ok(withNote.description.includes('Joaquin Quessham (@joaquin' + String.fromCharCode(92) + '_quessham)'));
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

test('absence form asks the applicant to enter Name and select a Role manually', () => {
  const absence = buildRequestModal('1414500416724406316', 'absence', {
    dateStart: '2026-11-06',
    dateEnd: '2026-11-13',
  }).toJSON();
  const serialized = JSON.stringify(absence);
  assert.equal(absence.components.length, 3);
  assert.equal(absence.custom_id, 'skaw_sr_form|absence|1414500416724406316|2026-11-06|2026-11-13');
  assert.match(serialized, /applicant_name/);
  assert.match(serialized, /\"custom_id\":\"role\"/);
  assert.match(serialized, /\"type\":6/);
  assert.match(serialized, /reason/);
  assert.equal(absence.title, 'Absence Request');

  assert.equal(buildAbsenceDateRange('2026-11-06', '2026-11-13'), '06 Nov 2026 - 13 Nov 2026');
  assert.throws(() => buildAbsenceDateRange('2026-02-30', '2026-03-02'), /tidak valid/i);
  assert.throws(() => buildAbsenceDateRange('2026-11-14', '2026-11-13'), /tidak boleh setelah/i);
});

test('absence date options roll forward from the current Jakarta date for 25 days', () => {
  const options = buildAbsenceDateOptions(new Date('2026-11-06T00:00:00.000Z'));
  assert.equal(options.length, 25);
  assert.equal(options[0].value, '2026-11-06');
  assert.equal(options[24].value, '2026-11-30');
  const nextPage = buildAbsenceDateOptions(new Date('2026-11-06T00:00:00.000Z'), 25);
  assert.equal(nextPage[0].value, '2026-12-01');
  assert.equal(nextPage[24].value, '2026-12-25');
  const picker = buildAbsenceDatePickerPayload('1414500416724406316', { now: new Date('2026-11-06T00:00:00.000Z') });
  const pickerRows = picker.components.map(row => row.toJSON());
  assert.equal(pickerRows[0].components[0].options.length, 25);
  assert.match(pickerRows[1].components[1].custom_id, /\|25$/);
  const finalPage = buildAbsenceDatePickerPayload('1414500416724406316', {
    now: new Date('2026-11-06T00:00:00.000Z'), offsetDays: 725,
  }).components.map(row => row.toJSON());
  assert.equal(finalPage[0].components[0].options.length, 6);
});

test('one-day Absence reminder date follows the Asia/Jakarta calendar boundary', () => {
  assert.equal(getAbsenceReminderTargetDate(new Date('2026-11-06T16:59:59.000Z')), '2026-11-07');
  assert.equal(getAbsenceReminderTargetDate(new Date('2026-11-06T17:00:00.000Z')), '2026-11-08');
});

test('Absence expires only after its inclusive end date has passed in Jakarta', () => {
  assert.equal(isAbsencePeriodExpired('2026-11-06', new Date('2026-11-06T16:59:59.000Z')), false);
  assert.equal(isAbsencePeriodExpired('2026-11-06', new Date('2026-11-06T17:00:00.000Z')), true);
  assert.equal(isAbsencePeriodExpired('2026-11-07', new Date('2026-11-06T17:00:00.000Z')), false);
});

test('absence duration is displayed in calendar months, weeks, days, and hours', () => {
  assert.equal(formatAbsenceDuration('2026-11-06', '2026-11-13'), '1 week (7 days / 168 hours)');
  assert.equal(formatAbsenceDuration('2026-11-06', '2026-12-06'), '1 month (30 days / 720 hours)');
  assert.equal(formatAbsenceDuration('2026-11-06', '2026-11-06'), '1 day (24 hours)');
});

test('Management Absence reminder log clearly identifies an ending absence', () => {
  const embed = buildStaffRequestLogEmbed({
    requestId: 'SKAW-ABS-ENDING01',
    type: 'absence',
    applicantId: '1414500416724406316',
    applicantName: 'Christopher Marquez',
    divisionRoleId: '1414623229288513586',
    dateRange: '06 Nov 2026 - 13 Nov 2026',
    dateStart: '2026-11-06',
    dateEnd: '2026-11-13',
    reason: 'Banyak kerjaan OC',
    status: 'approved',
  }, 'absence_ending_tomorrow').toJSON();
  assert.match(embed.title, /ABSENCE ENDING TOMORROW/);
  assert.match(embed.description, /Management Reminder/);
  assert.match(embed.description, /akan berakhir besok/);
  assert.match(embed.description, /<@1414500416724406316>/);
  assert.match(embed.description, /13 Nov 2026/);
  assert.match(embed.description, /SKAW-ABS-ENDING01/);
});

test('staff request log embeds capture request lifecycle details', () => {
  const embed = buildStaffRequestLogEmbed({
    requestId: 'SKAW-ABS-1234567890',
    type: 'absence',
    applicantId: '1414500416724406316',
    applicantName: 'Christopher Marquez',
    applicantUsername: 'Castillo_DePablo',
    divisionRoleId: '1414623229288513586',
    dateRange: '06 Nov 2026 - 13 Nov 2026',
    dateStart: '2026-11-06',
    dateEnd: '2026-11-13',
    reason: 'Banyak kerjaan OC',
    status: 'pending',
  }, 'submitted').toJSON();
  assert.match(embed.title, /ABSENCE.*NEW REQUEST SUBMITTED/);
  assert.match(embed.description, /SKAW-ABS-1234567890/);
  assert.match(embed.description, /\*\*Name:\*\* Christopher Marquez \(<@1414500416724406316>\)/);
  assert.match(embed.description, /\*\*Employee:\*\* <@1414500416724406316>/);
  assert.doesNotMatch(embed.description, /\(@Castillo/);
  assert.match(embed.description, /1 week/);
});

test('approved Resignation retains only Civilian and Retired SKAW roles', () => {
  const plan = buildResignationRoleTransition([
    '1414500416724406316',
    STAFF_REQUEST_CIVILIAN_ROLE_ID,
    '1414629366574354512',
    '1414623229288513586',
    STAFF_REQUEST_RETIRED_ROLE_ID,
  ], '1414500416724406316');

  assert.deepEqual(plan.finalRoleIds, [
    STAFF_REQUEST_CIVILIAN_ROLE_ID,
    STAFF_REQUEST_RETIRED_ROLE_ID,
  ]);
  assert.deepEqual(plan.rolesToAdd, []);
  assert.deepEqual(plan.rolesToRemove, [
    '1414629366574354512',
    '1414623229288513586',
  ]);

  const memberWithoutRetired = buildResignationRoleTransition([
    '1414500416724406316',
    '1414629366574354512',
  ], '1414500416724406316');
  assert.deepEqual(memberWithoutRetired.rolesToAdd, [
    STAFF_REQUEST_CIVILIAN_ROLE_ID,
    STAFF_REQUEST_RETIRED_ROLE_ID,
  ]);
});

test('Resignation approval DM thanks the employee and confirms the civilian transition', () => {
  const message = buildStaffRequestApplicantDm({
    type: 'resignation',
    status: 'approved',
    applicantName: 'Christopher Marquez',
    requestId: 'SKAW-RES-1234567890',
    resignationRolesUpdated: true,
  });

  assert.match(message, /disetujui oleh Management/);
  assert.match(message, /warga biasa \(Civilian\)/);
  assert.match(message, /@Civilian \| SKAW/);
  assert.match(message, /@Retired Employe \| SKAW/);
  assert.match(message, /Terima kasih atas waktu, kerja keras, kontribusi, dan dedikasi/);
  assert.match(message, /SKAW-RES-1234567890/);
});

test('Resignation approval DM does not claim role transition before it completes', () => {
  const message = buildStaffRequestApplicantDm({
    type: 'resignation',
    status: 'approved',
    applicantName: 'Christopher Marquez',
    requestId: 'SKAW-RES-1234567890',
    resignationRolesUpdated: false,
    resignationRoleResetLastError: 'Bot role hierarchy is too low.',
  });

  assert.match(message, /penyesuaian role akun kamu belum berhasil/);
  assert.match(message, /Management akan menindaklanjuti/);
  assert.doesNotMatch(message, /warga biasa \(Civilian\)/);
});

test('Resignation approval log records role transition and retained roles', () => {
  const embed = buildStaffRequestLogEmbed({
    requestId: 'SKAW-RES-LOG123456',
    type: 'resignation',
    applicantId: '1414500416724406316',
    applicantName: 'Christopher Marquez',
    divisionRoleId: '1414623229288513586',
    reason: 'Mengundurkan diri',
    status: 'approved',
    resignationRolesUpdated: true,
  }, 'approved').toJSON();

  assert.match(embed.title, /RESIGNATION.*REQUEST APPROVED/);
  assert.match(embed.description, /Membership Transition.*Completed/);
  assert.match(embed.description, /@Civilian \| SKAW and @Retired Employe \| SKAW/);
  assert.match(embed.description, /All other assignable roles/);
});

test('resignation form asks for Name, Role, Reason and optional Note', () => {
  const resignation = buildRequestModal('1414500416724406316', 'resignation').toJSON();
  const serialized = JSON.stringify(resignation);
  assert.equal(resignation.components.length, 4);
  assert.match(serialized, /applicant_name/);
  assert.match(serialized, /\"custom_id\":\"role\"/);
  assert.match(serialized, /reason/);
  assert.match(serialized, /note/);
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
