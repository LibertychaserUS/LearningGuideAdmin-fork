import assert from 'node:assert/strict';

import { Logger } from '@nestjs/common';

import type { SessionEmployee } from '../contracts/employee';
import type { AuditEventInput } from '../repositories/auditRepository';
import { isActionAllowed, type ActionKind } from '../modules/rbac/permissions';
import {
  createPortalStudentsClient,
  portalBaseMismatch,
  StudentsError,
  type PortalStudentsClient,
} from '../modules/students/portalStudentsClient';
import { createStudentsService } from '../modules/students/studentsService';
import { routeAccess } from '../nest/route-access';

/**
 * Student Management PRD v1.0：路由归类（只读角色只能看，FA-05 / §2）、
 * 操作人由服务端注入、审计（成功与被拒都记）、Portal 错误码映射、未接 Portal 时不发请求。
 */
const employee: SessionEmployee = {
  employeeId: 'emp-7',
  loginEmail: 'ops@example.com',
  role: 'OPERATION_ADMIN',
  displayName: 'Olive',
  accountStatus: 'ACTIVE',
  emailVerification: 'VERIFIED',
  displayStatus: 'Active',
  isBootstrapAdmin: false,
};

function fakePortal(answer: (call: unknown[]) => unknown = () => ({ ok: 1 })) {
  const calls: unknown[][] = [];
  const portal: PortalStudentsClient = {
    get: (...args) => {
      calls.push(['GET', ...args]);
      return Promise.resolve(
        answer(['GET', ...args]) as Record<string, unknown>,
      );
    },
    write: (...args) => {
      calls.push(args);
      const result = answer(args);
      if (result instanceof Error) return Promise.reject(result);
      return Promise.resolve(result as Record<string, unknown>);
    },
  };
  return { portal, calls };
}

describe('student management route access', () => {
  const menu = (menus: string[], action: string) => ({
    kind: 'menu',
    menus,
    action,
  });

  it('reads are VIEW, every student write needs FULL on Student', () => {
    const cases: [string, string, string][] = [
      ['GET', '/api/students', 'VIEW'],
      ['GET', '/api/students/u1', 'VIEW'],
      ['PUT', '/api/students/u1/feature-overrides', 'CREATE'],
      ['POST', '/api/students/u1/actions', 'CREATE'],
      ['POST', '/API/Students/u1/actions', 'CREATE'],
    ];
    for (const [method, path, action] of cases)
      assert.deepEqual(
        routeAccess(method, path),
        menu(['student'], action),
        path,
      );
  });

  it('global switches and emergency off need FULL on Settings', () => {
    assert.deepEqual(
      routeAccess('GET', '/api/learning-access'),
      menu(['settings'], 'VIEW'),
    );
    assert.deepEqual(
      routeAccess('PUT', '/api/learning-access'),
      menu(['settings'], 'PUBLISH'),
    );
    assert.deepEqual(
      routeAccess('POST', '/api/learning-access/emergency'),
      menu(['settings'], 'PUBLISH'),
    );
  });

  it('only Admin and Operation Admin can change anything (view-only roles get read)', () => {
    const writers = ['ADMIN', 'OPERATION_ADMIN'];
    for (const role of [
      'ADMIN',
      'OPERATION_ADMIN',
      'COURSE_CREATOR',
      'GRAPHIC_DESIGNER',
      'FINANCE',
      'OPERATION_AI',
    ] as const) {
      for (const [menuKey, action] of [
        ['student', 'CREATE'],
        ['settings', 'PUBLISH'],
      ] as const) {
        assert.equal(
          isActionAllowed(role, menuKey, action as ActionKind),
          writers.includes(role),
          `${role} ${menuKey}`,
        );
        assert.equal(isActionAllowed(role, menuKey, 'VIEW'), true);
      }
    }
  });
});

describe('students service', () => {
  it('injects the signed-in employee as actor and ignores one sent by the browser', async () => {
    const { portal, calls } = fakePortal();
    const audits: AuditEventInput[] = [];
    const service = createStudentsService({
      portal,
      audit: (event) => {
        audits.push(event);
        return Promise.resolve();
      },
    });
    await service.act(employee, 'u_1', {
      action: 'deactivate',
      reason: ' abuse ',
      actor: { id: 'evil', name: 'x', role: 'ADMIN' },
    });
    assert.deepEqual(calls[0], [
      'POST',
      '/students/u_1/actions',
      { action: 'deactivate', reason: 'abuse' },
      { id: 'emp-7', name: 'Olive', role: 'OPERATION_ADMIN' },
    ]);
    assert.equal(audits[0].eventName, 'student_deactivate');
    assert.equal(audits[0].result, 'SUCCESS');
    assert.equal(audits[0].actorEmployeeId, 'emp-7');
  });

  it('records refused changes as FAILURE and rethrows', async () => {
    const { portal } = fakePortal(
      () => new StudentsError(409, 'EMAIL_TAKEN', 'taken'),
    );
    const audits: AuditEventInput[] = [];
    const service = createStudentsService({
      portal,
      audit: (event) => {
        audits.push(event);
        return Promise.resolve();
      },
    });
    await assert.rejects(
      () =>
        service.act(employee, 'u_1', {
          action: 'change_email',
          email: 'A@B.example',
          reason: 'ticket',
          exemption: null,
        }),
      (error: unknown) =>
        error instanceof StudentsError && error.code === 'EMAIL_TAKEN',
    );
    assert.equal(audits[0].result, 'FAILURE');
    assert.match(audits[0].newValue ?? '', /a@b\.example/);
  });

  it('validates input before calling Portal', async () => {
    const { portal, calls } = fakePortal();
    const service = createStudentsService({ portal, audit: async () => {} });
    const bad: Array<() => Promise<unknown>> = [
      () => service.list({ pageSize: '500' }),
      () => service.list({ status: 'banned' }),
      () =>
        service.saveOverrides(employee, 'u_1', {
          reason: 'x',
          expectedVersion: 'v',
          overrides: { improve_tutor: 'maybe' },
        }),
      () =>
        service.saveOverrides(employee, 'u_1', {
          reason: '',
          expectedVersion: 'v',
          overrides: { improve_tutor: 'allow' },
        }),
      () => service.act(employee, 'u_1', { action: 'merge' }),
      () =>
        service.emergency(employee, {
          feature: 'improve_tutor',
          off: 'yes',
          reason: 'x',
        }),
      () =>
        service.saveSettings(employee, {
          expectedVersion: '1',
          features: { unknown_feature: { enabled: true } },
        }),
    ];
    for (const run of bad)
      await assert.rejects(
        run,
        (error: unknown) =>
          error instanceof StudentsError && error.code === 'INVALID_INPUT',
      );
    // 不合法的学生 ID 一律按查无此人处理，同样不发请求
    await assert.rejects(
      () => service.detail('../etc'),
      (error: unknown) =>
        error instanceof StudentsError && error.code === 'STUDENT_NOT_FOUND',
    );
    assert.equal(calls.length, 0);
  });

  it('passes list filters through and drops "all"', async () => {
    const { portal, calls } = fakePortal();
    const service = createStudentsService({ portal, audit: async () => {} });
    await service.list({
      q: 'lena',
      status: 'all',
      special: 'improve_tutor',
      page: '2',
      pageSize: '100',
    });
    assert.deepEqual(calls[0], [
      'GET',
      '/students?q=lena&special=improve_tutor&page=2&pageSize=100',
    ]);
  });
});

describe('portal students client', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it('does not call Portal when it is not configured', async () => {
    delete process.env.PORTAL_STUDENTS_BASE_URL;
    delete process.env.PORTAL_HELPDESK_BASE_URL;
    let called = false;
    const client = createPortalStudentsClient({
      fetchImpl: () => {
        called = true;
        return Promise.resolve(new Response('{}'));
      },
    });
    await assert.rejects(
      () => client.get('/students'),
      (error: unknown) =>
        error instanceof StudentsError &&
        error.code === 'STUDENTS_NOT_CONNECTED',
    );
    assert.equal(called, false);
  });

  it('reuses the HelpDesk token and maps Portal problems to BackOffice codes', async () => {
    process.env.PORTAL_HELPDESK_BASE_URL = 'https://portal.example/';
    process.env.PORTAL_HELPDESK_TOKEN = 'test-token';
    delete process.env.PORTAL_STUDENTS_BASE_URL;
    delete process.env.PORTAL_STUDENTS_TOKEN;
    const seen: { url: string; auth: string | null; body: unknown }[] = [];
    const client = createPortalStudentsClient({
      fetchImpl: (input, init) => {
        seen.push({
          url: input as string,
          auth: new Headers(init?.headers).get('authorization'),
          body: typeof init?.body === 'string' ? JSON.parse(init.body) : null,
        });
        return Promise.resolve(
          new Response(
            JSON.stringify({
              code: 'version_conflict',
              detail: 'Someone else changed this',
            }),
            { status: 409 },
          ),
        );
      },
    });
    await assert.rejects(
      () =>
        client.write(
          'PUT',
          '/feature-access',
          { reason: 'r' },
          { id: 'e', name: 'n', role: 'ADMIN' },
        ),
      (error: unknown) =>
        error instanceof StudentsError &&
        error.code === 'VERSION_CONFLICT' &&
        error.status === 409,
    );
    assert.equal(
      seen[0].url,
      'https://portal.example/api/integration/feature-access',
    );
    assert.equal(seen[0].auth, 'Bearer test-token');
    assert.deepEqual(seen[0].body, {
      reason: 'r',
      actor: { id: 'e', name: 'n', role: 'ADMIN' },
    });
  });

  it('treats a rejected token as not connected', async () => {
    process.env.PORTAL_STUDENTS_BASE_URL = 'https://portal.example';
    process.env.PORTAL_STUDENTS_TOKEN = 'test-token';
    const client = createPortalStudentsClient({
      fetchImpl: () =>
        Promise.resolve(
          new Response(JSON.stringify({ code: 'invalid_token' }), {
            status: 401,
          }),
        ),
    });
    await assert.rejects(
      () => client.get('/students'),
      (error: unknown) =>
        error instanceof StudentsError &&
        error.code === 'STUDENTS_NOT_CONNECTED',
    );
  });

  // BUG-0330：学员在 Portal 个人设置里填的 country / ageRange / education /
  // areasOfInterest 必须原样到达 BackOffice 学生详情，后端不得裁剪或改名。
  it('returns the student profile exactly as Portal sends it', async () => {
    process.env.PORTAL_STUDENTS_BASE_URL = 'https://portal.example';
    process.env.PORTAL_STUDENTS_TOKEN = 'test-token';
    delete process.env.PORTAL_HELPDESK_BASE_URL;
    delete process.env.PORTAL_HELPDESK_TOKEN;
    const detail = {
      id: 'u1',
      name: 'Round Trip',
      email: 'round-trip@example.test',
      profile: {
        country: 'Hong Kong',
        ageRange: '25–34',
        education: 'Postgraduate',
        interests: ['Philosophy', 'History'],
        language: 'en-GB',
      },
    };
    const seen: string[] = [];
    const client = createPortalStudentsClient({
      fetchImpl: (input) => {
        seen.push(input as string);
        return Promise.resolve(
          new Response(JSON.stringify(detail), {
            status: 200,
            headers: { 'content-type': 'application/json' },
          }),
        );
      },
    });
    const service = createStudentsService({
      portal: client,
      audit: () => Promise.resolve(),
    });

    const got = await service.detail('u1');

    assert.deepEqual(got, detail);
    assert.equal(seen[0], 'https://portal.example/api/integration/students/u1');
  });

  // BUG-0330 的第二种解释：Admin 连的 Portal 不是学员保存资料的那个环境。
  // 客户端只是忠实转述它连的那一个 Portal，所以环境配错时详情一定是空的。
  it('reports the profile of the Portal it is pointed at, so a wrong base shows an empty one', async () => {
    const filled = {
      id: 'u1',
      profile: {
        country: 'Hong Kong',
        ageRange: '25–34',
        education: 'Postgraduate',
        interests: ['Philosophy'],
        language: 'en-GB',
      },
    };
    const empty = {
      id: 'u1',
      profile: {
        country: null,
        ageRange: null,
        education: null,
        interests: [],
        language: 'en-GB',
      },
    };
    const ask = async (base: string, body: unknown) => {
      process.env.PORTAL_STUDENTS_BASE_URL = base;
      process.env.PORTAL_STUDENTS_TOKEN = 'test-token';
      delete process.env.PORTAL_HELPDESK_BASE_URL;
      delete process.env.PORTAL_HELPDESK_TOKEN;
      const client = createPortalStudentsClient({
        fetchImpl: (input) => {
          assert.equal(input, `${base}/api/integration/students/u1`);
          return Promise.resolve(
            new Response(JSON.stringify(body), { status: 200 }),
          );
        },
      });
      return (await client.get('/students/u1')) as {
        profile: Record<string, unknown>;
      };
    };

    const sit = await ask('https://sit.portal.example', filled);
    const uat = await ask('https://uat.portal.example', empty);

    assert.equal(sit.profile.country, 'Hong Kong');
    assert.equal(uat.profile.country, null);
  });

  it('takes students from the students base even when the HelpDesk base points at another Portal', async () => {
    process.env.PORTAL_STUDENTS_BASE_URL = 'https://students.portal.example';
    process.env.PORTAL_STUDENTS_TOKEN = 'students-token';
    process.env.PORTAL_HELPDESK_BASE_URL = 'https://helpdesk.portal.example';
    process.env.PORTAL_HELPDESK_TOKEN = 'helpdesk-token';
    const seen: { url: string; auth: string | null }[] = [];
    const client = createPortalStudentsClient({
      fetchImpl: (input, init) => {
        seen.push({
          url: input as string,
          auth: new Headers(init?.headers).get('authorization'),
        });
        return Promise.resolve(
          new Response(JSON.stringify({ id: 'u1' }), { status: 200 }),
        );
      },
    });

    await client.get('/students/u1');

    assert.equal(
      seen[0].url,
      'https://students.portal.example/api/integration/students/u1',
    );
    assert.equal(seen[0].auth, 'Bearer students-token');
  });

  // BUG-0330 环境错配只告警、不阻断：两个地址指向不同 Portal 时提示一次，取数仍用 students 的。
  it('warns once about two different Portal bases, and keeps using the students one', async () => {
    process.env.PORTAL_STUDENTS_BASE_URL =
      'https://warn-students.portal.example';
    process.env.PORTAL_STUDENTS_TOKEN = 'students-token';
    process.env.PORTAL_HELPDESK_BASE_URL =
      'https://warn-helpdesk.portal.example';
    process.env.PORTAL_HELPDESK_TOKEN = 'helpdesk-token';
    const warn = jest
      .spyOn(Logger.prototype, 'warn')
      .mockImplementation(() => undefined);
    try {
      const client = createPortalStudentsClient({
        fetchImpl: () =>
          Promise.resolve(
            new Response(JSON.stringify({ id: 'u1' }), { status: 200 }),
          ),
      });
      await client.get('/students/u1');
      await client.get('/students/u1');

      const mismatchWarnings = warn.mock.calls.filter((call) =>
        String(call[0]).includes('point at different Portals'),
      );
      assert.equal(
        mismatchWarnings.length,
        1,
        'warned once per pair, not per request',
      );
      assert.match(
        String(mismatchWarnings[0][0]),
        /warn-students\.portal\.example/,
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('stays quiet when the bases differ only by a trailing slash or one is unset', () => {
    process.env.PORTAL_STUDENTS_BASE_URL = 'https://same.portal.example/';
    process.env.PORTAL_HELPDESK_BASE_URL = 'https://same.portal.example';
    assert.equal(portalBaseMismatch(), null);

    delete process.env.PORTAL_HELPDESK_BASE_URL;
    assert.equal(
      portalBaseMismatch(),
      null,
      'one base alone is the documented fallback',
    );
  });
});
