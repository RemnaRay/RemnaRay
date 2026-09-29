'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  planListSchema,
  promocodePreviewSchema,
  subscriptionStateSchema,
  type PlanPublicView,
} from '@remnaray/domain';
import {
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  Input,
  Label,
  useToast,
} from '@remnaray/ui';

import { browserApi } from '../../../../lib/api';
import { bytes, money } from '../../../../lib/format';
import { useResource } from '../../../../lib/resource';
import { useRouter } from '../../../../i18n/navigation';
import type { Locale } from '../../../../i18n/routing';
import { AccountHeading } from '../account-chrome';
import { CheckoutPanel } from './checkout-panel';
import { Empty, ResourceSection, useErrorMessage } from '../states';

type Catalog = { plans: PlanPublicView[] };

export default function PlansClient({
  locale,
  change = false,
  initialPlanId,
}: {
  locale: Locale;
  change?: boolean;
  initialPlanId?: string | undefined;
}) {
  const t = useTranslations('account');
  const { toast } = useToast();
  const message = useErrorMessage();
  const router = useRouter();
  const [selectedId, setSelectedId] = useState(initialPlanId ?? '');
  const [promocode, setPromocode] = useState('');
  // The code the customer confirmed with «Применить»: the checkout quotes with it.
  const [applied, setApplied] = useState('');
  // Per plan: the discounted price, or the code the API refused it with.
  const [previews, setPreviews] = useState<
    Record<string, { discount: number; final: number } | { error: string }>
  >({});
  const [pending, setPending] = useState(false);

  const catalog = useResource<Catalog>(`me:plans:${change ? 'change' : 'buy'}`, async () => {
    const api = browserApi();
    const [plans, state] = await Promise.all([
      api.get('api/v1/public/plans', planListSchema),
      change ? api.get('api/v1/me/subscription', subscriptionStateSchema) : null,
    ]);
    // A plan change offers the other plans only (О-3).
    const currentId = state?.subscription?.plan?.id;
    return { plans: plans.items.filter((plan) => plan.id !== currentId) };
  });

  /**
   * Section 15.5 preview is per plan; one «Применить» next to the field asks
   * it for every plan at once, and each card shows its own answer.
   */
  const applyPromocode = useCallback(
    (planIds: string[]) => {
      setPending(true);
      const api = browserApi();
      void Promise.allSettled(
        planIds.map((planId) =>
          api.send('POST', 'api/v1/me/promocodes/preview', promocodePreviewSchema, {
            code: promocode,
            planId,
          }),
        ),
      )
        .then((results) => {
          const next: typeof previews = {};
          results.forEach((result, index) => {
            const planId = planIds[index];
            if (!planId) return;
            next[planId] =
              result.status === 'fulfilled'
                ? { discount: result.value.discountMinor, final: result.value.finalMinor }
                : { error: codeOf(result.reason) };
          });
          setPreviews(next);
          const rejected = results.filter((result) => result.status === 'rejected');
          if (rejected.length === results.length && rejected[0])
            toast({
              title: t('errorTitle'),
              description: message(codeOf(rejected[0].reason)),
              variant: 'danger',
            });
        })
        .finally(() => {
          setPending(false);
        });
    },
    [message, promocode, t, toast],
  );

  return (
    <section>
      <AccountHeading
        description={t(change ? 'plans.changeDescription' : 'plans.description')}
        title={t(change ? 'plans.changeTitle' : 'plans.title')}
      />
      <ResourceSection
        empty={<Empty description={t('plans.emptyDescription')} title={t('plans.emptyTitle')} />}
        isEmpty={(data) => data.plans.length === 0}
        refresh={catalog.refresh}
        state={catalog.state}
      >
        {(data) => {
          return (
            <div className="flex flex-col gap-6">
              <div className="flex flex-wrap items-end gap-3">
                <div className="flex flex-col gap-1">
                  <Label htmlFor="promocode">{t('plans.promocode')}</Label>
                  <Input
                    autoComplete="off"
                    id="promocode"
                    value={promocode}
                    onChange={(event) => {
                      setPromocode(event.target.value.toUpperCase());
                      setPreviews({});
                      setApplied('');
                    }}
                  />
                </div>
                <Button
                  disabled={pending || !promocode.trim()}
                  variant="secondary"
                  onClick={() => {
                    setApplied(promocode);
                    applyPromocode(data.plans.map((plan) => plan.id));
                  }}
                >
                  {t('plans.promocodeApply')}
                </Button>
              </div>

              <div className="grid gap-4 md:grid-cols-3">
                {data.plans.map((plan) => (
                  <Card key={plan.id}>
                    <CardHeader>
                      <CardTitle>{plan.name[locale] || plan.slug}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2">
                      <p className="text-2xl font-bold">
                        {money(plan.price.amountMinor, plan.price.currency, locale)}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t('plans.days', { days: plan.durationDays })}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {plan.trafficLimitBytes === 0
                          ? t('plans.unlimited')
                          : t('plans.traffic', { traffic: bytes(plan.trafficLimitBytes) })}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t('plans.devices', { count: plan.deviceLimit })}
                      </p>
                      {(() => {
                        const preview = previews[plan.id];
                        if (!preview) return null;
                        return 'error' in preview ? (
                          <p className="text-sm text-muted-foreground">{message(preview.error)}</p>
                        ) : (
                          <p className="text-sm font-medium text-success">
                            {t('plans.promocodeResult', {
                              discount: money(preview.discount, plan.price.currency, locale),
                              final: money(preview.final, plan.price.currency, locale),
                            })}
                          </p>
                        );
                      })()}
                      {selectedId === plan.id ? (
                        <CheckoutPanel
                          kind={change ? 'plan_change' : 'purchase'}
                          locale={locale}
                          planId={plan.id}
                          promocode={applied}
                          onBought={() => {
                            router.push('/account');
                          }}
                        />
                      ) : (
                        <div className="mt-2 flex flex-wrap gap-2">
                          <Button
                            onClick={() => {
                              setSelectedId(plan.id);
                            }}
                          >
                            {t('plans.select')}
                          </Button>
                        </div>
                      )}
                    </CardContent>
                  </Card>
                ))}
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
