import { spawnSync } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { PackageIR } from '../partc/compiler/parse';
import type {
  TimingParamValue,
  TranscriptArtifactInput,
  TranscriptCueInput,
} from '../partc/compiler/derive-timing';

/**
 * ASR 适配器（设计 SSOT §14 C5 P3 / C7 ③ / ALN-7）。
 *
 * 职责：为「每个视频 × 每个语言」从音轨生成机器转写工件（内部派生工件，非
 * 交付物，不进课程包），交给纯函数编译器 `deriveTiming` 做时间派生。
 *
 * Provider 由环境变量驱动（不写死、不内嵌测试桩）：
 * - `ASR_PROVIDER=fixture`：从 `ASR_TRANSCRIPT_DIR` 读取预计算的真实转写工件
 *   `<assetKey>.<language>.json`（测试/离线复算用；工件来自真实音轨的 ASR 输出）。
 * - `ASR_PROVIDER=http`：用 ffmpeg 抽取 16 kHz 单声道 WAV，POST 到外部 ASR
 *   服务（`ASR_HTTP_URL`、`ASR_HTTP_API_KEY`、`ASR_MODEL`），解析转写 cue。
 * - `ASR_PROVIDER=auto`（默认）：有 fixture 目录用 fixture，有 HTTP URL 用 http，
 *   两者都没有则返回空（= 无 ASR 源，编译器按 ALN-7 报 TIMING_SOURCE_MISSING）。
 *
 * 不猜：模型版本/参数/ruleVersion 全部 pin 进 provenance（C7），缺失即不生成。
 */

export type AsrProviderKind = 'off' | 'fixture' | 'http';

export interface AsrAdapterConfig {
  readonly provider: AsrProviderKind;
  readonly fixtureDir: string | null;
  readonly httpUrl: string | null;
  readonly httpApiKey: string | null;
  readonly modelVersion: string;
  readonly ruleVersion: string;
  readonly params: Readonly<Record<string, TimingParamValue>>;
}

interface FixtureTranscriptFile {
  readonly sourceKind?: 'asr' | 'forced-alignment';
  readonly modelVersion?: string;
  readonly params?: Record<string, TimingParamValue>;
  readonly ruleVersion?: string;
  readonly cues?: readonly TranscriptCueInput[];
}

function readConfig(): AsrAdapterConfig {
  const rawProvider = (process.env.ASR_PROVIDER ?? 'auto').trim().toLowerCase();
  const fixtureDir = process.env.ASR_TRANSCRIPT_DIR?.trim() || null;
  const httpUrl = process.env.ASR_HTTP_URL?.trim() || null;
  const modelVersion =
    process.env.ASR_MODEL_VERSION?.trim() || 'asr-external-default';
  const ruleVersion = process.env.ASR_RULE_VERSION?.trim() || 'asr-rules-v1';
  let provider: AsrProviderKind = 'off';
  if (rawProvider === 'fixture' && fixtureDir !== null) {
    provider = 'fixture';
  } else if (rawProvider === 'http' && httpUrl !== null) {
    provider = 'http';
  } else if (rawProvider === 'auto') {
    provider =
      fixtureDir !== null ? 'fixture' : httpUrl !== null ? 'http' : 'off';
  }
  return {
    provider,
    fixtureDir,
    httpUrl,
    httpApiKey: process.env.ASR_HTTP_API_KEY?.trim() || null,
    modelVersion,
    ruleVersion,
    params: { provider: rawProvider, model: modelVersion },
  };
}

interface MediaSlot {
  readonly assetKey: string;
  readonly language: string;
  readonly relativePath: string;
}

/** 视频/音频 Media 行（每个视频 × 每个语言独立派生）。 */
function audioSlots(ir: PackageIR): MediaSlot[] {
  const slots: MediaSlot[] = [];
  for (const row of ir.template.sheets.Media ?? []) {
    const values = row.values;
    const kind = values.kind;
    if (kind !== 'video' && kind !== 'audio') continue;
    const assetKey = values.asset_key;
    const language = values.language;
    const relativePath = values.relative_path;
    if (
      typeof assetKey !== 'string' ||
      typeof language !== 'string' ||
      typeof relativePath !== 'string'
    ) {
      continue;
    }
    slots.push({ assetKey, language, relativePath });
  }
  return slots;
}

function normalizeCues(raw: unknown): TranscriptCueInput[] | null {
  if (!Array.isArray(raw)) return null;
  const cues: TranscriptCueInput[] = [];
  for (const entry of raw) {
    if (entry === null || typeof entry !== 'object') return null;
    const cue = entry as Record<string, unknown>;
    const startMs = cue.startMs;
    const endMs = cue.endMs;
    const text = cue.text;
    const confidence = cue.confidence;
    if (
      typeof startMs !== 'number' ||
      !Number.isInteger(startMs) ||
      typeof endMs !== 'number' ||
      !Number.isInteger(endMs) ||
      typeof text !== 'string' ||
      typeof confidence !== 'number' ||
      !Number.isFinite(confidence) ||
      confidence < 0 ||
      confidence > 1
    ) {
      return null;
    }
    cues.push({ startMs, endMs, text, confidence });
  }
  return cues;
}

async function fixtureTranscripts(
  ir: PackageIR,
  config: AsrAdapterConfig,
): Promise<TranscriptArtifactInput[]> {
  if (config.fixtureDir === null) return [];
  const baseDir = path.isAbsolute(config.fixtureDir)
    ? config.fixtureDir
    : path.resolve(process.cwd(), config.fixtureDir);
  const transcripts: TranscriptArtifactInput[] = [];
  for (const slot of audioSlots(ir)) {
    const file = path.join(baseDir, `${slot.assetKey}.${slot.language}.json`);
    let raw: string;
    try {
      raw = await fs.readFile(file, 'utf8');
    } catch {
      continue; // 该视频/语言没有转写工件 = 无 ASR 源（不猜）。
    }
    let parsed: FixtureTranscriptFile | TranscriptCueInput[];
    try {
      parsed = JSON.parse(raw) as FixtureTranscriptFile | TranscriptCueInput[];
    } catch {
      continue;
    }
    const wrapper: FixtureTranscriptFile = Array.isArray(parsed)
      ? { cues: parsed }
      : parsed;
    const cues = normalizeCues(wrapper.cues);
    if (cues === null || cues.length === 0) continue;
    transcripts.push({
      sourceKind: wrapper.sourceKind ?? 'asr',
      assetKey: slot.assetKey,
      language: slot.language,
      sourceArtifact: `asr:${slot.assetKey}:${slot.language}`,
      modelVersion: wrapper.modelVersion ?? config.modelVersion,
      params: wrapper.params ?? config.params,
      ruleVersion: wrapper.ruleVersion ?? config.ruleVersion,
      cues,
    });
  }
  return transcripts;
}

/** 用 ffmpeg 把视频音轨抽取为 16 kHz 单声道 WAV。 */
function extractAudioWav(inputFile: string, outputFile: string): boolean {
  const result = spawnSync(
    'ffmpeg',
    [
      '-v',
      'error',
      '-y',
      '-i',
      inputFile,
      '-vn',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-f',
      'wav',
      outputFile,
    ],
    { encoding: 'utf8' },
  );
  return result.status === 0;
}

interface HttpAsrResponse {
  readonly cues?: unknown;
  readonly segments?: unknown;
  readonly text?: unknown;
}

async function httpTranscripts(
  ir: PackageIR,
  config: AsrAdapterConfig,
): Promise<TranscriptArtifactInput[]> {
  if (config.httpUrl === null) return [];
  const transcripts: TranscriptArtifactInput[] = [];
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lg-asr-'));
  try {
    for (const slot of audioSlots(ir)) {
      const bytes = ir.files.get(slot.relativePath);
      if (!bytes) continue;
      const inputFile = path.join(tempDir, 'input.bin');
      const wavFile = path.join(tempDir, 'audio.wav');
      await fs.writeFile(inputFile, bytes);
      if (!extractAudioWav(inputFile, wavFile)) continue;
      const wav = await fs.readFile(wavFile);
      const form = new FormData();
      form.append('file', new Blob([wav], { type: 'audio/wav' }), 'audio.wav');
      form.append('model', config.modelVersion);
      form.append('response_format', 'verbose_json');
      const headers: Record<string, string> = {};
      if (config.httpApiKey !== null) {
        headers.Authorization = `Bearer ${config.httpApiKey}`;
      }
      const response = await fetch(config.httpUrl, {
        method: 'POST',
        headers,
        body: form,
      });
      if (!response.ok) continue;
      const payload = (await response.json()) as HttpAsrResponse;
      const cues = normalizeCues(payload.cues ?? payload.segments);
      if (cues === null || cues.length === 0) continue;
      transcripts.push({
        sourceKind: 'asr',
        assetKey: slot.assetKey,
        language: slot.language,
        sourceArtifact: `asr:${slot.assetKey}:${slot.language}`,
        modelVersion: config.modelVersion,
        params: config.params,
        ruleVersion: config.ruleVersion,
        cues,
      });
    }
  } finally {
    await fs
      .rm(tempDir, { recursive: true, force: true })
      .catch(() => undefined);
  }
  return transcripts;
}

/**
 * 生成导入所需的 ASR/强制对齐转写工件（薄壳入口，C5 P3）。
 * 无 provider 时返回空数组（编译器按 ALN-7 显式报缺源，不猜时间）。
 */
export async function extractAsrTranscripts(
  ir: PackageIR,
): Promise<TranscriptArtifactInput[]> {
  const config = readConfig();
  if (config.provider === 'off') return [];
  if (config.provider === 'fixture') return fixtureTranscripts(ir, config);
  return httpTranscripts(ir, config);
}
