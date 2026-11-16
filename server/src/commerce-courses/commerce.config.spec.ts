import { Logger } from '@nestjs/common';
import type { ConfigService } from '@nestjs/config';
import {
  commerceConfig,
  resetProductionModeWarningForTests,
} from './commerce.config';

/**
 * R16（环境标识静默推导无启动校验）回归测试。
 *
 * 推导矩阵：
 * - 显式 VERSION_NUMBERING_MODE=production/sandbox → 该模式，environmentDetermined=true
 *   （production 时启动告警一次）；
 * - 未显式 + NODE_ENV=production → 推导 production，environmentDetermined=true，告警一次
 *   （消息给出『设置 VERSION_NUMBERING_MODE』的可执行指引）；
 * - 未显式 + 其他 → sandbox 兜底（编号等消费者维持现状），environmentDetermined=false
 *   → 导出路径拒绝（见 package-jobs.service.spec）。
 *
 * 告警一次：进程内模块级 flag；每个用例前经 resetProductionModeWarningForTests 归零。
 */

const warnSpy = jest.spyOn(Logger, 'warn');

interface ResolvedConfig {
  versionNumberingMode: string;
  environmentDetermined?: boolean;
  environmentLabel: string;
}

function configServiceFor(
  env: Record<string, string | undefined>,
): ConfigService {
  return { get: (key: string) => env[key] } as unknown as ConfigService;
}

beforeEach(() => {
  warnSpy.mockClear();
  resetProductionModeWarningForTests();
});

describe('commerceConfig — environment semantics (R16)', () => {
  it('explicit production: production mode, determined, one startup warning', () => {
    const config = commerceConfig(
      configServiceFor({
        VERSION_NUMBERING_MODE: 'production',
        NODE_ENV: 'development',
      }),
    ) as ResolvedConfig;
    expect(config.versionNumberingMode).toBe('production');
    expect(config.environmentDetermined).toBe(true);
    expect(config.environmentLabel).toBe('Production');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain(
      'VERSION_NUMBERING_MODE=production',
    );
  });

  it('explicit sandbox: sandbox mode, determined, no warning', () => {
    const config = commerceConfig(
      configServiceFor({
        VERSION_NUMBERING_MODE: 'sandbox',
        NODE_ENV: 'development',
      }),
    ) as ResolvedConfig;
    expect(config.versionNumberingMode).toBe('sandbox');
    expect(config.environmentDetermined).toBe(true);
    expect(config.environmentLabel).toBe('Sandbox');
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('unset mode + NODE_ENV=production: derives production, determined, warns once with actionable guidance', () => {
    const config = commerceConfig(
      configServiceFor({ NODE_ENV: 'production' }),
    ) as ResolvedConfig;
    expect(config.versionNumberingMode).toBe('production');
    expect(config.environmentDetermined).toBe(true);
    expect(config.environmentLabel).toBe('Production');
    expect(warnSpy).toHaveBeenCalledTimes(1);
    expect(warnSpy.mock.calls[0]?.[0]).toContain('NODE_ENV=production');
    expect(warnSpy.mock.calls[0]?.[0]).toContain('VERSION_NUMBERING_MODE');
  });

  it('unset mode + non-production NODE_ENV: sandbox fallback for numbering consumers, but NOT determined (export must refuse)', () => {
    const config = commerceConfig(
      configServiceFor({ NODE_ENV: 'development' }),
    ) as ResolvedConfig;
    expect(config.versionNumberingMode).toBe('sandbox');
    expect(config.environmentDetermined).toBe(false);
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('warns once even when the factory runs multiple times in one process', () => {
    const service = configServiceFor({
      VERSION_NUMBERING_MODE: 'production',
      NODE_ENV: 'development',
    });
    commerceConfig(service);
    commerceConfig(service);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('keeps an explicit ENVIRONMENT_LABEL override', () => {
    const config = commerceConfig(
      configServiceFor({
        VERSION_NUMBERING_MODE: 'production',
        ENVIRONMENT_LABEL: 'UAT',
        NODE_ENV: 'production',
      }),
    ) as ResolvedConfig;
    expect(config.environmentLabel).toBe('UAT');
    expect(config.versionNumberingMode).toBe('production');
  });
});
