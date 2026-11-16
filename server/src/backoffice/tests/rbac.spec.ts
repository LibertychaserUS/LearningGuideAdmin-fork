import assert from 'node:assert/strict';

import {
  canAccessEmployeeAccount,
  canViewMenu,
  isActionAllowed,
  MENU_ORDER,
  settingsSubHref,
  SETTINGS_SUB_ORDER,
  visibleMenus,
  visibleSettingsSubs,
} from '../modules/rbac/permissions';

describe('navigation visibility', () => {
  it('gives Admin every menu', () => {
    assert.equal(visibleMenus('ADMIN').length, MENU_ORDER.length);
  });

  it('hides Knowledge and AI Tutor from Operation Admin', () => {
    assert.equal(canViewMenu('OPERATION_ADMIN', 'knowledge'), false);
    assert.equal(canViewMenu('OPERATION_ADMIN', 'aiTutor'), false);
    assert.equal(canViewMenu('OPERATION_ADMIN', 'order'), true);
  });

  it('keeps the PRD sidebar order', () => {
    assert.deepEqual(visibleMenus('ADMIN'), [...MENU_ORDER]);
  });
});

describe('action level', () => {
  it('lets a Graphic Designer edit existing courses but not create or delete', () => {
    assert.equal(isActionAllowed('GRAPHIC_DESIGNER', 'course', 'VIEW'), true);
    assert.equal(
      isActionAllowed('GRAPHIC_DESIGNER', 'course', 'EDIT_EXISTING'),
      true,
    );
    assert.equal(
      isActionAllowed('GRAPHIC_DESIGNER', 'course', 'CREATE'),
      false,
    );
    assert.equal(
      isActionAllowed('GRAPHIC_DESIGNER', 'course', 'DELETE'),
      false,
    );
    assert.equal(
      isActionAllowed('GRAPHIC_DESIGNER', 'course', 'PUBLISH'),
      false,
    );
    // REQ-0236：Course 之外的菜单全部 View，Knowledge 不能改
    assert.equal(
      isActionAllowed('GRAPHIC_DESIGNER', 'knowledge', 'EDIT_EXISTING'),
      false,
    );
    assert.equal(
      isActionAllowed('GRAPHIC_DESIGNER', 'knowledge', 'VIEW'),
      true,
    );
    assert.equal(
      isActionAllowed('GRAPHIC_DESIGNER', 'knowledge', 'CREATE'),
      false,
    );
    assert.equal(
      isActionAllowed('GRAPHIC_DESIGNER', 'knowledge', 'DELETE'),
      false,
    );
    assert.equal(
      isActionAllowed('GRAPHIC_DESIGNER', 'knowledge', 'PUBLISH'),
      false,
    );
  });

  it('gives Course Creator view-only on Course', () => {
    assert.equal(isActionAllowed('COURSE_CREATOR', 'course', 'VIEW'), true);
    assert.equal(
      isActionAllowed('COURSE_CREATOR', 'course', 'EDIT_EXISTING'),
      false,
    );
  });

  it('gives Finance full control on Order and Reporting only', () => {
    assert.equal(isActionAllowed('FINANCE', 'order', 'CREATE'), true);
    assert.equal(isActionAllowed('FINANCE', 'reporting', 'PUBLISH'), true);
    assert.equal(isActionAllowed('FINANCE', 'course', 'EDIT_EXISTING'), false);
  });

  it('denies any action on a menu the role cannot see', () => {
    assert.equal(
      isActionAllowed('OPERATION_ADMIN', 'knowledge', 'VIEW'),
      false,
    );
    assert.equal(
      isActionAllowed('OPERATION_ADMIN', 'knowledge', 'CREATE'),
      false,
    );
  });
});

describe('employee account management', () => {
  it('is restricted to Admin', () => {
    assert.equal(canAccessEmployeeAccount('ADMIN'), true);
    assert.equal(canAccessEmployeeAccount('OPERATION_ADMIN'), false);
    assert.equal(canAccessEmployeeAccount('COURSE_CREATOR'), false);
    assert.equal(canAccessEmployeeAccount('OPERATION_AI'), false);
  });
});

describe('settings sub-navigation', () => {
  it('shows three sub-items to Admin in the approved order', () => {
    assert.deepEqual(visibleSettingsSubs('ADMIN'), [...SETTINGS_SUB_ORDER]);
  });

  it('hides Employee Account from every non-Admin role', () => {
    for (const role of [
      'COURSE_CREATOR',
      'GRAPHIC_DESIGNER',
      'FINANCE',
      'OPERATION_ADMIN',
      'OPERATION_AI',
    ] as const) {
      const subs = visibleSettingsSubs(role);
      assert.equal(subs.includes('employeeAccount'), false, role);
      assert.deepEqual(
        subs,
        ['paymentGateway', 'notificationConfiguration', 'learningAccess'],
        role,
      );
    }
  });

  it('builds locale-aware sub-menu hrefs', () => {
    assert.equal(
      settingsSubHref('zh-CN', 'employeeAccount'),
      '/zh-CN/settings/employee-account',
    );
    assert.equal(
      settingsSubHref('en-GB', 'notificationConfiguration'),
      '/en-GB/settings/notification-configuration',
    );
    assert.equal(
      settingsSubHref('en-GB', 'learningAccess'),
      '/en-GB/settings/learning-access',
    );
  });
});

describe('action level robustness', () => {
  // 守卫的输入来自路由表，但函数是公开的；未知动作必须是 false，而不是抛错。
  it('returns false for actions outside the enum, including prototype keys', () => {
    for (const action of [
      'constructor',
      'toString',
      'hasOwnProperty',
      'NOPE',
    ]) {
      assert.equal(
        isActionAllowed('ADMIN', 'course', action as never),
        false,
        action,
      );
    }
  });

  it('VIEW stays true at every level above NONE', () => {
    assert.equal(isActionAllowed('GRAPHIC_DESIGNER', 'course', 'VIEW'), true);
    assert.equal(isActionAllowed('FINANCE', 'order', 'VIEW'), true);
    assert.equal(
      isActionAllowed('OPERATION_ADMIN', 'knowledge', 'VIEW'),
      false,
    );
  });
});
