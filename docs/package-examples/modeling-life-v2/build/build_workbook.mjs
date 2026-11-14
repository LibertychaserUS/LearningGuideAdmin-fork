#!/usr/bin/env node
/**
 * Write a templateVersion=2 workbook from a JSON row payload.
 *
 * Usage: node build_workbook.mjs --in <rows.json> --out <template.xlsx>
 *
 * Header order is the v2 machine contract (server/src/partc/contracts/
 * template-v2.ts). The script refuses to write if the payload adds, drops or
 * reorders sheets, or if any header looks like a time column.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`);
  if (i === -1) return fallback;
  return process.argv[i + 1];
}

// Resolve the `xlsx` dependency from the LearningGuideAdmin server install
// (`--server-dir` or LG_SERVER_DIR) so this script can live in docs/ without
// a local node_modules.
const serverDir = arg('server-dir', process.env.LG_SERVER_DIR);
if (!serverDir) {
  throw new Error('--server-dir (or LG_SERVER_DIR) is required to resolve the xlsx library');
}
const requireFromServer = createRequire(path.join(serverDir, 'package.json'));
const XLSX = requireFromServer('xlsx');

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

// Same word-boundary rule as template-v2.ts TIME_COLUMN_HEADER_PATTERN.
const TIME_COLUMN = /(?:^|[^a-z])(?:times?|timestamps?|durations?|seconds?|minutes?|clock|ms|start|end|trigger|时间|时长|秒|分钟|开始|结束|触发)(?:[^a-z]|$)|mm:ss|hh:mm/i;

const inputPath = arg('in');
const outputPath = arg('out');
if (!inputPath || !outputPath) {
  throw new Error('--in and --out are required');
}

const payload = JSON.parse(fs.readFileSync(inputPath, 'utf8'));
const expectedSheets = Object.keys(HEADERS);
const actualSheets = Object.keys(payload);
if (JSON.stringify(actualSheets) !== JSON.stringify(expectedSheets)) {
  throw new Error(
    `sheet set/order mismatch: expected ${expectedSheets.join(',')} got ${actualSheets.join(',')}`,
  );
}

for (const [sheet, headers] of Object.entries(HEADERS)) {
  const offenders = headers.filter((header) => TIME_COLUMN.test(header));
  if (offenders.length > 0) {
    throw new Error(`time-looking header(s) in ${sheet}: ${offenders.join(',')}`);
  }
  const rows = payload[sheet];
  if (!Array.isArray(rows) || rows.length === 0) {
    throw new Error(`sheet ${sheet} has no rows`);
  }
  for (const [i, row] of rows.entries()) {
    if (row.length > headers.length) {
      throw new Error(`sheet ${sheet} row ${i + 2} has ${row.length} cells, expected ${headers.length}`);
    }
  }
}

const workbook = XLSX.utils.book_new();
for (const [sheet, headers] of Object.entries(HEADERS)) {
  const matrix = [headers, ...payload[sheet]];
  XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(matrix), sheet);
}
const buffer = XLSX.write(workbook, { type: 'buffer', bookType: 'xlsx' });
fs.writeFileSync(outputPath, buffer);
console.log(`template -> ${outputPath} (${buffer.length} bytes, ${actualSheets.length} sheets)`);
