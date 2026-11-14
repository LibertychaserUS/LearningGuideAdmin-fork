#!/usr/bin/env node
/**
 * Build a templateVersion=2 workbook for the long-range fixtures.
 *
 * Usage:
 *   node build_workbook.mjs --variant f2|f3|f5 --data <course_content.json> --out <file.xlsx>
 *   node build_workbook.mjs --variant bad --bad-variant baseline|illegal-media-type|\
 *     missing-language|unknown-code|duplicate-key --out <file.xlsx>
 *
 * Uses the plain `xlsx` library only; never imports product code. Header order
 * is copied from the v2 machine contract (design §14 C0 / template-v2.ts) so a
 * header drift in the fixture is visible in review.
 */
import fs from 'node:fs';
import XLSX from 'xlsx';

const HEADERS = {
  Meta: ['templateVersion', 'courseCode', 'learningLanguages', 'studyMode'],
  Media: ['asset_key', 'kind', 'lesson_code', 'language', 'relative_path', 'thumbnail_of'],
  'Course Info': ['field', 'language', 'text'],
  Lessons: ['lesson_code', 'order', 'language', 'title', 'description'],
  'Learning Points': ['lesson_code', 'lp_code', 'language', 'title'],
  Exhibits: ['lesson_code', 'exhibit_code', 'media_type', 'asset_key', 'language', 'title', 'description', 'source'],
  'Reading List': ['lesson_code', 'type', 'title', 'author', 'why'],
  'Knowledge Test': ['lesson_code', 'order', 'language', 'question', 'reference_answer'],
  'Application Test': ['lesson_code', 'language', 'question', 'reference_answer'],
};

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

function mediaRowsF2() {
  return [
    ['modeling-life-cover', 'cover', null, null, 'media/cover.png', null],
    ['l1-video', 'video', 'L1', 'en-GB', 'media/l1-video.mp4', null],
    ['l2-video', 'video', 'L2', 'en-GB', 'media/l2-video.mp4', null],
    ['l1-subtitle', 'subtitle', 'L1', 'en-GB', 'subtitles/l1.en-GB.srt', null],
    ['l2-subtitle', 'subtitle', 'L2', 'en-GB', 'subtitles/l2.en-GB.vtt', null],
    ['l1-doc', 'lesson-text', 'L1', 'en-GB', 'lessons/l1.docx', null],
    ['l2-doc', 'lesson-text', 'L2', 'en-GB', 'lessons/l2.docx', null],
    ['l1-ex1', 'image', 'L1', 'en-GB', 'media/l1-ex1.png', null],
    ['l1-ex2', 'image', 'L1', 'en-GB', 'media/l1-ex2.png', null],
    ['l1-ex1-thumb', 'thumbnail', 'L1', 'en-GB', 'media/l1-ex1-thumb.png', 'l1-ex1'],
    ['l1-ex2-thumb', 'thumbnail', 'L1', 'en-GB', 'media/l1-ex2-thumb.png', 'l1-ex2'],
  ];
}

function mediaRowsF3() {
  return mediaRowsF2().filter((row) => row[1] !== 'subtitle');
}

function buildCourseSheets(data, mediaRows) {
  const courseInfo = [];
  for (const [field, en, zh] of [
    ['title', data.titleEn, data.titleZh],
    ['shortDescription', data.shortDescriptionEn, data.shortDescriptionZh],
    ['overview', data.overviewEn, data.overviewZh],
    ['whatYouLearn', data.whatYouLearnEn, data.whatYouLearnZh],
    ['provides', data.providesEn, data.providesZh],
  ]) {
    courseInfo.push([field, 'en-GB', en], [field, 'zh-CN', zh]);
  }

  const lessons = [];
  const learningPoints = [];
  const exhibits = [];
  const imageAssetByExhibit = { '1.1': 'l1-ex1', '1.2': 'l1-ex2' };
  for (const lesson of data.lessons) {
    for (const lang of ['en-GB', 'zh-CN']) {
      lessons.push([
        lesson.code,
        lesson.order,
        lang,
        lang === 'en-GB' ? lesson.titleEn : lesson.titleZh,
        lang === 'en-GB' ? lesson.descEn : lesson.descZh,
      ]);
    }
    for (const lp of lesson.learningPoints) {
      learningPoints.push([
        lesson.code,
        lp.code,
        'en-GB',
        lp.titleEn,
      ], [
        lesson.code,
        lp.code,
        'zh-CN',
        lp.titleZh,
      ]);
    }
    for (const exhibit of lesson.exhibits) {
      const asset = imageAssetByExhibit[exhibit.code];
      for (const lang of ['en-GB', 'zh-CN']) {
        exhibits.push([
          lesson.code,
          exhibit.code,
          asset ? 'image' : 'text',
          asset ?? null,
          lang,
          lang === 'en-GB' ? exhibit.titleEn : exhibit.titleZh,
          null,
          null,
        ]);
      }
    }
  }

  return {
    Meta: [[2, data.courseKey, data.learningLanguages.join(','), data.studyMode]],
    Media: mediaRows,
    'Course Info': courseInfo,
    Lessons: lessons,
    'Learning Points': learningPoints,
    Exhibits: exhibits,
    'Reading List': [],
    'Knowledge Test': [],
    'Application Test': [],
  };
}

function buildBadSheets(badVariant) {
  let media = [
    ['bad-cover', 'cover', null, null, 'media/cover.png', null],
    ['bad-video', 'video', 'BL1', 'en-GB', 'media/bad-video.mp4', null],
    ['bad-sub', 'subtitle', 'BL1', 'en-GB', 'subtitles/BL1.en-GB.srt', null],
  ];
  const learningPoints = [
    ['BL1', '1.1', 'en-GB', 'Baseline learning point'],
  ];
  if (badVariant === 'illegal-media-type') {
    media = media.map((row) =>
      row[0] === 'bad-video' ? [row[0], 'pdf', ...row.slice(2)] : row,
    );
  }
  if (badVariant === 'missing-language') {
    media = media.map((row) =>
      row[0] === 'bad-video' ? [row[0], row[1], row[2], null, ...row.slice(4)] : row,
    );
  }
  if (badVariant === 'duplicate-key') {
    learningPoints.push(['BL1', '1.1', 'en-GB', 'Duplicate learning point key']);
  }
  const knowledgeTests =
    badVariant === 'unknown-code'
      ? [['NOPE', 1, 'en-GB', 'Ghost question', 'Ghost answer']]
      : [];
  return {
    Meta: [[2, 'bad-baseline', 'en-GB', 'video']],
    Media: media,
    'Course Info': [
      ['title', 'en-GB', 'Bad baseline'],
      ['shortDescription', 'en-GB', 'Minimal invalid-package baseline'],
    ],
    Lessons: [['BL1', 1, 'en-GB', 'Baseline lesson', 'Baseline description']],
    'Learning Points': learningPoints,
    Exhibits: [],
    'Reading List': [],
    'Knowledge Test': knowledgeTests,
    'Application Test': [],
  };
}

function main() {
  const variant = arg('variant');
  const out = arg('out');
  if (!variant || !out) {
    throw new Error('--variant and --out are required');
  }

  let sheets;
  if (variant === 'bad') {
    sheets = buildBadSheets(arg('bad-variant', 'baseline'));
  } else {
    const dataPath = arg('data');
    if (!dataPath) throw new Error('--data is required for course variants');
    const data = JSON.parse(fs.readFileSync(dataPath, 'utf8'));
    const mediaRows =
      variant === 'f3' ? mediaRowsF3() : mediaRowsF2();
    sheets = buildCourseSheets(data, mediaRows);
  }

  const workbook = XLSX.utils.book_new();
  for (const [name, rows] of Object.entries(sheets)) {
    const matrix = [HEADERS[name], ...rows];
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet(matrix),
      name,
    );
  }
  const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
  fs.writeFileSync(out, buffer);
  console.log(`workbook ${variant} -> ${out} (${buffer.length} bytes)`);
}

main();
