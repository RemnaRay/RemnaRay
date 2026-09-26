import type { Metadata } from 'next';
import Image from 'next/image';
import { cookies } from 'next/headers';
import { getTranslations } from 'next-intl/server';

import { planListSchema, type PlanPublicView, userMeSchema } from '@remnaray/domain';
import { formatMoneyLocale } from '@remnaray/money';
import { Button, Card, CardContent, CardHeader, CardTitle } from '@remnaray/ui';

import { serverApi } from '../../lib/api';
import { getPublicConfig } from '../../lib/public-config';
import { getTheme } from '../../lib/theme';
import { routing, type Locale } from '../../i18n/routing';
import { Link } from '../../i18n/navigation';
import LoginDialog from './login-dialog';
import SiteFooter from './site-footer';

type PageProps = { params: Promise<{ locale: string }> };
type Feature = { title: string; text: string };
type Faq = { question: string; answer: string };

export function generateStaticParams() {
  return routing.locales.map((locale) => ({ locale }));
}

function normalizeLocale(value: string): Locale {
  return routing.locales.includes(value as Locale) ? (value as Locale) : routing.defaultLocale;
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { locale: value } = await params;
  const locale = normalizeLocale(value);
  const [t, config, theme] = await Promise.all([
    getTranslations({ locale, namespace: 'seo' }),
    getPublicConfig(),
    getTheme(),
  ]);
  const title = t('title', { brand: config.brand.name });
  const description = t('description');
  return {
    title,
    description,
    alternates: {
      canonical: `/${locale}`,
      languages: { ru: '/ru', en: '/en', 'x-default': `/${config.locales.default}` },
    },
    openGraph: {
      title,
      description,
      images: [theme.assets['og'] ?? '/themes/manta/og.png'],
    },
  };
}

export default async function LandingPage({ params }: PageProps) {
  const { locale: value } = await params;
  const locale = normalizeLocale(value);
  const [t, config, theme, plans, signedIn] = await Promise.all([
    getTranslations('landing'),
    getPublicConfig(),
    getTheme(),
    getPlans(),
    hasValidSession(),
  ]);
  const features = t.raw('features') as Feature[];
  const steps = t.raw('steps') as string[];
  const faq = t.raw('faq') as Faq[];
  const botLink = config.brand.botUsername ? `https://t.me/${config.brand.botUsername}` : null;
  const loginLabels = {
    trigger: t('hero.secondary'),
    title: t('login.title'),
    description: t('login.description'),
    button: t('login.button'),
    error: t('loginError'),
    unavailable: t('login.unavailable'),
  };

  return (
    <>
      <main>
        <section className="relative overflow-hidden px-6 py-20 sm:py-28">
          <div className="mx-auto grid max-w-6xl items-center gap-12 lg:grid-cols-[1.1fr_0.9fr]">
            <div>
              <p className="mb-4 text-sm font-semibold uppercase tracking-[0.2em] text-primary">
                {t('hero.eyebrow', { brand: config.brand.name })}
              </p>
              <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-6xl">
                {t('hero.title')}
              </h1>
              <p className="mt-6 max-w-2xl text-lg text-muted-foreground">
                {config.brand.slogan[locale] || t('hero.description')}
              </p>
              <div className="mt-8 flex flex-wrap gap-3">
                {botLink ? (
                  <Button asChild size="lg">
                    <a href={botLink} rel="noreferrer">
                      {t('hero.cta')}
                    </a>
                  </Button>
                ) : null}
                {signedIn ? (
                  <Button asChild size="lg" variant="secondary">
                    <Link href="/account">{t('account')}</Link>
                  </Button>
                ) : (
                  <LoginDialog
                    labels={loginLabels}
                    locale={locale}
                    openOnLoginQuery
                    size="lg"
                    variant="secondary"
                  />
                )}
              </div>
            </div>
            <div className="relative mx-auto w-full max-w-md overflow-hidden rounded-3xl border border-border bg-surface p-3 shadow-xl">
              {theme.landing.showMascot ? (
                <Image
                  alt={t('hero.imageAlt')}
                  className="h-auto w-full rounded-2xl"
                  height={630}
                  priority
                  src={theme.assets['og'] ?? '/themes/manta/og.png'}
                  width={1200}
                />
              ) : null}
            </div>
          </div>
        </section>

        <section aria-labelledby="features-heading" className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-3xl font-bold" id="features-heading">
            {t('featuresTitle')}
          </h2>
          <div className="mt-8 grid gap-4 md:grid-cols-3">
            {features.map((feature) => (
              <Card key={feature.title}>
                <CardHeader>
                  <CardTitle>{feature.title}</CardTitle>
                </CardHeader>
                <CardContent className="text-muted-foreground">{feature.text}</CardContent>
              </Card>
            ))}
          </div>
        </section>

        {plans.length > 0 ? (
          <section aria-labelledby="plans-heading" className="bg-surface px-6 py-16">
            <div className="mx-auto max-w-6xl">
              <h2 className="text-3xl font-bold" id="plans-heading">
                {t('plansTitle')}
              </h2>
              <div className="mt-8 grid gap-4 md:grid-cols-3">
                {plans.map((plan) => (
                  <Card key={plan.id}>
                    <CardHeader>
                      <CardTitle>{plan.name[locale] || plan.slug}</CardTitle>
                    </CardHeader>
                    <CardContent className="flex flex-col gap-2">
                      <p className="text-2xl font-bold">
                        {formatMoneyLocale(
                          { amountMinor: plan.price.amountMinor, currency: plan.price.currency },
                          locale,
                        )}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t('plans.days', { days: plan.durationDays })}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {plan.trafficLimitBytes === 0
                          ? t('plans.unlimited')
                          : t('plans.traffic', { traffic: formatBytes(plan.trafficLimitBytes) })}
                      </p>
                      <p className="text-sm text-muted-foreground">
                        {t('plans.devices', { count: plan.deviceLimit })}
                      </p>
                    </CardContent>
                  </Card>
                ))}
              </div>
            </div>
          </section>
        ) : null}

        <section aria-labelledby="steps-heading" className="mx-auto max-w-6xl px-6 py-16">
          <h2 className="text-3xl font-bold" id="steps-heading">
            {t('stepsTitle')}
          </h2>
          <ol className="mt-8 grid gap-4 md:grid-cols-3">
            {steps.map((step, index) => (
              <li className="rounded-lg border border-border bg-surface p-6" key={step}>
                <span className="text-sm font-semibold text-primary">
                  0{(index + 1).toString()}
                </span>
                <p className="mt-3 text-lg">{step}</p>
              </li>
            ))}
          </ol>
          {config.clients.length > 0 ? (
            <div className="mt-8">
              <h3 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">
                {t('clientsTitle')}
              </h3>
              <ul className="mt-3 flex flex-wrap gap-2">
                {config.clients.map((client) => (
                  <li
                    className="rounded-full border border-border px-3 py-1 text-sm"
                    key={client.id}
                  >
                    {client.name}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </section>

        <section aria-labelledby="faq-heading" className="mx-auto max-w-4xl px-6 py-16">
          <h2 className="text-3xl font-bold" id="faq-heading">
            {t('faqTitle')}
          </h2>
          <div className="mt-6 divide-y divide-border rounded-lg border border-border bg-surface">
            {faq.map((item) => (
              <details className="p-5" key={item.question}>
                <summary className="cursor-pointer font-semibold">{item.question}</summary>
                <p className="mt-3 text-muted-foreground">{item.answer}</p>
              </details>
            ))}
          </div>
        </section>

        <section aria-labelledby="cta-heading" className="mx-auto max-w-4xl px-6 pb-20">
          <div className="flex flex-col items-start gap-4 rounded-2xl border border-border bg-surface p-8">
            <h2 className="text-2xl font-bold" id="cta-heading">
              {t('ctaTitle')}
            </h2>
            <p className="text-muted-foreground">{t('ctaText')}</p>
            <div className="flex flex-wrap items-center gap-4">
              {botLink ? (
                <Button asChild>
                  <a href={botLink} rel="noreferrer">
                    {t('hero.cta')}
                  </a>
                </Button>
              ) : null}
              {signedIn ? (
                <Button asChild>
                  <Link href="/account">{t('account')}</Link>
                </Button>
              ) : (
                <LoginDialog labels={loginLabels} locale={locale} />
              )}
            </div>
          </div>
        </section>
      </main>
      <SiteFooter locale={locale} />
    </>
  );
}

/** The landing CTA reflects a server-validated session, never cookie presence alone. */
async function hasValidSession(): Promise<boolean> {
  const cookieHeader = (await cookies()).toString();
  if (!cookieHeader.split(';').some((value) => value.trim().startsWith('rr_sid='))) return false;
  try {
    await serverApi(cookieHeader).get('api/v1/me', userMeSchema, { cache: 'no-store' });
    return true;
  } catch {
    return false;
  }
}

function formatBytes(bytes: number): string {
  const gigabytes = bytes / 1024 ** 3;
  return gigabytes >= 1
    ? `${(Math.round(gigabytes * 10) / 10).toString()} GB`
    : `${Math.round(bytes / 1024 ** 2).toString()} MB`;
}

/** Section 13.2: the plans block is hidden when the list is empty or fails. */
async function getPlans(): Promise<PlanPublicView[]> {
  try {
    const result = await serverApi().get('api/v1/public/plans', planListSchema, {
      next: { revalidate: 60, tags: ['plans'] },
    });
    return result.items;
  } catch {
    return [];
  }
}
