'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { z } from 'zod';

import { permissions as allPermissions, type Permission } from '@remnaray/domain';
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
  MoneyInput,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@remnaray/ui';

import { adminApi, errorCode } from '../../../../lib/admin-client';
import {
  adminAuditListSchema,
  adminInvoiceListSchema,
  adminTransactionListSchema,
  adminUserDetailSchema,
} from '../../../../lib/admin-contracts';
import { bytes, money } from '../../../../lib/format';
import { invalidate, useResource } from '../../../../lib/resource';
import { AdminShell, type AdminMe } from '../../admin-shell';
import { AdminSection, useAdminErrorMessage } from '../../admin-states';

type Detail = z.infer<typeof adminUserDetailSchema>;
type PendingAction =
  | { kind: 'extend' }
  | { kind: 'balance' }
  | { kind: 'ban' }
  | { kind: 'unban' }
  | { kind: 'anonymize' }
  | { kind: 'message' }
  | null;

export default function UserDetailClient({ userId }: { userId: string }) {
  const t = useTranslations('admin');
  const { toast } = useToast();
  const message = useAdminErrorMessage();
  const [action, setAction] = useState<PendingAction>(null);
  // Section 9.1: one key per opened action, so confirming it again after a
  // lost answer is answered from the store instead of crediting twice.
  const idempotencyKey = useMemo(() => (action ? crypto.randomUUID() : ''), [action]);
  const [days, setDays] = useState(30);
  const [amountMinor, setAmountMinor] = useState<bigint | null>(null);
  const [text, setText] = useState('');
  const [notes, setNotes] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  const detail = useResource<Detail>(`admin:user:${userId}`, () =>
    adminApi().get(`api/admin/v1/users/${userId}`, adminUserDetailSchema),
  );
  const transactions = useResource(`admin:user:${userId}:transactions`, () =>
    adminApi().get(`api/admin/v1/users/${userId}/transactions`, adminTransactionListSchema),
  );
  const invoices = useResource(`admin:user:${userId}:invoices`, () =>
    adminApi().get(`api/admin/v1/users/${userId}/invoices`, adminInvoiceListSchema),
  );
  const audit = useResource(`admin:user:${userId}:audit`, () =>
    adminApi().get(`api/admin/v1/users/${userId}/audit`, adminAuditListSchema),
  );

  const run = useCallback(
    (path: string, body: unknown, method: 'POST' | 'PATCH' = 'POST', key?: string) => {
      setPending(true);
      adminApi()
        .send(
          method,
          `api/admin/v1/users/${userId}/${path}`,
          z.unknown(),
          body,
          key ? { headers: { 'idempotency-key': key } } : undefined,
        )
        .then(
          () => {
            setAction(null);
            invalidate(`admin:user:${userId}`);
            toast({ title: t('saved') });
          },
          (error: unknown) => {
            toast({
              title: t('errorTitle'),
              description: message(errorCode(error)),
              variant: 'danger',
            });
          },
        )
        .finally(() => {
          setPending(false);
        });
    },
    [message, t, toast, userId],
  );

  const can = (me: AdminMe, permission: Permission) =>
    allPermissions.includes(permission) && me.permissions.includes(permission);

  return (
    <AdminShell>
      {(me) => (
        <section className="flex flex-col gap-6">
          <AdminSection refresh={detail.refresh} state={detail.state}>
            {(data) => (
              <>
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h1 className="text-2xl font-bold">
                    {data.user.firstName ?? data.user.username ?? data.user.telegramId}
                  </h1>
                  <div className="flex items-center gap-2">
                    {data.user.isBanned ? (
                      <Badge variant="danger">{t('users.banned')}</Badge>
                    ) : null}
                    {can(me, 'support.read') ? (
                      <a
                        className="text-sm underline"
                        href={`/admin/support?userId=${encodeURIComponent(userId)}`}
                      >
                        {t('helpdesk.userTickets')}
                      </a>
                    ) : null}
                  </div>
                </div>

                <Tabs defaultValue="profile">
                  <TabsList>
                    <TabsTrigger value="profile">{t('users.profile')}</TabsTrigger>
                    <TabsTrigger value="subscription">{t('users.subscription')}</TabsTrigger>
                    <TabsTrigger value="payments">{t('users.payments')}</TabsTrigger>
                    <TabsTrigger value="audit">{t('users.audit')}</TabsTrigger>
                  </TabsList>

                  <TabsContent value="profile">
                    <Card>
                      <CardHeader>
                        <CardTitle>{t('users.profile')}</CardTitle>
                      </CardHeader>
                      <CardContent className="flex flex-col gap-4">
                        <dl className="grid gap-3 sm:grid-cols-3">
                          <Item label={t('users.telegramId')} value={data.user.telegramId} />
                          <Item label={t('users.username')} value={data.user.username ?? '—'} />
                          <Item
                            label={t('users.balance')}
                            value={money(data.balance.amountMinor, data.balance.currency, 'ru')}
                          />
                          <Item
                            label={t('users.createdAt')}
                            value={new Date(data.user.createdAt).toLocaleString('ru')}
                          />
                          <Item label="Email" value={data.user.email ?? '—'} />
                          <Item label={t('users.referrals')} value={data.counts.referrals} />
                        </dl>
                        <div className="flex flex-col gap-2">
                          <Label htmlFor="notes">{t('users.notes')}</Label>
                          <Input
                            id="notes"
                            value={notes ?? data.user.notes ?? ''}
                            onChange={(event) => {
                              setNotes(event.target.value);
                            }}
                          />
                          <div>
                            <Button
                              disabled={pending || !can(me, 'users.mutate')}
                              size="sm"
                              variant="secondary"
                              onClick={() => {
                                run('notes', { notes: notes ?? '' }, 'PATCH');
                              }}
                            >
                              {t('users.saveNotes')}
                            </Button>
                          </div>
                        </div>
                      </CardContent>
                    </Card>
                  </TabsContent>

                  <TabsContent value="subscription">
                    <Card>
                      <CardHeader>
                        <CardTitle>{t('users.subscription')}</CardTitle>
                      </CardHeader>
                      <CardContent>
                        {data.subscription ? (
                          <dl className="grid gap-3 sm:grid-cols-3">
                            <Item label={t('users.status')} value={data.subscription.status} />
                            <Item
                              label={t('users.expiresAt')}
                              value={new Date(data.subscription.expiresAt).toLocaleString('ru')}
                            />
                            <Item label="source" value={data.subscription.source} />
                            {data.panel ? (
                              <>
                                <Item label={t('users.panel')} value={data.panel.panelUsername} />
                                <Item
                                  label={t('users.traffic')}
                                  value={bytes(data.panel.usedTrafficBytes)}
                                />
                                <Item label="status" value={data.panel.status} />
                              </>
                            ) : null}
                          </dl>
                        ) : (
                          <p className="text-sm text-muted-foreground">{t('empty')}</p>
                        )}
                      </CardContent>
                    </Card>
                  </TabsContent>

                  <TabsContent value="payments">
                    <div className="flex flex-col gap-6">
                      <AdminSection refresh={transactions.refresh} state={transactions.state}>
                        {(rows) => (
                          <DataTable
                            columns={[
                              { key: 'type', header: t('payments.type'), cell: (row) => row.type },
                              {
                                key: 'amount',
                                header: t('payments.amount'),
                                cell: (row) =>
                                  money(row.amount.amountMinor, row.amount.currency, 'ru'),
                              },
                              {
                                key: 'reason',
                                header: t('reason'),
                                cell: (row) => row.reason ?? '—',
                              },
                              {
                                key: 'createdAt',
                                header: t('payments.createdAt'),
                                cell: (row) => new Date(row.createdAt).toLocaleString('ru'),
                              },
                            ]}
                            labels={{
                              loadMore: t('more'),
                              emptyTitle: t('empty'),
                              errorTitle: t('errorTitle'),
                            }}
                            rowKey={(row) => row.id}
                            rows={rows.items}
                          />
                        )}
                      </AdminSection>
                      <AdminSection refresh={invoices.refresh} state={invoices.state}>
                        {(rows) => (
                          <DataTable
                            columns={[
                              {
                                key: 'provider',
                                header: t('payments.provider'),
                                cell: (row) => row.provider,
                              },
                              {
                                key: 'status',
                                header: t('payments.status'),
                                cell: (row) => row.status,
                              },
                              {
                                key: 'amount',
                                header: t('payments.amount'),
                                cell: (row) =>
                                  money(row.amount.amountMinor, row.amount.currency, 'ru'),
                              },
                            ]}
                            labels={{
                              loadMore: t('more'),
                              emptyTitle: t('empty'),
                              errorTitle: t('errorTitle'),
                            }}
                            rowKey={(row) => row.id}
                            rows={rows.items}
                          />
                        )}
                      </AdminSection>
                    </div>
                  </TabsContent>

                  <TabsContent value="audit">
                    <AdminSection refresh={audit.refresh} state={audit.state}>
                      {(rows) => (
                        <DataTable
                          columns={[
                            { key: 'action', header: 'action', cell: (row) => row.action },
                            {
                              key: 'reason',
                              header: t('reason'),
                              cell: (row) => row.reason ?? '—',
                            },
                            {
                              key: 'diff',
                              header: 'before → after',
                              cell: (row) => (
                                <code className="text-xs">
                                  {JSON.stringify(row.before)} → {JSON.stringify(row.after)}
                                </code>
                              ),
                            },
                            {
                              key: 'createdAt',
                              header: t('payments.createdAt'),
                              cell: (row) => new Date(row.createdAt).toLocaleString('ru'),
                            },
                          ]}
                          labels={{
                            loadMore: t('more'),
                            emptyTitle: t('empty'),
                            errorTitle: t('errorTitle'),
                          }}
                          rowKey={(row) => row.id}
                          rows={rows.items}
                        />
                      )}
                    </AdminSection>
                  </TabsContent>
                </Tabs>

                <Card>
                  <CardHeader>
                    <CardTitle>{t('users.actions')}</CardTitle>
                  </CardHeader>
                  <CardContent className="flex flex-wrap gap-2">
                    <Button
                      disabled={!can(me, 'users.mutate')}
                      onClick={() => {
                        setAction({ kind: 'extend' });
                      }}
                    >
                      {t('users.extend')}
                    </Button>
                    <Button
                      disabled={!can(me, 'users.balance.credit')}
                      variant="secondary"
                      onClick={() => {
                        setAction({ kind: 'balance' });
                      }}
                    >
                      {t('users.credit')}
                    </Button>
                    <Button
                      disabled={!can(me, 'users.mutate')}
                      variant="secondary"
                      onClick={() => {
                        setAction({ kind: 'message' });
                      }}
                    >
                      {t('users.message')}
                    </Button>
                    <Button
                      disabled={pending || !can(me, 'users.mutate')}
                      variant="secondary"
                      onClick={() => {
                        run('revoke-link', {});
                      }}
                    >
                      {t('users.revokeLink')}
                    </Button>
                    <Button
                      disabled={pending || !can(me, 'users.mutate')}
                      variant="secondary"
                      onClick={() => {
                        run('reset-traffic', {});
                      }}
                    >
                      {t('users.resetTraffic')}
                    </Button>
                    <Button
                      disabled={!can(me, 'users.mutate')}
                      variant="danger"
                      onClick={() => {
                        setAction({ kind: data.user.isBanned ? 'unban' : 'ban' });
                      }}
                    >
                      {data.user.isBanned ? t('users.unban') : t('users.ban')}
                    </Button>
                    <Button
                      disabled={!can(me, 'users.anonymize') || Boolean(data.user.anonymizedAt)}
                      variant="danger"
                      onClick={() => {
                        setAction({ kind: 'anonymize' });
                      }}
                    >
                      {t('users.anonymize')}
                    </Button>
                  </CardContent>
                </Card>

                <ConfirmDialog
                  {...(action?.kind === 'anonymize'
                    ? { description: t('users.anonymizeWarning') }
                    : {})}
                  destructive={action?.kind === 'ban' || action?.kind === 'anonymize'}
                  labels={{
                    cancel: t('cancel'),
                    confirm: t('confirm'),
                    reasonLabel: t('reason'),
                    reasonRequired: t('reasonRequired'),
                  }}
                  onConfirm={(reason) => {
                    if (action?.kind === 'extend')
                      run('extend', { days, reason }, 'POST', idempotencyKey);
                    if (action?.kind === 'balance')
                      run(
                        'balance',
                        { amountMinor: Number(amountMinor ?? 0n), reason },
                        'POST',
                        idempotencyKey,
                      );
                    if (action?.kind === 'ban') run('ban', { reason });
                    if (action?.kind === 'unban') run('unban', { reason });
                    if (action?.kind === 'anonymize') run('anonymize', { reason });
                    if (action?.kind === 'message') run('message', { text });
                  }}
                  onOpenChange={(open) => {
                    if (!open) setAction(null);
                  }}
                  open={action !== null}
                  pending={pending}
                  requireReason={action?.kind !== 'message'}
                  title={t(`users.${action?.kind ?? 'extend'}`)}
                >
                  {action?.kind === 'extend' ? (
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="extend-days">{t('users.extendDays')}</Label>
                      <Input
                        id="extend-days"
                        max={3650}
                        min={1}
                        type="number"
                        value={days}
                        onChange={(event) => {
                          setDays(Number(event.target.value));
                        }}
                      />
                    </div>
                  ) : null}
                  {action?.kind === 'balance' ? (
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="balance-amount">{t('users.amount')}</Label>
                      <MoneyInput
                        id="balance-amount"
                        valueMinor={amountMinor}
                        onValueChange={setAmountMinor}
                      />
                    </div>
                  ) : null}
                  {action?.kind === 'message' ? (
                    <div className="flex flex-col gap-2">
                      <Label htmlFor="message-text">{t('users.messageText')}</Label>
                      <Input
                        id="message-text"
                        value={text}
                        onChange={(event) => {
                          setText(event.target.value);
                        }}
                      />
                    </div>
                  ) : null}
                </ConfirmDialog>
              </>
            )}
          </AdminSection>
        </section>
      )}
    </AdminShell>
  );
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="text-sm font-medium">{value}</dd>
    </div>
  );
}
