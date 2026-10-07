import { z } from 'zod';

import { serverApi } from './api';

const publicConfigLocaleSchema = z.object({
  locales: z.object({ default: z.string(), admin: z.string().optional() }),
});

/**
 * The administration interface language comes from `settings.admin.language`,
 * which the public config carries as `locales.admin` so the sign-in page uses
 * it too. An API that does not send it yet leaves the public default.
 */
export async function getAdminLanguage(): Promise<string> {
  try {
    const config = await serverApi().get('api/v1/public/config', publicConfigLocaleSchema, {
      next: { revalidate: 60, tags: ['config'] },
    });
    return config.locales.admin ?? config.locales.default;
  } catch {
    return 'ru';
  }
}
