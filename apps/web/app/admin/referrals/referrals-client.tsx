'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';
import { z } from 'zod';

import { permissions as allPermissions } from '@remnaray/domain';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  DataTable,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
  useToast,
} from '@remnaray/ui';

import { adminApi, errorCode } from '../../../lib/admin-client';
import { money } from '../../../lib/format';
import { invalidate, useResource } from '../../../lib/resource';
import { AdminShell } from '../admin-shell';
import { AdminSection, useAdminErrorMessage } from '../admin-states';

const programSchema = z.object({
  enabled: z.boolean(),
  mode: z.string(),
  percent: z.number(),
  fixed_minor: z.string(),
  all_months: z.number(),
  hold_hours: z.number(),
  max_rewards_per_day: z.number(),
  min_source_amount_minor: z.string(),
  invitee_bonus: z.object({ type: z.string(), value: z.number() }),
  invitee_bonus_trigger: z.string(),
});

const rewardsSchema = z.object({
  items: z.array(
    z.object({
      id: z.string(),
      referrerId: z.string().nullable(),
      amountMinor: z.number(),
      status: z.string(),
      holdUntil: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
  nextCursor: z.string().nullable(),
});

type Program = z.infer<typeof programSchema>;
type Data = { program: Program; rewards: z.infer<typeof rewardsSchema> };

const MODES = ['percent_first', 'percent_all', 'fixed_first'] as const;
const BONUS_TYPES = ['none', 'days', 'balance'] as const;
const TRIGGERS = ['signup', 'first_paid'] as const;

export default function ReferralsAdminClient() {
  const t = useTranslations('admin');
  const { toast } = useToast();
  const message = useAdminErrorMessage();
  const [draft, setDraft] = useState<Program | null>(null);
  const [reverseTarget, setReverseTarget] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const resource = useResource<Data>('admin:referrals', async () => {
    const api = adminApi();
    const [program, rewards] = await Promise.all([
      api.get('api/admin/v1/referral/program', programSchema),
      api.get('api/admin/v1/referral/rewards', rewardsSchema, { query: { limit: 100 } }),
    ]);
    return { program, rewards };
  });

  const fail = useCallback(
    (error: unknown) => {
      toast({
        title: t('errorTitle'),
        description: message(errorCode(error)),
        variant: 'danger',
      });
    },
    [message, t, toast],
  );

  const save = useCallback(
    (program: Program) => {
      setPending(true);
      adminApi()
        .send('PUT', 'api/admin/v1/referral/program', z.unknown(), {
          ...program,
          reason: 'referral programme update',
        })
        .then(() => {
          setDraft(null);
          invalidate('admin:referrals');
          toast({ title: t('saved') });
        }, fail)
        .finally(() => {
          setPending(false);
        });
    },
    [fail, t, toast],
  );

  return (
    <AdminShell>
      {(me) => {
        const canWrite =
          allPermissions.includes('referrals.write') && me.permissions.includes('referrals.write');
        return (
          <section className="flex flex-col gap-6">
            <h1 className="text-2xl font-bold">{t('referrals.title')}</h1>

            <AdminSection refresh={resource.refresh} state={resource.state}>
              {(data) => {
                const program = draft ?? data.program;
                return (
                  <div className="flex flex-col gap-6">
                    <Card>
                      <CardHeader>
                        <CardTitle>{t('referrals.title')}</CardTitle>
                      </CardHeader>
                      <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
                        <label className="flex items-center gap-2 text-sm">
                          <input
                            checked={program.enabled}
                            disabled={!canWrite}
                            type="checkbox"
                            onChange={(event) => {
                              setDraft({ ...program, enabled: event.target.checked });
                            }}
                          />
                          {t('referrals.enabled')}
                        </label>
                        <div className="flex flex-col gap-1">
                          <Label htmlFor="mode">{t('referrals.mode')}</Label>
                          <Select
                            disabled={!canWrite}
                            value={program.mode}
                            onValueChange={(value) => {
                              setDraft({ ...program, mode: value });
                            }}
                          >
                            <SelectTrigger id="mode">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {MODES.map((item) => (
                                <SelectItem key={item} value={item}>
                                  {item}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <NumberField
                          disabled={!canWrite}
                          id="percent"
                          label={t('referrals.percent')}
                          value={program.percent}
                          onChange={(value) => {
                            setDraft({ ...program, percent: value });
                          }}
                        />
                        <NumberField
                          disabled={!canWrite}
                          id="all-months"
                          label={t('referrals.allMonths')}
                          value={program.all_months}
                          onChange={(value) => {
                            setDraft({ ...program, all_months: value });
                          }}
                        />
                        <NumberField
                          disabled={!canWrite}
                          id="hold"
                          label={t('referrals.holdHours')}
                          value={program.hold_hours}
                          onChange={(value) => {
                            setDraft({ ...program, hold_hours: value });
                          }}
                        />
                        <NumberField
                          disabled={!canWrite}
                          id="max-day"
                          label={t('referrals.maxPerDay')}
                          value={program.max_rewards_per_day}
                          onChange={(value) => {
                            setDraft({ ...program, max_rewards_per_day: value });
                          }}
                        />
                        <div className="flex flex-col gap-1">
                          <Label htmlFor="bonus-type">{t('referrals.inviteeBonusType')}</Label>
                          <Select
                            disabled={!canWrite}
                            value={program.invitee_bonus.type}
                            onValueChange={(value) => {
                              setDraft({
                                ...program,
                                invitee_bonus: { ...program.invitee_bonus, type: value },
                              });
                            }}
                          >
                            <SelectTrigger id="bonus-type">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {BONUS_TYPES.map((item) => (
                                <SelectItem key={item} value={item}>
                                  {item}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        <NumberField
                          disabled={!canWrite}
                          id="bonus-value"
                          label={t('referrals.inviteeBonusValue')}
                          value={program.invitee_bonus.value}
                          onChange={(value) => {
                            setDraft({
                              ...program,
                              invitee_bonus: { ...program.invitee_bonus, value },
                            });
                          }}
                        />
                        <div className="flex flex-col gap-1">
                          <Label htmlFor="trigger">{t('referrals.inviteeBonusTrigger')}</Label>
                          <Select
                            disabled={!canWrite}
                            value={program.invitee_bonus_trigger}
                            onValueChange={(value) => {
                              setDraft({ ...program, invitee_bonus_trigger: value });
                            }}
                          >
                            <SelectTrigger id="trigger">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {TRIGGERS.map((item) => (
                                <SelectItem key={item} value={item}>
                                  {item}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>
                        {canWrite ? (
                          <div className="flex items-end">
                            <Button
                              disabled={pending || draft === null}
                              onClick={() => {
                                save(program);
                              }}
                            >
                              {t('referrals.saveProgram')}
                            </Button>
                          </div>
                        ) : null}
                      </CardContent>
                    </Card>

                    <div>
                      <h2 className="mb-3 text-lg font-semibold">{t('referrals.rewards')}</h2>
                      <DataTable
                        columns={[
                          {
                            key: 'referrer',
                            header: t('referrals.referrer'),
                            cell: (row) => row.referrerId?.slice(0, 8) ?? '—',
                          },
                          {
                            key: 'amount',
                            header: t('referrals.amount'),
                            cell: (row) => money(row.amountMinor, 'RUB', 'ru'),
                          },
                          {
                            key: 'status',
                            header: t('promocodes.status'),
                            cell: (row) => (
                              <Badge
                                variant={
                                  row.status === 'reversed'
                                    ? 'danger'
                                    : row.status === 'held'
                                      ? 'warning'
                                      : 'success'
                                }
                              >
                                {row.status}
                              </Badge>
                            ),
                          },
                          {
                            key: 'holdUntil',
                            header: t('referrals.holdUntil'),
                            cell: (row) =>
                              row.holdUntil ? new Date(row.holdUntil).toLocaleString('ru') : '—',
                          },
                          {
                            key: 'actions',
                            header: '',
                            cell: (row) =>
                              canWrite && row.status !== 'reversed' ? (
                                <Button
                                  size="sm"
                                  variant="danger"
                                  onClick={() => {
                                    setReverseTarget(row.id);
                                  }}
                                >
                                  {t('referrals.reverse')}
                                </Button>
                              ) : null,
                          },
                        ]}
                        labels={{
                          loadMore: t('more'),
                          emptyTitle: t('empty'),
                          errorTitle: t('errorTitle'),
                        }}
                        rowKey={(row) => row.id}
                        rows={data.rewards.items}
                      />
                    </div>
                  </div>
                );
              }}
            </AdminSection>

            <ConfirmDialog
              destructive
              labels={{
                cancel: t('cancel'),
                confirm: t('confirm'),
                reasonLabel: t('reason'),
                reasonRequired: t('reasonRequired'),
              }}
              onConfirm={(reason) => {
                if (!reverseTarget) return;
                setPending(true);
                adminApi()
                  .send(
                    'POST',
                    `api/admin/v1/referral/rewards/${reverseTarget}/reverse`,
                    z.unknown(),
                    { reason },
                  )
                  .then(() => {
                    setReverseTarget(null);
                    invalidate('admin:referrals');
                    toast({ title: t('saved') });
                  }, fail)
                  .finally(() => {
                    setPending(false);
                  });
              }}
              onOpenChange={(open) => {
                if (!open) setReverseTarget(null);
              }}
              open={reverseTarget !== null}
              pending={pending}
              requireReason
              title={t('referrals.reverseTitle')}
            />
          </section>
        );
      }}
    </AdminShell>
  );
}

function NumberField({
  id,
  label,
  value,
  disabled,
  onChange,
}: {
  id: string;
  label: string;
  value: number;
  disabled: boolean;
  onChange: (value: number) => void;
}) {
  return (
    <div className="flex flex-col gap-1">
      <Label htmlFor={id}>{label}</Label>
      <Input
        disabled={disabled}
        id={id}
        type="number"
        value={value}
        onChange={(event) => {
          onChange(Number(event.target.value));
        }}
      />
    </div>
  );
}
