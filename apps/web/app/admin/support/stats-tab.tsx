'use client';

import { useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { z } from 'zod';

import { DataTable, DateRangePicker, Stat, lastDays, type DateRange } from '@remnaray/ui';

import { adminApi } from '../../../lib/admin-client';
import { useResource } from '../../../lib/resource';
import { AdminSection } from '../admin-states';

export const statsSchema = z.object({
  opened: z.number(),
  closed: z.number(),
  openNow: z.number(),
  firstResponseSeconds: z.object({ average: z.number().nullable(), median: z.number().nullable() }),
  resolutionSeconds: z.number().nullable(),
  rating: z.object({ average: z.number().nullable(), count: z.number() }),
  operators: z.array(
    z.object({
      telegramId: z.string(),
      name: z.string().nullable(),
      closed: z.number(),
      openNow: z.number(),
      firstResponseSeconds: z.number().nullable(),
      rating: z.object({ average: z.number().nullable(), count: z.number() }),
    }),
  ),
});

/** `1 ч 5 мин`, `3 мин`, `45 с`: a duration in seconds, briefly. */
export function duration(seconds: number | null, units: { h: string; m: string; s: string }) {
  if (seconds === null) return '—';
  if (seconds < 60) return `${seconds.toString()} ${units.s}`;
  const minutes = Math.round(seconds / 60);
  const hours = Math.floor(minutes / 60);
  return hours > 0
    ? `${hours.toString()} ${units.h} ${(minutes % 60).toString()} ${units.m}`
    : `${minutes.toString()} ${units.m}`;
}

/** Support over a period: volume, the time to the first answer and to the close, ratings. */
export function StatsTab() {
  const t = useTranslations('admin');
  const [range, setRange] = useState<DateRange>(() => lastDays(30));
  const query = useMemo(
    () => ({ from: `${range.from}T00:00:00.000Z`, to: `${range.to}T23:59:59.999Z` }),
    [range.from, range.to],
  );
  const resource = useResource(`admin:support:stats:${query.from}:${query.to}`, () =>
    adminApi().get('api/admin/v1/support/stats', statsSchema, { query }),
  );
  const units = { h: t('helpdesk.units.h'), m: t('helpdesk.units.m'), s: t('helpdesk.units.s') };
  const rating = (value: { average: number | null; count: number }) =>
    value.average === null ? '—' : `★${value.average.toFixed(2)} (${value.count.toString()})`;

  return (
    <div className="flex flex-col gap-4">
      <DateRangePicker
        labels={{ preset: (days) => `${days.toString()}d` }}
        onChange={setRange}
        value={range}
      />
      <AdminSection refresh={resource.refresh} state={resource.state}>
        {(data) => (
          <div className="flex flex-col gap-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <Stat label={t('helpdesk.stats.opened')} value={data.opened} />
              <Stat label={t('helpdesk.stats.closed')} value={data.closed} />
              <Stat label={t('helpdesk.stats.openNow')} value={data.openNow} />
              <Stat label={t('helpdesk.stats.rating')} value={rating(data.rating)} />
              <Stat
                label={t('helpdesk.stats.firstResponse')}
                value={duration(data.firstResponseSeconds.average, units)}
              />
              <Stat
                label={t('helpdesk.stats.firstResponseMedian')}
                value={duration(data.firstResponseSeconds.median, units)}
              />
              <Stat
                label={t('helpdesk.stats.resolution')}
                value={duration(data.resolutionSeconds, units)}
              />
            </div>
            <DataTable
              columns={[
                {
                  key: 'name',
                  header: t('helpdesk.assignee'),
                  cell: (row) => row.name ?? row.telegramId,
                },
                { key: 'closed', header: t('helpdesk.stats.closed'), cell: (row) => row.closed },
                { key: 'open', header: t('helpdesk.stats.openNow'), cell: (row) => row.openNow },
                {
                  key: 'first',
                  header: t('helpdesk.stats.firstResponse'),
                  cell: (row) => duration(row.firstResponseSeconds, units),
                },
                {
                  key: 'rating',
                  header: t('helpdesk.stats.rating'),
                  cell: (row) => rating(row.rating),
                },
              ]}
              labels={{ loadMore: t('more'), emptyTitle: t('helpdesk.stats.noOperators') }}
              rowKey={(row) => row.telegramId}
              rows={data.operators}
            />
          </div>
        )}
      </AdminSection>
    </div>
  );
}
