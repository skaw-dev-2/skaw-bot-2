import test from 'node:test';
import assert from 'node:assert/strict';
import {
    BASE_EMPLOYEE_ROLE,
    getEmployeeRoleRegistry,
    registerEmployeeRole,
    disableEmployeeRole,
    employeeRoleToCatalogEntry,
} from '../services/employeeRoleRegistryService.js';

const GUILD_ID = '77777777777777777';
const RECORDER_ID = '98765432109876543';

function runtime() {
    const store = new Map();
    const client = {
        db: {
            async get(key, fallback = null) {
                return store.has(key) ? structuredClone(store.get(key)) : structuredClone(fallback);
            },
            async set(key, value) {
                store.set(key, structuredClone(value));
            },
        },
    };
    return { client, store };
}

test('Company Staff is a fixed base membership role, not a registrable rank', async () => {
    const { client } = runtime();
    const registry = await getEmployeeRoleRegistry(client, GUILD_ID);
    assert.equal(BASE_EMPLOYEE_ROLE.id, '1564660065783390371');
    assert.equal(registry.baseEmployeeRole.name, 'Company Staff | SKAW');
    await assert.rejects(
        registerEmployeeRole(client, GUILD_ID, {
            id: BASE_EMPLOYEE_ROLE.id,
            name: BASE_EMPLOYEE_ROLE.name,
            category: 'rank',
            department: 'management',
            level: 1,
        }, RECORDER_ID),
        /Base Employee Role|tidak perlu didaftarkan/i,
    );
});

test('custom ranks can be registered, mapped to the auto-role classifier, and deactivated safely', async () => {
    const { client } = runtime();
    const role = await registerEmployeeRole(client, GUILD_ID, {
        id: POSITION_ID,
        name: 'Modshop Junior | SKAW',
        category: 'rank',
        department: 'modshop',
        level: 1,
        note: 'Initial modshop rank',
    }, RECORDER_ID);

    assert.equal(role.id, POSITION_ID);
    assert.equal(role.category, 'rank');
    assert.equal(role.department, 'modshop');
    assert.equal(role.level, 1);
    assert.equal(role.note, 'Initial modshop rank');
    assert.deepEqual(employeeRoleToCatalogEntry(role), {
        name: 'Modshop Junior | SKAW',
        domain: 'modshop',
        level: 1,
        kind: 'rank',
        active: true,
        position: true,
    });

    const disabled = await disableEmployeeRole(client, GUILD_ID, POSITION_ID, RECORDER_ID);
    assert.equal(disabled.active, false);
    const after = await getEmployeeRoleRegistry(client, GUILD_ID);
    assert.equal(after.roles.length, 1);
    assert.equal(after.roles[0].id, POSITION_ID);
    assert.equal(after.roles[0].active, false, 'deactivation preserves references instead of deleting the mapping');
});
