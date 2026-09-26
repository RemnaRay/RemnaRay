'use client';

import { useEffect, useState, type ReactNode } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { usePathname, useRouter } from 'next/navigation';
import { z } from 'zod';

import { ApiError, permissions as allPermissions, type Permission } from '@remnaray/domain';
import { Button, cn } from '@remnaray/ui';

import { adminApi, setAdminCsrfToken } from '../../lib/admin-client';

const adminMeSchema = z.object({
  admin: z.object({
    id: z.string(),
    email: z.string(),
    role: z.string(),
    telegramId: z.string().nullable(),
    permissions: z.array(z.string()),
  }),
  csrfToken: z.string(),
});

export type AdminMe = z.infer<typeof adminMeSchema>['admin'];

const links: { href: string; key: string; permission: Permission | Permission[] }[] = [
  { href: '/admin', key: 'dashboard', permission: 'dashboard.read' },
  { href: '/admin/users', key: 'users', permission: 'users.read' },
  { href: '/admin/subscriptions', key: 'subscriptions', permission: 'subscriptions.read' },
  { href: '/admin/payments', key: 'payments', permission: 'payments.read' },
  { href: '/admin/plans', key: 'plans', permission: 'plans.read' },
  { href: '/admin/promocodes', key: 'promocodes', permission: 'promocodes.read' },
  { href: '/admin/referrals', key: 'referrals', permission: 'referrals.read' },
  { href: '/admin/broadcasts', key: 'broadcasts', permission: 'broadcasts.read' },
  { href: '/admin/support', key: 'support', permission: 'support.read' },
  { href: '/admin/settings', key: 'settings', permission: 'settings.read' },
  { href: '/admin/admins', key: 'admins', permission: 'admins.write' },
  { href: '/admin/audit', key: 'audit', permission: ['audit.read', 'audit.read.self'] },
  { href: '/admin/system', key: 'system', permission: 'system.read' },
];

/**
 * Loads `AdminMe` once, stores the CSRF token for later mutations and hides
 * every section the role does not carry (section 14.2).
 */
export function AdminShell({ children }: { children: (me: AdminMe) => ReactNode }) {
  const t = useTranslations('admin');
  const router = useRouter();
  const pathname = usePathname();
  const [me, setMe] = useState<AdminMe | null>(null);
  const [unauthorized, setUnauthorized] = useState(false);
  const [loadFailed, setLoadFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    let active = true;
    setLoadFailed(false);
    adminApi()
      .get('api/admin/v1/auth/me', adminMeSchema)
      .then(
        (result) => {
          if (!active) return;
          setAdminCsrfToken(result.csrfToken);
          setMe(result.admin);
        },
        (error: unknown) => {
          if (!active) return;
          if (error instanceof ApiError && error.status === 401) setUnauthorized(true);
          else setLoadFailed(true);
        },
      );
    return () => {
      active = false;
    };
  }, [attempt]);

  useEffect(() => {
    if (unauthorized) router.replace('/admin/login');
  }, [unauthorized, router]);

  if (!me)
    return (
      <div className="flex flex-col items-start gap-3 p-10 text-sm text-muted-foreground">
        <span>{loadFailed ? t('errorTitle') : t('loading')}</span>
        {loadFailed && (
          <Button
            onClick={() => {
              setAttempt((current) => current + 1);
            }}
          >
            {t('retry')}
          </Button>
        )}
      </div>
    );

  const granted = new Set(
    me.permissions.filter((item) => allPermissions.includes(item as Permission)),
  );

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 px-6 py-8">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-border pb-4">
        <nav>
          <ul className="flex flex-wrap gap-1">
            {links
              .filter((link) =>
                (Array.isArray(link.permission) ? link.permission : [link.permission]).some(
                  (permission) => granted.has(permission),
                ),
              )
              .map((link) => (
                <li key={link.href}>
                  <Link
                    aria-current={pathname === link.href ? 'page' : undefined}
                    className={cn(
                      'inline-flex h-9 items-center rounded-md px-3 text-sm font-medium transition-colors',
                      pathname === link.href
                        ? 'bg-primary text-primary-foreground'
                        : 'text-muted-foreground hover:bg-muted/40 hover:text-foreground',
                    )}
                    href={link.href}
                  >
                    {t(`nav.${link.key}`)}
                  </Link>
                </li>
              ))}
          </ul>
        </nav>
        <div className="flex items-center gap-3 text-sm">
          <span className="text-muted-foreground">
            {me.email} · {me.role}
          </span>
          <Button
            size="sm"
            variant="secondary"
            onClick={() => {
              void adminApi()
                .send('POST', 'api/admin/v1/auth/logout', z.unknown())
                .catch(() => undefined)
                .finally(() => {
                  router.replace('/admin/login');
                });
            }}
          >
            {t('logout')}
          </Button>
        </div>
      </header>
      <main>{children(me)}</main>
    </div>
  );
}
