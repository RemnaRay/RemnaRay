'use client';

import { useCallback, useMemo, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  checkoutQuoteSchema,
  invoiceSchema,
  paymentMethodsSchema,
  type CheckoutQuoteView,
  type PaymentMethodsView,
} from '@remnaray/domain';
import { Button, useToast } from '@remnaray/ui';

import { browserApi } from '../../../../lib/api';
import { money } from '../../../../lib/format';
import { invalidate, useResource } from '../../../../lib/resource';
import { useRouter } from '../../../../i18n/navigation';
import type { Locale } from '../../../../i18n/routing';
import { ResourceSection, useErrorMessage } from '../states';

type Props = {
  locale: Locale;
  planId: string;
  kind: 'purchase' | 'plan_change';
  promocode: string;
  onBought: () => void;
};

/**
 * F37 (ADR-021): a plan is bought from the balance. The panel quotes it and
 * offers «Купить с баланса» when the balance covers it, or a top-up of the
 * shortage through the provider the customer picks.
 */
export function CheckoutPanel({ locale, planId, kind, promocode, onBought }: Props) {
  const t = useTranslations('account');
  const { toast } = useToast();
  const message = useErrorMessage();
  const router = useRouter();
  const [chosen, setChosen] = useState('');
  const [pending, setPending] = useState(false);
  const key = `me:checkout:${planId}:${kind}:${promocode}`;
  const resource = useResource<{ quote: CheckoutQuoteView; methods: PaymentMethodsView }>(
    key,
    async () => {
      const api = browserApi();
      const [quote, methods] = await Promise.all([
        api.get('api/v1/me/checkout/quote', checkoutQuoteSchema, {
          query: { planId, kind, ...(promocode ? { promocode } : {}) },
        }),
        api.get('api/v1/me/payment-methods', paymentMethodsSchema),
      ]);
      return { quote, methods };
    },
  );
  // One key per quote shown: a double click buys once; a new quote is a new request.
  const quoted = resource.state.status === 'ready' ? resource.state.data.quote : null;
  const quotedToPay = quoted?.toPayMinor;
  const quotedAvailable = quoted?.availableMinor;
  // A code the quote refused is not sent with the purchase: the server would
  // refuse the whole purchase, and the customer could not buy at all.
  const buyPromocode = quoted?.promocode?.applied ? promocode : '';
  const buyKey = useMemo(
    () => (quotedToPay === undefined ? '' : crypto.randomUUID()),
    // The body follows planId, kind and promocode: a changed input is a new key.
    [quotedToPay, quotedAvailable, planId, kind, promocode],
  );

  const fail = useCallback(
    (error: unknown) => {
      invalidate(key);
      toast({ title: t('errorTitle'), description: message(codeOf(error)), variant: 'danger' });
    },
    [key, message, t, toast],
  );

  const buy = useCallback(() => {
    setPending(true);
    browserApi()
      .send(
        'POST',
        'api/v1/me/invoices',
        invoiceSchema,
        { kind, planId, ...(buyPromocode ? { promocode: buyPromocode } : {}) },
        { headers: { 'idempotency-key': buyKey } },
      )
      .then(() => {
        invalidate('me');
        onBought();
      }, fail)
      .finally(() => {
        setPending(false);
      });
  }, [buyKey, buyPromocode, fail, kind, onBought, planId]);

  const topUp = useCallback(
    (provider: string) => {
      setPending(true);
      browserApi()
        .send(
          'POST',
          'api/v1/me/invoices',
          invoiceSchema,
          {
            kind: 'topup',
            provider,
            forPlan: { planId, kind, ...(promocode ? { promocode } : {}) },
          },
          { headers: { 'idempotency-key': crypto.randomUUID() } },
        )
        .then((invoice) => {
          router.push(`/pay/${invoice.id}`);
        }, fail)
        .finally(() => {
          setPending(false);
        });
    },
    [fail, kind, planId, promocode, router],
  );

  return (
    <ResourceSection refresh={resource.refresh} state={resource.state}>
      {({ quote, methods }) => {
        const provider = quote.topups.find((item) => item.provider === chosen) ?? quote.topups[0];
        return (
          <div className="flex flex-col gap-3" data-testid="checkout">
            {kind === 'plan_change' ? (
              <p className="text-sm text-muted-foreground">
                {t('checkout.credit', { credit: money(quote.creditMinor, 'RUB', locale) })}
              </p>
            ) : null}
            <p className="text-sm">
              {t('checkout.balance', { balance: money(quote.availableMinor, 'RUB', locale) })}
            </p>
            {quote.promocode && !quote.promocode.applied ? (
              <p className="text-sm text-muted-foreground">
                {message(quote.promocode.error ?? 'PROMO_NOT_FOUND')}
              </p>
            ) : null}
            {quote.missingMinor === 0 ? (
              <Button disabled={pending} onClick={buy}>
                {t(kind === 'plan_change' ? 'checkout.change' : 'checkout.buy', {
                  price: money(quote.toPayMinor, 'RUB', locale),
                })}
              </Button>
            ) : (
              <>
                <p className="text-sm font-medium">
                  {t('checkout.short', { missing: money(quote.missingMinor, 'RUB', locale) })}
                </p>
                <fieldset className="flex flex-col gap-2">
                  <legend className="text-sm font-semibold">{t('plans.provider')}</legend>
                  {quote.topups.map((item) => (
                    <label className="flex items-center gap-2 text-sm" key={item.provider}>
                      <input
                        checked={provider?.provider === item.provider}
                        name="provider"
                        type="radio"
                        value={item.provider}
                        onChange={() => {
                          setChosen(item.provider);
                        }}
                      />
                      <span>
                        {methods.items.find((method) => method.code === item.provider)?.displayName[
                          locale
                        ] ?? item.provider}
                        {' — '}
                        {money(item.amountMinor, 'RUB', locale)}
                      </span>
                    </label>
                  ))}
                </fieldset>
                <Button
                  disabled={pending || !provider}
                  onClick={() => {
                    if (provider) topUp(provider.provider);
                  }}
                >
                  {t('checkout.topUp', {
                    amount: money(provider?.amountMinor ?? 0, 'RUB', locale),
                  })}
                </Button>
                <p className="text-xs text-muted-foreground">{t('checkout.secondStep')}</p>
              </>
            )}
          </div>
        );
      }}
    </ResourceSection>
  );
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'INTERNAL_ERROR';
}
