'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  invoiceSchema,
  paymentMethodsSchema,
  topupConfigSchema,
  transactionsSchema,
  userMeSchema,
  type PaymentMethodsView,
  type TransactionsView,
  type UserMeView,
} from '@remnaray/domain';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  Label,
  MoneyInput,
  Stat,
  useToast,
} from '@remnaray/ui';

import { browserApi } from '../../../../lib/api';
import { money } from '../../../../lib/format';
import { invalidate, useResource } from '../../../../lib/resource';
import { useRouter } from '../../../../i18n/navigation';
import type { Locale } from '../../../../i18n/routing';
import { AccountHeading } from '../account-chrome';
import { ResourceSection, useErrorMessage } from '../states';

type BalanceData = {
  profile: UserMeView;
  config: { presetsMinor: number[]; minMinor: number; maxMinor: number };
  methods: PaymentMethodsView;
  transactions: TransactionsView;
};

export default function BalanceClient({ locale }: { locale: Locale }) {
  const t = useTranslations('account');
  const common = useTranslations('common');
  const { toast } = useToast();
  const message = useErrorMessage();
  const router = useRouter();
  const [custom, setCustom] = useState<bigint | null>(null);
  const [chosen, setChosen] = useState('');
  const [pending, setPending] = useState(false);
  const [extra, setExtra] = useState<TransactionsView['items']>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [cursorLoaded, setCursorLoaded] = useState(false);

  const resource = useResource<BalanceData>('me:balance', async () => {
    const api = browserApi();
    const [profile, config, methods, transactions] = await Promise.all([
      api.get('api/v1/me', userMeSchema),
      api.get('api/v1/me/topup-config', topupConfigSchema),
      api.get('api/v1/me/payment-methods', paymentMethodsSchema),
      api.get('api/v1/me/transactions', transactionsSchema, { query: { limit: 20 } }),
    ]);
    return { profile, config, methods, transactions };
  });

  const topUp = useCallback(
    (amountMinor: number, provider: string) => {
      setPending(true);
      browserApi()
        .send(
          'POST',
          'api/v1/me/invoices',
          invoiceSchema,
          { kind: 'topup', provider, amountMinor },
          { headers: { 'idempotency-key': crypto.randomUUID() } },
        )
        .then(
          (invoice) => {
            invalidate('me');
            router.push(`/pay/${invoice.id}`);
          },
          (error: unknown) => {
            toast({
              title: t('errorTitle'),
              description: message(codeOf(error)),
              variant: 'danger',
            });
          },
        )
        .finally(() => {
          setPending(false);
        });
    },
    [message, router, t, toast],
  );

  const loadMore = useCallback((next: string) => {
    setPending(true);
    void browserApi()
      .get('api/v1/me/transactions', transactionsSchema, { query: { limit: 20, cursor: next } })
      .then((page) => {
        setExtra((current) => [...current, ...page.items]);
        setCursor(page.nextCursor);
        setCursorLoaded(true);
      })
      .catch(() => undefined)
      .finally(() => {
        setPending(false);
      });
  }, []);

  return (
    <section>
      <AccountHeading description={t('balance.description')} title={t('balance.title')} />
      <ResourceSection refresh={resource.refresh} state={resource.state}>
        {(data) => {
          // FR-071: a top-up is paid through a provider, never from the balance.
          const methods = data.methods.items.filter((item) => item.kind !== 'balance');
          const provider =
            methods.find((item) => item.available && item.code === chosen)?.code ??
            methods.find((item) => item.available)?.code ??
            '';
          const rows = [...data.transactions.items, ...extra];
          const nextCursor = cursorLoaded ? cursor : data.transactions.nextCursor;
          return (
            <div className="flex flex-col gap-6">
              <Stat
                label={t('balance.current')}
                value={money(
                  data.profile.balance.amountMinor,
                  data.profile.balance.currency,
                  locale,
                )}
                // Section 15.2: held referral rewards are shown as pending.
                hint={
                  data.profile.balanceHeld.amountMinor > 0
                    ? t('balance.held', {
                        amount: money(
                          data.profile.balanceHeld.amountMinor,
                          data.profile.balanceHeld.currency,
                          locale,
                        ),
                      })
                    : undefined
                }
              />

              <Card>
                <CardHeader>
                  <CardTitle>{t('balance.topUp')}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  {methods.length > 0 ? (
                    <fieldset className="flex flex-col gap-3">
                      <legend className="text-sm font-semibold">{t('plans.provider')}</legend>
                      <div className="flex flex-wrap gap-3">
                        {methods.map((method) => (
                          <label className="flex items-center gap-2 text-sm" key={method.code}>
                            <input
                              checked={provider === method.code}
                              disabled={!method.available}
                              name="topup-provider"
                              type="radio"
                              value={method.code}
                              onChange={() => {
                                setChosen(method.code);
                              }}
                            />
                            <span>{method.displayName[locale]}</span>
                          </label>
                        ))}
                      </div>
                    </fieldset>
                  ) : null}
                  <div className="flex flex-wrap gap-2">
                    {data.config.presetsMinor.map((amount) => (
                      <Button
                        disabled={pending || !provider}
                        key={amount}
                        variant="secondary"
                        onClick={() => {
                          topUp(amount, provider);
                        }}
                      >
                        {money(amount, data.profile.balance.currency, locale)}
                      </Button>
                    ))}
                  </div>
                  <div className="flex flex-wrap items-end gap-3">
                    <div className="flex w-48 flex-col gap-1">
                      <Label htmlFor="custom-amount">{t('balance.customAmount')}</Label>
                      <MoneyInput
                        currency={data.profile.balance.currency}
                        id="custom-amount"
                        valueMinor={custom}
                        onValueChange={setCustom}
                      />
                    </div>
                    <Button
                      disabled={
                        pending ||
                        !provider ||
                        custom === null ||
                        custom < BigInt(data.config.minMinor) ||
                        custom > BigInt(data.config.maxMinor)
                      }
                      onClick={() => {
                        if (custom !== null) topUp(Number(custom), provider);
                      }}
                    >
                      {t('balance.topUp')}
                    </Button>
                  </div>
                  <p className="text-xs text-muted-foreground">
                    {t('balance.range', {
                      min: money(data.config.minMinor, data.profile.balance.currency, locale),
                      max: money(data.config.maxMinor, data.profile.balance.currency, locale),
                    })}
                  </p>
                </CardContent>
              </Card>

              <div>
                <h2 className="mb-3 text-lg font-semibold">{t('balance.history')}</h2>
                <DataTable
                  columns={[
                    {
                      key: 'type',
                      header: t('balance.history'),
                      cell: (row) =>
                        t.has(`balance.type.${row.type}`)
                          ? t(`balance.type.${row.type}`)
                          : row.type,
                    },
                    {
                      key: 'invoiceNumber',
                      header: t('balance.number'),
                      cell: (row) => row.invoiceNumber ?? '—',
                    },
                    {
                      key: 'amount',
                      header: t('balance.amount'),
                      cell: (row) => money(row.amount.amountMinor, row.amount.currency, locale),
                    },
                    {
                      key: 'createdAt',
                      header: t('devices.added'),
                      cell: (row) => new Date(row.createdAt).toLocaleString(locale),
                    },
                  ]}
                  labels={{
                    loadMore: common('more'),
                    emptyTitle: t('balance.emptyTitle'),
                    emptyDescription: t('balance.emptyDescription'),
                    errorTitle: t('errorTitle'),
                  }}
                  loadingMore={pending}
                  nextCursor={nextCursor}
                  rowKey={(row) => row.id}
                  rows={rows}
                  onLoadMore={() => {
                    if (nextCursor) loadMore(nextCursor);
                  }}
                />
              </div>
            </div>
          );
        }}
      </ResourceSection>
    </section>
  );
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'INTERNAL_ERROR';
}
