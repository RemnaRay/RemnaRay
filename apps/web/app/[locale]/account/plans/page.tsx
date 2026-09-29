import { routing, type Locale } from '../../../../i18n/routing';
import PlansClient from './plans-client';

export default async function AccountPlansPage({
  params,
  searchParams,
}: {
  params: Promise<{ locale: string }>;
  searchParams: Promise<{ change?: string; plan?: string }>;
}) {
  const { locale: value } = await params;
  const query = await searchParams;
  const locale = routing.locales.includes(value as Locale)
    ? (value as Locale)
    : routing.defaultLocale;
  return <PlansClient change={query.change === '1'} initialPlanId={query.plan} locale={locale} />;
}
