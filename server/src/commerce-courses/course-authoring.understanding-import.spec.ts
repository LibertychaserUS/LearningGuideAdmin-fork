import type { PrismaService } from '../prisma/prisma.service';
import { CourseAuthoringService } from './course-authoring.service';

const HEADER =
  'Course ID,Lesson ID,Lesson title,Type,Question,Reference answer';

function csv(...rows: string[]): Buffer {
  return Buffer.from([HEADER, ...rows].join('\n'), 'utf8');
}

type FakePrisma = {
  lesson: { findMany: jest.Mock };
  knowledgeQuestion: { count: jest.Mock; create: jest.Mock };
  applicationTest: { create: jest.Mock };
  commerceCourse: { update: jest.Mock };
  $transaction: jest.Mock;
};

function buildContext() {
  const lessons = [
    { id: 'lesson-1', code: 'L1', applicationTest: null },
    { id: 'lesson-2', code: 'L2', applicationTest: null },
  ];
  const knowledge: Array<Record<string, unknown>> = [];
  const applications: Array<Record<string, unknown>> = [];
  const counts = new Map<string, number>();
  const prisma: FakePrisma = {
    lesson: {
      findMany: jest.fn(() => Promise.resolve(lessons)),
    },
    knowledgeQuestion: {
      count: jest.fn(({ where }: { where: { lessonId: string } }) =>
        Promise.resolve(counts.get(where.lessonId) ?? 0),
      ),
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        knowledge.push(data);
        const lessonId = String(data.lessonId);
        counts.set(lessonId, (counts.get(lessonId) ?? 0) + 1);
        return Promise.resolve(data);
      }),
    },
    applicationTest: {
      create: jest.fn(({ data }: { data: Record<string, unknown> }) => {
        applications.push(data);
        return Promise.resolve(data);
      }),
    },
    commerceCourse: {
      update: jest.fn(() => Promise.resolve({})),
    },
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(
    (fn: (tx: FakePrisma) => Promise<unknown>) => fn(prisma),
  );
  const service = new CourseAuthoringService(
    prisma as unknown as PrismaService,
    {} as never,
    {} as never,
  );
  return { service, prisma, knowledge, applications };
}

describe('CourseAuthoringService understanding import (two phase)', () => {
  it('previews the file without writing anything to the database', async () => {
    const { service, prisma, knowledge, applications } = buildContext();
    const file = {
      originalname: 'understanding.csv',
      buffer: csv(
        'C1,L1,One,Knowledge,What is 1+1?,Two',
        'C1,L1,One,Knowledge,Missing answer,',
        'C1,L2,Two,Knowledge,Define x,X is y',
      ),
    };

    const result = await service.previewUnderstandingImport(
      'course-1',
      'en-GB',
      file,
    );

    expect(result.rowsRead).toBe(3);
    expect(result.added).toBe(2);
    expect(result.byLesson).toEqual({ L1: 1, L2: 1 });
    expect(result.errors).toEqual([
      { row: 3, message: 'Reference answer is empty' },
    ]);
    // The whole point of the preview phase: nothing reaches the database.
    expect(knowledge).toHaveLength(0);
    expect(applications).toHaveLength(0);
    expect(prisma.knowledgeQuestion.create).not.toHaveBeenCalled();
    expect(prisma.applicationTest.create).not.toHaveBeenCalled();
    expect(prisma.commerceCourse.update).not.toHaveBeenCalled();
  });

  it('writes only the valid rows when the preview is confirmed', async () => {
    const { service, knowledge, applications } = buildContext();
    const file = {
      originalname: 'understanding.csv',
      buffer: csv(
        'C1,L1,One,Knowledge,What is 1+1?,Two',
        'C1,L1,One,Knowledge,Missing answer,',
        'C1,L2,Two,Knowledge,Define x,X is y',
      ),
    };

    await service.previewUnderstandingImport('course-1', 'en-GB', file);
    expect(knowledge).toHaveLength(0);

    const result = await service.confirmUnderstandingImport(
      'course-1',
      'en-GB',
      file,
    );

    expect(result.added).toBe(2);
    expect(result.byLesson).toEqual({ L1: 1, L2: 1 });
    expect(result.errors).toEqual([
      { row: 3, message: 'Reference answer is empty' },
    ]);
    expect(knowledge.map((row) => row.question)).toEqual([
      'What is 1+1?',
      'Define x',
    ]);
    expect(knowledge.map((row) => row.code)).toEqual(['K-0001', 'K-0001']);
    expect(applications).toHaveLength(0);
  });

  it('never writes the rows that failed validation, even on confirm', async () => {
    const { service, knowledge, applications } = buildContext();
    const file = {
      originalname: 'understanding.csv',
      buffer: csv(
        'C1,L1,One,Knowledge,,',
        'C1,L9,Missing,Knowledge,Q,A',
        'C1,L2,Two,Application,Q,',
      ),
    };

    const result = await service.confirmUnderstandingImport(
      'course-1',
      'en-GB',
      file,
    );

    expect(result.added).toBe(0);
    expect(result.errors).toHaveLength(3);
    expect(knowledge).toHaveLength(0);
    expect(applications).toHaveLength(0);
  });
});
