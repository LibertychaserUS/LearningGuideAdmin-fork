import { PublishingService, nextVersionLabel } from './publishing.service';

describe('nextVersionLabel', () => {
  it('starts Sandbox at 1.1', () => {
    expect(nextVersionLabel('sandbox', null)).toEqual({
      label: '1.1',
      series: 1,
      minor: 1,
    });
  });

  it('increments Sandbox minor version', () => {
    expect(
      nextVersionLabel('sandbox', {
        versionSeries: 1,
        versionMinor: 1,
        exportedAt: null,
      }),
    ).toEqual({ label: '1.2', series: 1, minor: 2 });
  });

  it('starts a new Sandbox series after export', () => {
    expect(
      nextVersionLabel('sandbox', {
        versionSeries: 1,
        versionMinor: 4,
        exportedAt: new Date('2026-10-30T00:00:00Z'),
      }),
    ).toEqual({ label: '2.1', series: 2, minor: 1 });
  });

  it('uses integer versions in Production', () => {
    expect(nextVersionLabel('production', null)).toEqual({
      label: 'Version 1',
      series: 0,
      minor: 1,
    });
    expect(
      nextVersionLabel('production', {
        versionSeries: 0,
        versionMinor: 3,
        exportedAt: null,
      }),
    ).toEqual({ label: 'Version 4', series: 0, minor: 4 });
  });
});

describe('listVersions — operator display name (PRD §15.5)', () => {
  function serviceFor(
    versions: Array<Record<string, unknown>>,
    employees: Array<{ employeeId: string; loginEmail: string }>,
  ) {
    const findManyEmployees = jest.fn().mockResolvedValue(employees);
    const prisma = {
      commerceCourse: {
        findUnique: jest.fn().mockResolvedValue({ liveVersionId: 'v2' }),
      },
      courseVersion: { findMany: jest.fn().mockResolvedValue(versions) },
      employee: { findMany: findManyEmployees },
    };
    const service = new PublishingService(
      prisma as never,
      {} as never,
      {} as never,
    );
    return { service, findManyEmployees };
  }

  it('looks up the creator employee and returns the login email prefix', async () => {
    const { service, findManyEmployees } = serviceFor(
      [
        { id: 'v2', versionNo: 2, createdBy: 'emp-1' },
        { id: 'v1', versionNo: 1, createdBy: null },
      ],
      [{ employeeId: 'emp-1', loginEmail: 'jane.doe@example.com' }],
    );

    const versions = await service.listVersions('course-1');

    expect(findManyEmployees).toHaveBeenCalledWith({
      where: { employeeId: { in: ['emp-1'] } },
      select: { employeeId: true, loginEmail: true },
    });
    expect(versions[0]).toEqual(
      expect.objectContaining({
        id: 'v2',
        createdBy: 'emp-1',
        createdByName: 'jane.doe',
        isLive: true,
      }),
    );
    expect(versions[1]).toEqual(
      expect.objectContaining({
        id: 'v1',
        createdBy: null,
        createdByName: null,
        isLive: false,
      }),
    );
  });

  it('returns null when the creator is not in the employee table', async () => {
    const { service } = serviceFor(
      [{ id: 'v1', versionNo: 1, createdBy: 'emp-missing' }],
      [],
    );

    const [version] = await service.listVersions('course-1');

    expect(version.createdByName).toBeNull();
  });

  it('skips the employee lookup when no version has a creator', async () => {
    const { service, findManyEmployees } = serviceFor(
      [{ id: 'v1', versionNo: 1, createdBy: null }],
      [],
    );

    await service.listVersions('course-1');

    expect(findManyEmployees).not.toHaveBeenCalled();
  });
});
