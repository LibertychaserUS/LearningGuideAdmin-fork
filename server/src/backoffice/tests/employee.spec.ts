import assert from 'node:assert/strict';

import {
  EMPLOYEE_ROLES,
  deriveDisplayStatus,
  editsOwnAuthority,
  isSignInEligible,
  isValidEmail,
  leavesNoActiveAdmin,
  normaliseEmail,
} from '../contracts/employee';

describe('last active admin guard (BUG-0329)', () => {
  const lastAdmin = {
    currentRole: 'ADMIN',
    currentStatus: 'ACTIVE',
    emailVerified: true,
    otherActiveAdmins: 0,
  } as const;

  it('blocks demoting the only usable Admin', () => {
    assert.equal(
      leavesNoActiveAdmin({ ...lastAdmin, nextRole: 'OPERATION_ADMIN' }),
      true,
    );
  });

  it('blocks deactivating the only usable Admin', () => {
    assert.equal(
      leavesNoActiveAdmin({ ...lastAdmin, nextStatus: 'INACTIVE' }),
      true,
    );
  });

  it('allows it when another usable Admin remains', () => {
    assert.equal(
      leavesNoActiveAdmin({
        ...lastAdmin,
        otherActiveAdmins: 1,
        nextRole: 'OPERATION_ADMIN',
      }),
      false,
    );
  });

  it('ignores edits that keep the account a usable Admin', () => {
    assert.equal(
      leavesNoActiveAdmin({
        ...lastAdmin,
        nextRole: 'ADMIN',
        nextStatus: 'ACTIVE',
      }),
      false,
    );
  });

  it('does not count an unverified Admin as usable', () => {
    assert.equal(
      leavesNoActiveAdmin({
        ...lastAdmin,
        emailVerified: false,
        nextRole: 'OPERATION_ADMIN',
      }),
      false,
    );
  });

  it('ignores non-Admins and Admins that are already inactive', () => {
    assert.equal(
      leavesNoActiveAdmin({
        ...lastAdmin,
        currentRole: 'FINANCE',
        nextRole: 'OPERATION_AI',
      }),
      false,
    );
    assert.equal(
      leavesNoActiveAdmin({
        ...lastAdmin,
        currentStatus: 'INACTIVE',
        nextStatus: 'INACTIVE',
      }),
      false,
    );
  });

  it('reactivating an inactive Admin is not a removal', () => {
    assert.equal(
      leavesNoActiveAdmin({
        ...lastAdmin,
        currentStatus: 'INACTIVE',
        nextStatus: 'ACTIVE',
      }),
      false,
    );
  });
});

describe('self-edit guard (BUG-0329)', () => {
  const base = {
    actorEmployeeId: 'e-1',
    targetEmployeeId: 'e-1',
    currentRole: 'ADMIN',
    currentStatus: 'ACTIVE',
  } as const;

  it('blocks changing your own role', () => {
    assert.equal(
      editsOwnAuthority({ ...base, nextRole: 'OPERATION_ADMIN' }),
      true,
    );
  });

  it('blocks deactivating yourself', () => {
    assert.equal(editsOwnAuthority({ ...base, nextStatus: 'INACTIVE' }), true);
  });

  it('allows editing someone else', () => {
    assert.equal(
      editsOwnAuthority({
        ...base,
        targetEmployeeId: 'e-2',
        nextRole: 'OPERATION_ADMIN',
        nextStatus: 'INACTIVE',
      }),
      false,
    );
  });

  it('allows yourself when the role, status and email are unchanged', () => {
    assert.equal(
      editsOwnAuthority({ ...base, nextRole: 'ADMIN', nextStatus: 'ACTIVE' }),
      false,
    );
  });
});

describe('employee display status', () => {
  it('maps inactive accounts to Inactive regardless of verification', () => {
    assert.equal(deriveDisplayStatus('INACTIVE', 'VERIFIED'), 'Inactive');
    assert.equal(
      deriveDisplayStatus('INACTIVE', 'PENDING_VERIFICATION'),
      'Inactive',
    );
  });

  it('maps unverified active accounts to Pending', () => {
    assert.equal(
      deriveDisplayStatus('ACTIVE', 'PENDING_VERIFICATION'),
      'Pending',
    );
  });

  it('maps verified active accounts to Active', () => {
    assert.equal(deriveDisplayStatus('ACTIVE', 'VERIFIED'), 'Active');
  });
});

describe('sign-in eligibility', () => {
  it('requires both Active status and Verified email', () => {
    assert.equal(isSignInEligible('ACTIVE', 'VERIFIED'), true);
    assert.equal(isSignInEligible('ACTIVE', 'PENDING_VERIFICATION'), false);
    assert.equal(isSignInEligible('INACTIVE', 'VERIFIED'), false);
    assert.equal(isSignInEligible('INACTIVE', 'PENDING_VERIFICATION'), false);
  });
});

describe('email normalisation', () => {
  it('trims and lowercases so comparison is case-insensitive', () => {
    assert.equal(
      normaliseEmail('  Employee@Example.COM '),
      'employee@example.com',
    );
  });

  it('accepts ordinary addresses and rejects malformed ones', () => {
    assert.equal(isValidEmail('employee@example.com'), true);
    assert.equal(isValidEmail('employee@example'), false);
    assert.equal(isValidEmail('employee example.com'), false);
    assert.equal(isValidEmail(''), false);
  });

  it('rejects malformed domains and dotted local parts', () => {
    for (const bad of [
      'a@b..c',
      'a@.b.c',
      'a@b.c.',
      'a@-b.com',
      'a@b-.com',
      'a@b.c',
      'a@b.c0m',
      '.a@b.com',
      'a.@b.com',
      'a..b@b.com',
    ]) {
      assert.equal(isValidEmail(bad), false, bad);
    }
    for (const good of [
      'first.last+tag@sub.example.co.uk',
      'admin@ilovelearningguide.com',
      'x@xn--fiqs8s.com',
      ' Mixed.Case@Example.COM ',
    ]) {
      assert.equal(isValidEmail(good), true, good);
    }
  });
});

describe('role catalogue', () => {
  it('exposes exactly the six PRD roles in fixed order', () => {
    assert.deepEqual(
      [...EMPLOYEE_ROLES],
      [
        'ADMIN',
        'COURSE_CREATOR',
        'GRAPHIC_DESIGNER',
        'FINANCE',
        'OPERATION_ADMIN',
        'OPERATION_AI',
      ],
    );
  });
});
