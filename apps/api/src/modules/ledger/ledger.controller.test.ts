import { describe, expect, it, vi } from 'vitest';

import { LedgerController } from './ledger.controller';
import type { LedgerService } from './ledger.service';

describe('LedgerController', () => {
  it('answers the nightly audit job with a JSON count (repair queue R19)', async () => {
    const audit = vi.fn().mockResolvedValue({
      checked: 7,
      mismatches: [{ accountId: 'a', expected: 1n, actual: 2n }],
    });
    const controller = new LedgerController({ audit } as unknown as LedgerService);

    await expect(controller.audit()).resolves.toEqual({ checked: 7, mismatches: 1 });
    expect(audit).toHaveBeenCalledOnce();
  });
});
