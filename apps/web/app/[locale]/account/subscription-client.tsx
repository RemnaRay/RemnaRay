'use client';

import { useCallback, useState } from 'react';
import { useTranslations } from 'next-intl';

import {
  revokeResultSchema,
  subscriptionStateSchema,
  trialResultSchema,
  userMeSchema,
  type SubscriptionStateView,
  type UserMeView,
} from '@remnaray/domain';
import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  ConfirmDialog,
  useToast,
} from '@remnaray/ui';

import { browserApi } from '../../../lib/api';
import { bytes } from '../../../lib/format';
import { invalidate, useResource } from '../../../lib/resource';
import { Link } from '../../../i18n/navigation';
import type { Locale } from '../../../i18n/routing';
import { AccountHeading, Field } from './account-chrome';
import { Empty, ResourceSection, useErrorMessage } from './states';

const STATUS_LABEL: Record<string, string> = {
  active: 'subscription.statusActive',
  provisioning: 'subscription.statusProvisioning',
  grace: 'subscription.statusGrace',
  expired: 'subscription.statusExpired',
  canceled: 'subscription.statusCanceled',
};

export default function SubscriptionClient({ locale }: { locale: Locale }) {
  const t = useTranslations('account');
  const common = useTranslations('common');
  const { toast } = useToast();
  const message = useErrorMessage();
  const [confirmRevoke, setConfirmRevoke] = useState(false);
  const [pending, setPending] = useState(false);
  const [showQr, setShowQr] = useState(false);

  const profile = useResource<UserMeView>('me', () => browserApi().get('api/v1/me', userMeSchema));
  const subscription = useResource<SubscriptionStateView>('me:subscription', () =>
    browserApi().get('api/v1/me/subscription', subscriptionStateSchema),
  );

  const startTrial = useCallback(() => {
    setPending(true);
    browserApi()
      .send('POST', 'api/v1/me/trial', trialResultSchema)
      .then(
        () => {
          invalidate('me');
        },
        (error: unknown) => {
          toast({ title: t('errorTitle'), description: message(codeOf(error)), variant: 'danger' });
        },
      )
      .finally(() => {
        setPending(false);
      });
  }, [message, t, toast]);

  const revoke = useCallback(() => {
    setPending(true);
    browserApi()
      .send('POST', 'api/v1/me/subscription/revoke', revokeResultSchema)
      .then(
        () => {
          setConfirmRevoke(false);
          invalidate('me:subscription');
        },
        (error: unknown) => {
          toast({ title: t('errorTitle'), description: message(codeOf(error)), variant: 'danger' });
        },
      )
      .finally(() => {
        setPending(false);
      });
  }, [message, t, toast]);

  return (
    <section>
      <AccountHeading description={t('subscription.description')} title={t('subscription.title')} />
      <ResourceSection
        empty={
          <Empty
            action={
              <div className="flex flex-wrap gap-2">
                {profile.state.status === 'ready' && profile.state.data.trialAvailable ? (
                  <Button disabled={pending} onClick={startTrial}>
                    {t('subscription.tryFree')}
                  </Button>
                ) : null}
                <Button asChild variant="secondary">
                  <Link href="/account/plans">{t('subscription.choosePlan')}</Link>
                </Button>
              </div>
            }
            description={t('subscription.emptyDescription')}
            title={t('subscription.emptyTitle')}
          />
        }
        isEmpty={(data) => data.subscription === null}
        refresh={subscription.refresh}
        state={subscription.state}
      >
        {(data) => (
          <div className="flex flex-col gap-6">
            <Card>
              <CardHeader className="flex-row items-center justify-between gap-3">
                <CardTitle>{t('subscription.title')}</CardTitle>
                <Badge variant={data.subscription?.status === 'active' ? 'success' : 'secondary'}>
                  {t(STATUS_LABEL[data.subscription?.status ?? ''] ?? 'subscription.statusExpired')}
                </Badge>
              </CardHeader>
              <CardContent>
                <dl className="grid gap-4 sm:grid-cols-3">
                  <Field
                    label={t('subscription.expiresAt')}
                    value={new Date(data.subscription?.expiresAt ?? '').toLocaleDateString(locale)}
                  />
                  <Field
                    label={t('subscription.status')}
                    value={t('subscription.daysLeft', { days: data.subscription?.daysLeft ?? 0 })}
                  />
                  <Field
                    label={t('subscription.traffic')}
                    value={
                      data.panel && data.panel.trafficLimitBytes > 0
                        ? t('subscription.trafficUsed', {
                            used: bytes(data.panel.usedTrafficBytes),
                            limit: bytes(data.panel.trafficLimitBytes),
                          })
                        : t('subscription.trafficUnlimited')
                    }
                  />
                </dl>
              </CardContent>
            </Card>

            {data.panel ? (
              <Card>
                <CardHeader>
                  <CardTitle>{t('subscription.link')}</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-4">
                  <p className="break-all rounded-md border border-border bg-background p-3 font-mono text-sm">
                    {data.panel.subscriptionUrl}
                  </p>
                  <p className="text-sm text-muted-foreground">{t('subscription.instructions')}</p>
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      onClick={() => {
                        void navigator.clipboard
                          .writeText(data.panel?.subscriptionUrl ?? '')
                          .then(() => {
                            toast({ title: common('copied') });
                          });
                      }}
                    >
                      {t('subscription.copy')}
                    </Button>
                    <Button
                      variant="secondary"
                      onClick={() => {
                        setShowQr((current) => !current);
                      }}
                    >
                      {t('subscription.qr')}
                    </Button>
                    <Button
                      disabled={pending || !data.subscription?.canRevoke}
                      variant="danger"
                      onClick={() => {
                        setConfirmRevoke(true);
                      }}
                    >
                      {t('subscription.revoke')}
                    </Button>
                  </div>
                  {showQr ? (
                    <img
                      alt={t('subscription.qrAlt')}
                      className="size-64 rounded-md border border-border bg-white p-2"
                      height={256}
                      src="/api/v1/me/subscription/qr"
                      width={256}
                    />
                  ) : null}
                  {data.clients.length > 0 ? (
                    <div>
                      <h3 className="text-sm font-semibold">{t('subscription.clients')}</h3>
                      <ul className="mt-2 flex flex-wrap gap-2">
                        {data.clients.map((client) => (
                          <li key={client.id}>
                            <Button asChild size="sm" variant="secondary">
                              <a href={client.deepLink ?? '#'} rel="noreferrer">
                                {client.name}
                              </a>
                            </Button>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ) : null}
                </CardContent>
              </Card>
            ) : (
              <p className="text-sm text-muted-foreground">{t('subscription.noPanel')}</p>
            )}

            <div className="flex flex-wrap gap-2">
              <Button asChild>
                <Link href="/account/plans">{t('subscription.renew')}</Link>
              </Button>
              {data.subscription?.canChangePlan ? (
                <Button asChild variant="secondary">
                  <Link href="/account/plans?change=1">{t('subscription.changePlan')}</Link>
                </Button>
              ) : null}
            </div>
          </div>
        )}
      </ResourceSection>

      <ConfirmDialog
        description={t('subscription.revokeDescription')}
        destructive
        labels={{
          cancel: common('cancel'),
          confirm: common('confirm'),
          reasonLabel: '',
        }}
        onConfirm={revoke}
        onOpenChange={setConfirmRevoke}
        open={confirmRevoke}
        pending={pending}
        title={t('subscription.revokeTitle')}
      />
    </section>
  );
}

function codeOf(error: unknown): string {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String(error.code)
    : 'INTERNAL_ERROR';
}
