/**
 * Deep check: run the real Part C compiler on a built package directory.
 *
 * Usage (from the LearningGuideAdmin/server folder):
 *   TS_NODE_TRANSPILE_ONLY=1 npx ts-node --skip-project \
 *     ../docs/package-examples/modeling-life-v2/build/verify_with_compiler.ts \
 *     --dir /tmp/modeling-life-v2-build/staging-lite \
 *     --server-dir "$(pwd)"
 *
 * It calls parsePackage → validatePackage → deriveTiming → alignPackage with
 * the real contracts/compiler (no copies of the rules). No document structure
 * or ASR artifacts are supplied: the package's own SRT (L001) and MP4 chapter
 * track (L002) must be enough to derive every learning-point interval.
 *
 * Exit 0 = no blocking error and derived LP times match the manifest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

import {
  parsePackage,
  type RawWorkbook,
} from '../../../../server/src/partc/compiler/parse';
import {
  validatePackage,
} from '../../../../server/src/partc/compiler/validate';
import { deriveTiming } from '../../../../server/src/partc/compiler/derive-timing';
import {
  alignPackage,
  assetVersionsFromPins,
} from '../../../../server/src/partc/compiler/align';

function arg(name: string, fallback?: string): string {
  const index = process.argv.indexOf(`--${name}`);
  if (index === -1) {
    if (fallback === undefined) throw new Error(`--${name} is required`);
    return fallback;
  }
  return process.argv[index + 1];
}

const packageDir = path.resolve(arg('dir'));
const serverDir = path.resolve(arg('server-dir'));
const requireFromServer = createRequire(path.join(serverDir, 'package.json'));
const XLSX = requireFromServer('xlsx');

function readFiles(root: string): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>();
  const walk = (dir: string): void => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else files.set(path.relative(root, full).split(path.sep).join('/'), fs.readFileSync(full));
    }
  };
  walk(root);
  return files;
}

function decodeWorkbook(bytes: Uint8Array): RawWorkbook {
  const workbook = XLSX.read(Buffer.from(bytes), { type: 'buffer' });
  const sheets: Record<string, { headers: unknown[]; rows: unknown[][] }> = {};
  for (const name of workbook.SheetNames) {
    const matrix = XLSX.utils.sheet_to_json<unknown[]>(workbook.Sheets[name], {
      header: 1,
      defval: null,
      raw: true,
    });
    sheets[name] = { headers: matrix[0] ?? [], rows: matrix.slice(1) };
  }
  return { sheets };
}

const files = readFiles(packageDir);
const manifestBytes = files.get('manifest.json');
if (!manifestBytes) throw new Error('manifest.json missing');
const manifest = JSON.parse(Buffer.from(manifestBytes).toString('utf8'));

const template = manifest.resources.find(
  (resource: { kind: string }) => resource.kind === 'template',
);
if (!template) throw new Error('template resource missing');
const templateBytes = files.get(template.path);
if (!templateBytes) throw new Error('template bytes missing');

const ir = parsePackage({
  manifest,
  files,
  workbook: decodeWorkbook(templateBytes),
});
// 来源强制保持休眠：本示例包 provenance.sourceEnv=sandbox，但校验不依赖该开关。
const validation = validatePackage(ir);
const timing = deriveTiming({ ir, rows: validation.rows });
const align = alignPackage({
  ir,
  rows: validation.rows,
  timing,
  options: { assetVersions: assetVersionsFromPins(ir) },
});
const issues = [...validation.issues, ...timing.issues, ...align.issues];

const errors = issues.filter((issue) => issue.severity === 'error');
const incomplete = issues.filter((issue) => issue.severity === 'incomplete');
const warnings = issues.filter((issue) => issue.severity === 'warning');

console.log(`package: ${packageDir}`);
console.log(`manifest: formatVersion=${manifest.formatVersion} course=${manifest.course.courseKey} versionNo=${manifest.content.versionNo}`);
console.log(`contract parse: OK`);
console.log(`rows: lessons=${validation.rows.lessons.length} LP=${validation.rows.learningPoints.length} exhibits=${validation.rows.exhibits.length} KT=${validation.rows.knowledgeTests.length} AT=${validation.rows.applicationTests.length} readings=${validation.rows.readings.length} media=${validation.rows.media.length}`);
console.log(`timing: coordinates=${timing.coordinates.length} assets=${timing.assets.length}`);
for (const asset of timing.assets) {
  console.log(`  asset ${asset.assetKey}: durationMs=${asset.durationMs} chapterSource=${asset.chapterSource}`);
}
console.log('  LP coordinates (en-GB):');
for (const coordinate of timing.coordinates.filter((item) => item.kind === 'lp' && item.carrierType === 'asset')) {
  console.log(`    ${coordinate.lessonCode} ${coordinate.code}: [${coordinate.startMs}, ${coordinate.endMs}) ${coordinate.anchorSource} <- ${coordinate.provenance.sourceArtifact}`);
}
console.log(`derived: specs=${align.contentSpecs.length} blocks=${align.blocks.length} renditions=${align.renditions.length} proposedAlignments=${align.alignments.length}`);

const codes = (list: typeof issues) => {
  const counts = new Map<string, number>();
  for (const issue of list) counts.set(issue.code, (counts.get(issue.code) ?? 0) + 1);
  return [...counts.entries()].map(([code, count]) => `${code}×${count}`).join(', ') || 'none';
};
console.log(`issues: errors=${errors.length} [${codes(errors)}]`);
console.log(`        incomplete=${incomplete.length} [${codes(incomplete)}]`);
console.log(`        warnings=${warnings.length} [${codes(warnings)}]`);

let failed = false;
if (errors.length > 0) {
  failed = true;
  for (const issue of errors.slice(0, 20)) {
    console.log(`  ERROR ${issue.code}: ${issue.message} ${JSON.stringify(issue.source ?? {})}`);
  }
}

// Derived LP video times must equal the frozen manifest renditions.
const manifestVideo = new Map<string, { startMs?: number; endMs?: number }>();
for (const rendition of manifest.content.renditions) {
  if (rendition.blockId === 'video') {
    manifestVideo.set(`${rendition.contentKey}\u0000${rendition.occurrenceKey}`, rendition);
  }
}
let mismatches = 0;
for (const coordinate of timing.coordinates) {
  if (coordinate.kind !== 'lp' || coordinate.carrierType !== 'asset') continue;
  const key = `${coordinate.lessonCode}\u0000${coordinate.occurrenceKey}`;
  const rendition = manifestVideo.get(key);
  if (!rendition) {
    mismatches += 1;
    console.log(`  MISMATCH missing manifest rendition for ${key}`);
    continue;
  }
  if (rendition.startMs !== coordinate.startMs || rendition.endMs !== coordinate.endMs) {
    mismatches += 1;
    console.log(
      `  MISMATCH ${key}: manifest [${rendition.startMs}, ${rendition.endMs}) vs derived [${coordinate.startMs}, ${coordinate.endMs})`,
    );
  }
}
console.log(`manifest/derived LP timing: ${mismatches === 0 ? 'MATCH' : `${mismatches} mismatch(es)`}`);
if (mismatches > 0) failed = true;

const sourceKinds = new Set(timing.coordinates.map((item) => item.anchorSource));
console.log(`anchor sources used: ${[...sourceKinds].sort().join(', ')}`);
if (!sourceKinds.has('subtitle') || !sourceKinds.has('chapter')) {
  console.log('  ERROR: expected both subtitle (L001) and chapter (L002) machine sources');
  failed = true;
}

console.log(`RESULT: ${failed ? 'FAIL' : 'PASS'}`);
process.exit(failed ? 1 : 0);
