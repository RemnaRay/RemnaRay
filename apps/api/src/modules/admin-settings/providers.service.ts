import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { z } from 'zod';

import { Infrastructure } from '../../infra/infra.module';
import { Audited } from '../admin/audit.interceptor';
import { PaymentProviderRegistry } from '../payments/payments.registry';
import { withStarsRuntime } from '../payments/payments.service';
import { mergeProviderConfig, providerFields } from '../payments/provider-fields';
import { decryptSetting, encryptSetting } from '../settings/settings.crypto';
import { SettingsService } from '../settings/settings.service';

const providerPatchSchema = z.object({
  enabled: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(1000).optional(),
  displayName: z.object({ ru: z.string().min(1), en: z.string().min(1) }).optional(),
  config: z.record(z.string(), z.unknown()).optional(),
  reason: z.string().min(3).max(500).optional(),
});

const reorderSchema = z.object({ codes: z.array(z.string().min(1)).min(1).max(50) });

function mask(config: Record<string, unknown>): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    output[key] = /token|secret|password|key|password2?/i.test(key)
      ? typeof value === 'string' && value.length > 4
        ? `••••${value.slice(-4)}`
        : '***'
      : value;
  }
  return output;
}

/** Section 9.6 provider administration and AC-061 health gating. */
@Injectable()
export class ProvidersService {
  private readonly appKey = process.env.RR_APP_KEY ?? '';

  constructor(
    private readonly infra: Infrastructure,
    private readonly registry: PaymentProviderRegistry,
    @Optional() private readonly settings?: SettingsService,
  ) {}

  async list() {
    // The built-in balance (FR-070) has nothing to configure; a row an earlier
    // wizard wrote for it is not listed.
    const rows = (
      await this.infra.db.paymentProvider.findMany({ orderBy: { sortOrder: 'asc' } })
    ).filter((row) => row.code !== 'balance');
    return {
      items: rows.map((row) => {
        const provider = this.registry.has(row.code) ? this.registry.get(row.code) : null;
        return {
          code: row.code,
          enabled: row.enabled,
          sortOrder: row.sortOrder,
          displayName: row.displayName,
          supportsReceipts: provider?.capabilities.receipts ?? row.supportsReceipts,
          kind: provider?.capabilities.kind ?? 'redirect',
          /** FR-061: the form the console draws for this provider. */
          fields: provider ? providerFields(provider.configSchema) : [],
          config: mask(this.config(row.configEnc)),
          lastHealthcheckAt: row.lastHealthcheckAt?.toISOString() ?? null,
          lastHealthcheckOk: row.lastHealthcheckOk,
          lastHealthcheckError: row.lastHealthcheckError,
          /** AC-061: this is what decides whether users see the provider. */
          offeredToUsers: row.enabled && row.lastHealthcheckOk === true,
        };
      }),
    };
  }

  async update(code: string, body: unknown) {
    const input = providerPatchSchema.parse(body);
    const before = await this.require(code);
    // FR-061: the fields sent replace the stored ones, a secret left empty
    // keeps its stored value, and the result must satisfy the provider's
    // schema (a refusal is a VALIDATION_ERROR naming the field).
    let config = this.config(before.configEnc);
    if (input.config !== undefined) {
      if (!this.registry.has(code)) throw new NotFoundException('NOT_FOUND');
      // R29: a stored configuration this key cannot read (a changed
      // RR_APP_KEY) is never merged into `{}` and overwritten: restoring the
      // key, or rotating it, must still find it.
      if (before.configEnc && !this.readable(before.configEnc))
        throw new ConflictException('PROVIDER_CONFIG_UNREADABLE');
      config = this.registry
        .get(code)
        .configSchema.parse(mergeProviderConfig(config, input.config)) as Record<string, unknown>;
    }
    const updated = await this.infra.db.paymentProvider.update({
      where: { code },
      data: {
        ...(input.enabled === undefined ? {} : { enabled: input.enabled }),
        ...(input.sortOrder === undefined ? {} : { sortOrder: input.sortOrder }),
        ...(input.displayName === undefined ? {} : { displayName: input.displayName }),
        ...(input.config === undefined
          ? {}
          : { configEnc: encryptSetting(config, this.appKey).enc }),
      },
    });
    // Section 17.6: the registry re-reads provider config on the next call, and
    // AC-061 requires a fresh healthcheck before the provider can be offered.
    const health = await this.healthcheck(code);
    return new Audited(
      {
        enabled: before.enabled,
        sortOrder: before.sortOrder,
        config: mask(this.config(before.configEnc)),
      },
      { enabled: updated.enabled, sortOrder: updated.sortOrder, config: mask(config), health },
    );
  }

  async healthcheck(code: string) {
    const row = await this.require(code);
    if (!this.registry.has(code)) throw new NotFoundException('NOT_FOUND');
    const provider = this.registry.get(code);
    const started = Date.now();
    let result: { ok: boolean; latencyMs: number; error?: string };
    try {
      const config = this.config(row.configEnc);
      result = await provider.healthcheck(
        code === 'stars' ? await withStarsRuntime(config, this.settings) : config,
      );
    } catch (error) {
      result = { ok: false, latencyMs: Date.now() - started, error: String(error).slice(0, 300) };
    }
    await this.infra.db.paymentProvider.update({
      where: { code },
      data: {
        lastHealthcheckAt: new Date(),
        lastHealthcheckOk: result.ok,
        lastHealthcheckError: result.error ?? null,
      },
    });
    return result;
  }

  async reorder(body: unknown) {
    const input = reorderSchema.parse(body);
    const before = await this.infra.db.paymentProvider.findMany({
      select: { code: true, sortOrder: true },
    });
    for (const [index, code] of input.codes.entries())
      await this.infra.db.paymentProvider.update({
        where: { code },
        data: { sortOrder: (index + 1) * 10 },
      });
    const after = await this.infra.db.paymentProvider.findMany({
      select: { code: true, sortOrder: true },
    });
    return new Audited(before, after, { items: after });
  }

  private readable(enc: string): boolean {
    try {
      decryptSetting({ enc }, this.appKey);
      return true;
    } catch {
      return false;
    }
  }

  private config(enc: string | null): Record<string, unknown> {
    if (!enc) return {};
    try {
      const value = decryptSetting({ enc }, this.appKey);
      return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }

  private async require(code: string) {
    const row = await this.infra.db.paymentProvider.findUnique({ where: { code } });
    if (!row) throw new NotFoundException('NOT_FOUND');
    return row;
  }
}
