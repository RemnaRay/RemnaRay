'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';
import { z } from 'zod';

import { permissions as allPermissions } from '@remnaray/domain';
import {
  Badge,
  Button,
  ConfirmDialog,
  DataTable,
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  MoneyInput,
  Tabs,
  TabsContent,
  TabsList,
  TabsTrigger,
  useToast,
} from '@remnaray/ui';

import { adminApi, errorCode } from '../../../lib/admin-client';
import {
  adminInvoiceDetailSchema,
  adminInvoiceListSchema,
  adminTransactionListSchema,
} from '../../../lib/admin-contracts';
import { money } from '../../../lib/format';
import { invalidate, useResource } from '../../../lib/resource';
import { AdminShell } from '../admin-shell';
import { AdminSection, useAdminErrorMessage } from '../admin-states';
import { invoiceStatusLabel, providerLabel, refundableMinor, transactionTypeLabel } from './labels';

type Invoices = z.infer<typeof adminInvoiceListSchema>;
type Transactions = z.infer<typeof adminTransactionListSchema>;
type InvoiceDetail = z.infer<typeof adminInvoiceDetailSchema>;

export default function PaymentsClient() {
  const t = useTranslations('admin');
  const { toast } = useToast();
  const message = useAdminErrorMessage();
  const [openInvoice, setOpenInvoice] = useState<InvoiceDetail | null>(null);
  const [refundTarget, setRefundTarget] = useState<string | null>(null);
  const [refundAmount, setRefundAmount] = useState<bigint | null>(null);
  // Section 9.1: one key per opened refund, kept while its dialog is open.
  const refundKey = useMemo(() => (refundTarget ? crypto.randomUUID() : ''), [refundTarget]);
  const [pending, setPending] = useState(false);

  const invoices = useResource<Invoices>('admin:invoices', () =>
    adminApi().get('api/admin/v1/invoices', adminInvoiceListSchema, { query: { limit: 50 } }),
  );
  const transactions = useResource<Transactions>('admin:transactions', () =>
    adminApi().get('api/admin/v1/transactions', adminTransactionListSchema, {
      query: { limit: 50 },
    }),
  );

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

  const showInvoice = useCallback(
    (id: string) => {
      adminApi()
        .get(`api/admin/v1/invoices/${id}`, adminInvoiceDetailSchema)
        .then(setOpenInvoice, fail);
    },
    [fail],
  );

  const recheck = useCallback(
    (id: string) => {
      setPending(true);
      adminApi()
        .send('POST', `api/admin/v1/invoices/${id}/recheck`, z.unknown())
        .then(() => {
          invalidate('admin:invoices');
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
        const canRefund =
          allPermissions.includes('payments.refund') && me.permissions.includes('payments.refund');
        const canRecheck =
          allPermissions.includes('payments.recheck') &&
          me.permissions.includes('payments.recheck');
        return (
          <section className="flex flex-col gap-6">
            <h1 className="text-2xl font-bold">{t('payments.title')}</h1>

            <Tabs defaultValue="invoices">
              <TabsList>
                <TabsTrigger value="invoices">{t('payments.invoices')}</TabsTrigger>
                <TabsTrigger value="transactions">{t('payments.transactions')}</TabsTrigger>
              </TabsList>

              <TabsContent value="invoices">
                <AdminSection refresh={invoices.refresh} state={invoices.state}>
                  {(data) => (
                    <DataTable
                      columns={[
                        {
                          key: 'provider',
                          header: t('payments.provider'),
                          cell: (row) => providerLabel(t, row.provider),
                        },
                        {
                          key: 'status',
                          header: t('payments.status'),
                          cell: (row) => (
                            <Badge variant={row.status === 'paid' ? 'success' : 'secondary'}>
                              {invoiceStatusLabel(t, row.status)}
                            </Badge>
                          ),
                        },
                        {
                          key: 'amount',
                          header: t('payments.amount'),
                          cell: (row) => money(row.amount.amountMinor, row.amount.currency, 'ru'),
                        },
                        {
                          key: 'createdAt',
                          header: t('payments.createdAt'),
                          cell: (row) => new Date(row.createdAt).toLocaleString('ru'),
                        },
                        {
                          key: 'actions',
                          header: '',
                          cell: (row) => (
                            <div className="flex gap-2">
                              <Button
                                size="sm"
                                variant="secondary"
                                onClick={() => {
                                  showInvoice(row.id);
                                }}
                              >
                                {t('users.open')}
                              </Button>
                              {canRecheck ? (
                                <Button
                                  disabled={pending}
                                  size="sm"
                                  variant="secondary"
                                  onClick={() => {
                                    recheck(row.id);
                                  }}
                                >
                                  {t('payments.recheck')}
                                </Button>
                              ) : null}
                            </div>
                          ),
                        },
                      ]}
                      labels={{
                        loadMore: t('more'),
                        emptyTitle: t('empty'),
                        errorTitle: t('errorTitle'),
                      }}
                      rowKey={(row) => row.id}
                      rows={data.items}
                    />
                  )}
                </AdminSection>
              </TabsContent>

              <TabsContent value="transactions">
                <AdminSection refresh={transactions.refresh} state={transactions.state}>
                  {(data) => (
                    <DataTable
                      columns={[
                        {
                          key: 'type',
                          header: t('payments.type'),
                          cell: (row) => transactionTypeLabel(t, row.type),
                        },
                        {
                          key: 'provider',
                          header: t('payments.provider'),
                          cell: (row) => providerLabel(t, row.provider),
                        },
                        {
                          key: 'amount',
                          header: t('payments.amount'),
                          cell: (row) => money(row.amount.amountMinor, row.amount.currency, 'ru'),
                        },
                        {
                          key: 'refunded',
                          header: t('payments.refunded'),
                          cell: (row) =>
                            row.refunded
                              ? money(row.refunded.amountMinor, row.refunded.currency, 'ru')
                              : '—',
                        },
                        {
                          key: 'createdAt',
                          header: t('payments.createdAt'),
                          cell: (row) => new Date(row.createdAt).toLocaleString('ru'),
                        },
                        {
                          key: 'actions',
                          header: '',
                          cell: (row) =>
                            canRefund && refundableMinor(row) > 0 ? (
                              <Button
                                size="sm"
                                variant="danger"
                                onClick={() => {
                                  setRefundTarget(row.id);
                                  setRefundAmount(BigInt(refundableMinor(row)));
                                }}
                              >
                                {t('payments.refund')}
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
                      rows={data.items}
                    />
                  )}
                </AdminSection>
              </TabsContent>
            </Tabs>

            <Dialog
              open={openInvoice !== null}
              onOpenChange={(open) => {
                if (!open) setOpenInvoice(null);
              }}
            >
              <DialogContent className="max-w-2xl">
                <DialogHeader>
                  <DialogTitle>{t('payments.events')}</DialogTitle>
                </DialogHeader>
                {openInvoice ? (
                  <div className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto">
                    {openInvoice.events.map((event) => (
                      <div className="rounded-md border border-border p-3" key={event.id}>
                        <p className="text-sm font-medium">
                          {event.type} · {t('payments.signatureOk')}:{' '}
                          {event.signatureOk ? 'ok' : 'fail'}
                        </p>
                        {event.processError ? (
                          <p className="text-xs text-danger">
                            {t('payments.processError')}: {event.processError}
                          </p>
                        ) : null}
                        <pre className="mt-2 overflow-x-auto text-xs">
                          {JSON.stringify(event.raw, null, 2)}
                        </pre>
                      </div>
                    ))}
                    {openInvoice.events.length === 0 ? (
                      <p className="text-sm text-muted-foreground">{t('empty')}</p>
                    ) : null}
                  </div>
                ) : null}
              </DialogContent>
            </Dialog>

            <ConfirmDialog
              destructive
              labels={{
                cancel: t('cancel'),
                confirm: t('confirm'),
                reasonLabel: t('reason'),
                reasonRequired: t('reasonRequired'),
              }}
              onConfirm={(reason) => {
                if (!refundTarget) return;
                setPending(true);
                adminApi()
                  .send(
                    'POST',
                    `api/admin/v1/transactions/${refundTarget}/refund`,
                    z.unknown(),
                    { amountMinor: Number(refundAmount ?? 0n), reason },
                    { headers: { 'idempotency-key': refundKey } },
                  )
                  .then(() => {
                    setRefundTarget(null);
                    invalidate('admin:transactions');
                    toast({ title: t('saved') });
                  }, fail)
                  .finally(() => {
                    setPending(false);
                  });
              }}
              onOpenChange={(open) => {
                if (!open) setRefundTarget(null);
              }}
              open={refundTarget !== null}
              pending={pending}
              requireReason
              title={t('payments.refund')}
            >
              <MoneyInput valueMinor={refundAmount} onValueChange={setRefundAmount} />
            </ConfirmDialog>
          </section>
        );
      }}
    </AdminShell>
  );
}
