import type { Metadata } from 'next';
import { getTranslations } from 'next-intl/server';

import type { Locale } from '../../../../i18n/routing';
import { getPublicConfig } from '../../../../lib/public-config';
import BotSignIn from './bot-sign-in';

type Props = { params: Promise<{ locale: string }> };

export async function generateMetadata(): Promise<Metadata> {
  const [t, config] = await Promise.all([getTranslations('seo'), getPublicConfig()]);
  return {
    title: t('botSignInTitle', { brand: config.brand.name }),
    robots: { index: false, follow: false },
  };
}

/**
 * Where the bot's «Open account» link lands (section 13.3, via `/auth/tg`):
 * the account it opens is named and the visitor confirms (L-3).
 */
export default async function BotSignInPage({ params }: Props) {
  const { locale } = await params;
  return (
    <div className="mx-auto w-full max-w-md px-6 py-12">
      <BotSignIn locale={locale as Locale} />
    </div>
  );
}
