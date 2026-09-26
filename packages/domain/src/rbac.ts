export const adminRoles = ['admin', 'operator'] as const;
export type AdminRole = (typeof adminRoles)[number];

/**
 * Single source for the section 14.2 matrix. The API guards routes with it and
 * the admin UI hides what `AdminMe.permissions[]` does not contain.
 */
export const permissions = [
  'dashboard.read',
  'users.read',
  'users.mutate',
  'users.balance.credit',
  'users.balance.debit',
  'users.anonymize',
  'subscriptions.read',
  'subscriptions.bulk',
  'payments.read',
  'payments.recheck',
  'payments.refund',
  'plans.read',
  'plans.write',
  'promocodes.read',
  'promocodes.write',
  'referrals.read',
  'referrals.write',
  'broadcasts.read',
  'broadcasts.write',
  'support.read',
  'support.write',
  'settings.read',
  'settings.write',
  'providers.write',
  'panel.write',
  'bot.write',
  'themes.read',
  'themes.write',
  'i18n.read',
  'i18n.write',
  'legal.read',
  'admins.write',
  'audit.read',
  'audit.read.self',
  'system.read',
  'system.write',
] as const;
export type Permission = (typeof permissions)[number];

/**
 * Operator row of the section 14.2 matrix. Settings, providers, panel, bot,
 * themes and locales are denied even for reading; legal texts are readable.
 * The journal is limited to the operator's own actions (`audit.read.self`).
 */
const operatorPermissions: readonly Permission[] = [
  'dashboard.read',
  'users.read',
  'users.mutate',
  'users.balance.credit',
  'subscriptions.read',
  'payments.read',
  'payments.recheck',
  'payments.refund',
  'plans.read',
  'promocodes.read',
  'promocodes.write',
  'referrals.read',
  'broadcasts.read',
  'broadcasts.write',
  // Owner decision F36: operators see the tickets; templates and FAQ are the owner's.
  'support.read',
  'legal.read',
  'audit.read.self',
  'system.read',
];

/** Permissions an operator may exercise only up to a settings-defined amount. */
export const operatorLimits: Readonly<Partial<Record<Permission, string>>> = {
  'users.balance.credit': 'operator.max_credit_minor',
  'payments.refund': 'operator.max_refund_minor',
};

export function permissionsFor(role: AdminRole): Permission[] {
  return role === 'admin'
    ? permissions.filter((permission) => permission !== 'audit.read.self')
    : [...operatorPermissions];
}

export function can(role: AdminRole, permission: Permission): boolean {
  return permissionsFor(role).includes(permission);
}

/** Settings key limiting this permission for the role, when one applies. */
export function limitKeyFor(role: AdminRole, permission: Permission): string | undefined {
  return role === 'operator' ? operatorLimits[permission] : undefined;
}

export function isAdminRole(value: string): value is AdminRole {
  return adminRoles.includes(value as AdminRole);
}

export function adminMe(admin: {
  id: string;
  email: string;
  role: AdminRole;
  telegramId: bigint | null;
}) {
  return {
    id: admin.id,
    email: admin.email,
    role: admin.role,
    telegramId: admin.telegramId?.toString() ?? null,
    permissions: permissionsFor(admin.role),
  };
}
