import test from 'node:test'
import assert from 'node:assert/strict'

import { EMPLOYEE_ROLES } from '../src/backoffice/contracts/employee'
import { MENU_ORDER, roleAccessRows } from '../src/backoffice/rbac/permissions'

// BUG-0329：员工账号页把「菜单可见性」和「权限级别」分开显示给分配角色的人，
// 这份清单必须始终来自 ROLE_MATRIX，而不是页面自己维护的第二份表。
test('every role lists every menu exactly once, in sidebar order', () => {
  for (const role of EMPLOYEE_ROLES) {
    const rows = roleAccessRows(role)
    assert.deepEqual(
      rows.map((row) => row.menu),
      [...MENU_ORDER]
    )
  }
})

test('ADMIN is Full on every menu', () => {
  assert.deepEqual(
    roleAccessRows('ADMIN').map((row) => row.level),
    MENU_ORDER.map(() => 'FULL')
  )
})

test('read-only roles stay on View', () => {
  assert.ok(roleAccessRows('COURSE_CREATOR').every((row) => row.level === 'VIEW'))
})

test('the mixed roles keep their documented split', () => {
  const level = (role: Parameters<typeof roleAccessRows>[0], menu: string) =>
    roleAccessRows(role).find((row) => row.menu === menu)!.level

  assert.equal(level('GRAPHIC_DESIGNER', 'course'), 'EDIT')
  assert.equal(level('GRAPHIC_DESIGNER', 'settings'), 'VIEW')
  assert.equal(level('FINANCE', 'order'), 'FULL')
  assert.equal(level('FINANCE', 'course'), 'VIEW')
  assert.equal(level('OPERATION_ADMIN', 'knowledge'), 'NONE')
  assert.equal(level('OPERATION_AI', 'knowledge'), 'FULL')
  assert.equal(level('OPERATION_AI', 'course'), 'VIEW')
})
