'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { z } from 'zod';

import {
  CountChart,
  DateRangePicker,
  Stat,
  TrendChart,
  lastDays,
  type DateRange,
} from '@remnaray/ui';

import { adminApi } from '../../lib/admin-client';
import { money } from '../../lib/format';
import { useResource } from '../../lib/resource';
import { AdminShell } from './admin-shell';
import { AdminSection } from './admin-states';

const moneySchema = z.object({ amountMinor: z.number(), currency: z.string() });

const overviewSchema = z.object({
  range: z.object({ from: z.string(), to: z.string() }),
  receipts: moneySchema,
  sales: moneySchema,
  payments: z.number(),
  averagePayment: moneySchema,
  newUsers: z.number(),
  trialsIssued: z.number(),
  trialConversionPercent: z.number(),
  activeSubscriptions: z.number(),
  expiringInThreeDays: z.number(),
  userBalanceLiability: moneySchema,
  referralRewards: moneySchema,
  topProviders: z.array(
    z.object({ provider: z.string(), total: moneySchema, payments: z.number() }),
  ),
});

const seriesSchema = z.object({
  receipts: z.array(z.object({ day: z.string(), amountMinor: z.number() })),
  registrations: z.array(z.object({ day: z.string(), count: z.number() })),
});

const attentionSchema = z.object({
  provisioningFailed: z.number(),
  stuckJobs: z.number(),
  panelLastSyncedAt: z.string().nullable(),
  panelLastReconciledAt: z.string().nullable().default(null),
});

type Data = {
  overview: z.infer<typeof overviewSchema>;
  series: z.infer<typeof seriesSchema>;
  attention: z.infer<typeof attentionSchema>;
};

export default function DashboardClient() {
  const t = useTranslations('admin');
  const [range, setRange] = useState<DateRange>(() => lastDays(30));
  const query = useMemo(
    () => ({ from: `${range.from}T00:00:00.000Z`, to: `${range.to}T23:59:59.999Z` }),
    [range.from, range.to],
  );

  const resource = useResource<Data>(`admin:dashboard:${range.from}:${range.to}`, async () => {
    const api = adminApi();
    const [overview, series, attention] = await Promise.all([
      api.get('api/admin/v1/dashboard', overviewSchema, { query }),
      api.get('api/admin/v1/dashboard/series', seriesSchema, { query }),
      api.get('api/admin/v1/dashboard/attention', attentionSchema),
    ]);
    return { overview, series, attention };
  });

  return (
    <AdminShell>
      {() => (
        <section className="flex flex-col gap-6">
          <div className="flex flex-wrap items-end justify-between gap-4">
            <h1 className="text-2xl font-bold">{t('dashboard.title')}</h1>
            <DateRangePicker
              labels={{ preset: (days) => `${days.toString()}d` }}
              onChange={setRange}
              value={range}
            />
          </div>

          <AdminSection refresh={resource.refresh} state={resource.state}>
            {(data) => (
              <div className="flex flex-col gap-6">
                <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
                  <Stat
                    label={t('dashboard.receipts')}
                    value={money(
                      data.overview.receipts.amountMinor,
                      data.overview.receipts.currency,
                      'ru',
                    )}
                  />
                  <Stat
                    label={t('dashboard.sales')}
                    value={money(
                      data.overview.sales.amountMinor,
                      data.overview.sales.currency,
                      'ru',
                    )}
                  />
                  <Stat label={t('dashboard.payments')} value={data.overview.payments} />
                  <Stat
                    label={t('dashboard.averagePayment')}
                    value={money(
                      data.overview.averagePayment.amountMinor,
                      data.overview.averagePayment.currency,
                      'ru',
                    )}
                  />
                  <Stat label={t('dashboard.newUsers')} value={data.overview.newUsers} />
                  <Stat label={t('dashboard.trials')} value={data.overview.trialsIssued} />
                  <Stat
                    label={t('dashboard.conversion')}
                    value={`${data.overview.trialConversionPercent.toString()}%`}
                  />
                  <Stat label={t('dashboard.active')} value={data.overview.activeSubscriptions} />
                  <Stat label={t('dashboard.expiring')} value={data.overview.expiringInThreeDays} />
                  <Stat
                    label={t('dashboard.liability')}
                    value={money(
                      data.overview.userBalanceLiability.amountMinor,
                      data.overview.userBalanceLiability.currency,
                      'ru',
                    )}
                  />
                  <Stat
                    label={t('dashboard.referralRewards')}
                    value={money(
                      data.overview.referralRewards.amountMinor,
                      data.overview.referralRewards.currency,
                      'ru',
                    )}
                  />
                </div>

                <div className="grid gap-4 lg:grid-cols-2">
                  <TrendChart
                    emptyLabel={t('dashboard.noData')}
                    formatValue={(value) => money(value, 'RUB', 'ru')}
                    points={data.series.receipts.map((row) => ({
                      label: row.day.slice(5),
                      value: row.amountMinor,
                    }))}
                    seriesLabel={t('dashboard.receipts')}
                    tableLabels={{ period: t('dashboard.day'), value: t('dashboard.receipts') }}
                    title={t('dashboard.receiptsChart')}
                  />
                  <CountChart
                    emptyLabel={t('dashboard.noData')}
                    points={data.series.registrations.map((row) => ({
                      label: row.day.slice(5),
                      value: row.count,
                    }))}
                    seriesLabel={t('dashboard.newUsers')}
                    tableLabels={{ period: t('dashboard.day'), value: t('dashboard.newUsers') }}
                    title={t('dashboard.registrationsChart')}
                  />
                </div>

                <div className="rounded-lg border border-border bg-surface p-4">
                  <h2 className="text-sm font-semibold">{t('dashboard.attention')}</h2>
                  <dl className="mt-3 grid gap-3 sm:grid-cols-3">
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        {t('dashboard.provisioningFailed')}
                      </dt>
                      <dd className="text-lg font-semibold">{data.attention.provisioningFailed}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">{t('dashboard.stuckJobs')}</dt>
                      <dd className="text-lg font-semibold">{data.attention.stuckJobs}</dd>
                    </div>
                    <div>
                      <dt className="text-xs text-muted-foreground">
                        {t('dashboard.panelSynced')}
                      </dt>
                      <dd className="text-lg font-semibold">
                        {data.attention.panelLastReconciledAt
                          ? new Date(data.attention.panelLastReconciledAt).toLocaleString('ru')
                          : t('dashboard.never')}
                      </dd>
                    </div>
                  </dl>
                </div>
              </div>
            )}
          </AdminSection>
        </section>
      )}
    </AdminShell>
  );
}
