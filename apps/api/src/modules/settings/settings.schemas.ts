import { z } from 'zod';

import { isHostName, isIpOrCidr } from '../../common/network-values';
import { DEFAULT_ITEM_NAME_TEMPLATE } from '../payments/checkout';
import { OUTGOING_EVENTS } from '../webhooks/outgoing';

/** R58: what the proxy configurations may carry (`common/network-values`). */
export const hostNameSchema = z
  .string()
  .min(1)
  .max(253)
  .refine(isHostName, { message: 'Must be a host name' });

export const ipOrCidrSchema = z
  .string()
  .refine(isIpOrCidr, { message: 'Must be an IP address or a CIDR range' });

const emptyOrUrl = z.union([z.url(), z.literal('')]);
const minorAmount = z.string().regex(/^\d+$/, 'must be a non-negative integer in minor units');
const locale = z.enum(['ru', 'en']);
/** An IANA time zone this runtime knows (`Intl`), for display and scheduled work. */
export const ianaTimeZone = z
  .string()
  .min(1)
  .max(64)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat('en', { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, 'Unknown IANA timezone');
const clientLink = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  platforms: z.array(z.string().min(1)),
  deepLinkTemplate: z.string().min(1),
  storeUrls: z.record(z.string(), z.url().or(z.literal(''))),
});
const webhook = z.object({
  url: z.url(),
  secret: z.string().min(1),
  events: z.array(z.enum(OUTGOING_EVENTS)).min(1),
  enabled: z.boolean().default(true),
});

export type SettingsGroup =
  | 'setup'
  | 'brand'
  | 'domain'
  | 'locale'
  | 'theme'
  | 'panel'
  | 'bot'
  | 'trial'
  | 'subscription'
  | 'invoice'
  | 'balance'
  | 'fiscal'
  | 'referral'
  | 'notifications'
  | 'clients'
  | 'webhooks'
  | 'operator'
  | 'support'
  | 'admin'
  | 'legal';

export type SettingDefinition = {
  group: SettingsGroup;
  name: string;
  schema: z.ZodType;
  defaultValue: unknown;
  secret: boolean;
  description: string;
};

const definitions = (
  group: SettingsGroup,
  fields: Record<
    string,
    { schema: z.ZodType; defaultValue: unknown; secret?: boolean; description: string }
  >,
): SettingDefinition[] =>
  Object.entries(fields).map(([name, field]) => ({
    group,
    name,
    schema: field.schema,
    defaultValue: field.defaultValue,
    secret: field.secret ?? false,
    description: field.description,
  }));

export const settingRegistry: SettingDefinition[] = [
  ...definitions('setup', {
    completed: {
      schema: z.boolean(),
      defaultValue: false,
      description: 'Whether the initial setup wizard has completed.',
    },
    step: {
      schema: z.string(),
      defaultValue: '0',
      description: 'Current setup wizard step.',
    },
  }),
  ...definitions('brand', {
    name: {
      schema: z.string().min(1),
      defaultValue: 'RemnaRay Shop',
      description: 'Public shop name.',
    },
    slogan: {
      schema: z.object({ ru: z.string(), en: z.string() }),
      defaultValue: { ru: '', en: '' },
      description: 'Localized public slogan.',
    },
    hide_powered_by: {
      schema: z.boolean(),
      defaultValue: false,
      description: 'Hide the RemnaRay attribution.',
    },
    support_contact: {
      schema: z.string(),
      defaultValue: '',
      description: 'Support Telegram handle or URL.',
    },
    support_forward_chat_id: {
      schema: z.number().int().nullable(),
      defaultValue: null,
      description: 'Optional Telegram chat for forwarded support messages.',
    },
  }),
  ...definitions('domain', {
    // R58: the proxy configurations carry these three as they are.
    main: {
      schema: hostNameSchema,
      defaultValue: process.env.RR_DOMAIN ?? 'localhost',
      description: 'Primary public domain.',
    },
    acme_email: {
      schema: z.email().or(z.literal('')),
      defaultValue: process.env.RR_ACME_EMAIL ?? '',
      description: 'Email used for ACME certificates.',
    },
    extra_domains: {
      schema: z.array(hostNameSchema).max(10),
      defaultValue: [],
      description: 'Additional domains that redirect to the primary domain.',
    },
  }),
  ...definitions('locale', {
    default: { schema: locale, defaultValue: 'ru', description: 'Default locale.' },
    enabled: {
      schema: z.array(locale).min(1),
      defaultValue: ['ru', 'en'],
      description: 'Enabled locales.',
    },
    timezone: {
      schema: ianaTimeZone,
      defaultValue: 'Europe/Moscow',
      description: 'IANA timezone for display and scheduled work.',
    },
  }),
  ...definitions('theme', {
    slug: { schema: z.string().min(1), defaultValue: 'manta', description: 'Active theme slug.' },
  }),
  ...definitions('panel', {
    base_url: { schema: emptyOrUrl, defaultValue: '', description: 'Remnawave panel URL.' },
    api_token: {
      schema: z.string(),
      defaultValue: '',
      secret: true,
      description: 'Remnawave API token.',
    },
    webhook_secret: {
      schema: z.string(),
      defaultValue: '',
      secret: true,
      description: 'Secret used to authenticate panel webhooks.',
    },
    extra_headers: {
      schema: z.record(z.string(), z.string()),
      defaultValue: {},
      description: 'Additional headers sent to the panel.',
    },
    respect_manual_expire: {
      schema: z.boolean(),
      defaultValue: false,
      description: 'Respect manual panel expiry changes.',
    },
    username_prefix: {
      schema: z.string().min(1),
      defaultValue: 'rr_',
      description: 'Prefix for panel usernames.',
    },
  }),
  ...definitions('bot', {
    token: {
      schema: z.string(),
      defaultValue: '',
      secret: true,
      description: 'Telegram bot token.',
    },
    username: {
      schema: z.string(),
      defaultValue: '',
      description: 'Cached Telegram bot username.',
    },
    mode: {
      schema: z.enum(['webhook', 'polling']),
      defaultValue: 'webhook',
      description: 'Telegram update ingress mode.',
    },
    webhook_secret_path: {
      schema: z.string(),
      defaultValue: '',
      secret: true,
      description: 'Secret path segment for the Telegram webhook.',
    },
    webhook_secret_token: {
      schema: z.string(),
      defaultValue: '',
      secret: true,
      description: 'Telegram webhook secret token.',
    },
    admin_language: {
      schema: locale,
      defaultValue: 'ru',
      description: 'Language of bot admin notifications.',
    },
    // Owner decision F35 (2026-09-26): an optional bot of its own for support.
    support_token: {
      schema: z.string(),
      defaultValue: '',
      secret: true,
      description: 'Optional support bot token; empty keeps support in the shop bot.',
    },
    support_username: {
      schema: z.string(),
      defaultValue: '',
      description: 'Cached username of the support bot.',
    },
    support_webhook_secret_path: {
      schema: z.string(),
      defaultValue: '',
      secret: true,
      description: 'Secret path segment for the support bot webhook.',
    },
    support_webhook_secret_token: {
      schema: z.string(),
      defaultValue: '',
      secret: true,
      description: 'Support bot webhook secret token.',
    },
  }),
  ...definitions('trial', {
    enabled: {
      schema: z.boolean(),
      defaultValue: true,
      description: 'Enable trial subscriptions.',
    },
    days: {
      schema: z.number().int().min(0).max(3650),
      defaultValue: 3,
      description: 'Trial duration.',
    },
    traffic_gb: {
      schema: z.number().int().min(0),
      defaultValue: 10,
      description: 'Trial traffic limit in gigabytes.',
    },
    device_limit: {
      schema: z.number().int().min(0),
      defaultValue: 1,
      description: 'Trial device limit.',
    },
    squads: { schema: z.array(z.uuid()), defaultValue: [], description: 'Trial panel squad IDs.' },
  }),
  ...definitions('subscription', {
    grace_hours: {
      schema: z.number().int().min(0).max(8760),
      defaultValue: 0,
      description: 'Grace period after expiry.',
    },
    user_can_remove_devices: {
      schema: z.boolean(),
      defaultValue: true,
      description: 'Allow users to remove panel devices.',
    },
    revoke_cooldown_hours: {
      schema: z.number().int().min(0).max(8760),
      defaultValue: 24,
      description: 'Cooldown before a revoked subscription can be reactivated.',
    },
  }),
  ...definitions('invoice', {
    ttl_minutes: {
      schema: z.number().int().min(1).max(10080),
      defaultValue: 30,
      description: 'Invoice lifetime in minutes.',
    },
    ttl_minutes_crypto: {
      schema: z.number().int().min(1).max(10080),
      defaultValue: 60,
      description: 'Crypto invoice lifetime in minutes.',
    },
    underpaid_tolerance_pct: {
      schema: z.number().min(0).max(100),
      defaultValue: 2,
      description: 'Allowed underpayment percentage.',
    },
  }),
  ...definitions('balance', {
    topup_enabled: {
      schema: z.boolean(),
      defaultValue: true,
      description: 'Enable balance top-ups.',
    },
    topup_presets_minor: {
      schema: z.array(minorAmount),
      defaultValue: ['10000', '30000', '50000', '100000'],
      description: 'Preset top-up amounts in minor units.',
    },
    topup_min_minor: {
      schema: minorAmount,
      defaultValue: '5000',
      description: 'Minimum top-up in minor units.',
    },
    topup_max_minor: {
      schema: minorAmount,
      defaultValue: '1000000',
      description: 'Maximum top-up in minor units.',
    },
  }),
  ...definitions('fiscal', {
    mode: {
      // FR-062: `provider_receipt` sends the receipt through a provider
      // that supports it (YooKassa, Robokassa); `none` sends none.
      schema: z.enum(['none', 'provider_receipt']),
      defaultValue: 'none',
      description: 'Fiscalization mode.',
    },
    self_employed: {
      schema: z.boolean(),
      defaultValue: false,
      description: 'Self-employed tax status.',
    },
    vat_code: { schema: z.number().int().min(1), defaultValue: 1, description: 'VAT code.' },
    sno: { schema: z.string().min(1), defaultValue: 'npd', description: 'Taxation system code.' },
    fallback_email: {
      schema: z.email().or(z.literal('')),
      defaultValue: '',
      description: 'Receipt fallback email.',
    },
    item_name_template: {
      // F37 (ADR-021): one line for every top-up — the receipt's item and the
      // provider's payment description; `{number}` is the invoice number.
      schema: z
        .string()
        .min(1)
        .max(128)
        .refine(
          (value) =>
            [...value.matchAll(/\{(\w+)\}/gu)].every((m) => m[1] === 'number' || m[1] === 'brand'),
          { message: 'Only {number} and {brand} are allowed.' },
        ),
      defaultValue: DEFAULT_ITEM_NAME_TEMPLATE,
      description: 'Top-up receipt line and payment description; placeholders {number}, {brand}.',
    },
  }),
  ...definitions('referral', {
    enabled: { schema: z.boolean(), defaultValue: true, description: 'Enable referrals.' },
    mode: {
      schema: z.enum(['percent_first', 'percent_all', 'fixed_first']),
      defaultValue: 'percent_first',
      description: 'Referral reward mode.',
    },
    percent: {
      schema: z.number().int().min(1).max(100),
      defaultValue: 20,
      description: 'Reward percentage.',
    },
    fixed_minor: {
      schema: minorAmount,
      defaultValue: '10000',
      description: 'Fixed reward in minor units.',
    },
    all_months: {
      schema: z.number().int().min(0).max(120),
      defaultValue: 0,
      description: 'Reward duration in months.',
    },
    invitee_bonus: {
      schema: z.object({
        type: z.enum(['none', 'days', 'balance']),
        value: z.number().int().min(0),
      }),
      defaultValue: { type: 'days', value: 3 },
      description: 'Bonus for the invited user.',
    },
    invitee_bonus_trigger: {
      schema: z.enum(['signup', 'first_paid']),
      defaultValue: 'first_paid',
      description: 'Event that grants the invitee bonus.',
    },
    hold_hours: {
      schema: z.number().int().min(0).max(720),
      defaultValue: 0,
      description: 'Reward hold duration.',
    },
    max_rewards_per_day: {
      schema: z.number().int().min(0),
      defaultValue: 20,
      description: 'Daily reward cap.',
    },
    min_source_amount_minor: {
      schema: minorAmount,
      defaultValue: '0',
      description: 'Minimum source payment.',
    },
    count_topups: {
      schema: z.boolean(),
      defaultValue: false,
      description: 'Count balance top-ups for rewards.',
    },
  }),
  ...definitions('notifications', {
    expiring_days: {
      schema: z.array(z.number().int().min(0)),
      defaultValue: [3, 1],
      description: 'Expiry notification offsets.',
    },
    traffic_threshold_pct: {
      schema: z.number().int().min(1).max(100),
      defaultValue: 80,
      description: 'Traffic warning threshold.',
    },
  }),
  ...definitions('clients', {
    items: {
      schema: z.array(clientLink),
      defaultValue: [
        {
          id: 'happ',
          name: 'Happ',
          platforms: ['ios', 'android'],
          deepLinkTemplate: 'happ://add/{url}',
          storeUrls: {},
        },
        {
          id: 'v2raytun',
          name: 'v2rayTun',
          platforms: ['ios', 'android'],
          deepLinkTemplate: 'v2raytun://import/{url}',
          storeUrls: {},
        },
        {
          id: 'streisand',
          name: 'Streisand',
          platforms: ['ios'],
          deepLinkTemplate: 'streisand://import/{url}',
          storeUrls: {},
        },
        {
          id: 'hiddify',
          name: 'Hiddify',
          platforms: ['ios', 'android', 'windows', 'macos'],
          deepLinkTemplate: 'hiddify://import/{url}',
          storeUrls: {},
        },
        {
          id: 'clash-meta',
          name: 'Clash Meta',
          platforms: ['android', 'windows', 'macos'],
          deepLinkTemplate: 'clash://install-config?url={url}',
          storeUrls: {},
        },
      ],
      description: 'Supported client applications.',
    },
  }),
  ...definitions('webhooks', {
    outgoing: {
      // Section 9.8: at most five recipients.
      schema: z.array(webhook).max(5),
      defaultValue: [],
      secret: true,
      description: 'Outgoing webhook destinations.',
    },
  }),
  ...definitions('operator', {
    max_credit_minor: {
      schema: minorAmount,
      defaultValue: '100000',
      description: 'Operator credit limit.',
    },
    max_refund_minor: {
      schema: minorAmount,
      defaultValue: '100000',
      description: 'Operator refund limit.',
    },
  }),
  // Owner decision F36: the operators are reminded of a ticket nobody took,
  // and a ticket the customer left unanswered closes by itself; 0 turns off.
  ...definitions('support', {
    remind_after_minutes: {
      schema: z.number().int().min(0).max(10_080),
      defaultValue: 15,
      description: 'Remind the operators of a ticket nobody took after this many minutes.',
    },
    autoclose_hours: {
      schema: z.number().int().min(0).max(8_760),
      defaultValue: 48,
      description: 'Close a ticket after this many hours without the customer answering.',
    },
  }),
  ...definitions('admin', {
    language: { schema: locale, defaultValue: 'ru', description: 'Admin interface language.' },
    session_hours: {
      schema: z.number().int().min(1).max(168),
      defaultValue: 12,
      description: 'Admin session lifetime.',
    },
    ip_allowlist: {
      schema: z.array(ipOrCidrSchema).max(100),
      defaultValue: [],
      description: 'Optional admin IP allowlist.',
    },
    // Section 20.3 `maintenance.disk-check`: `disk.low` below this share of
    // the database volume free (FR-163).
    disk_alert_pct: {
      schema: z.number().int().min(1).max(99),
      defaultValue: 10,
      description: 'Free space on the database volume, in percent, below which disk.low is raised.',
    },
    check_updates: {
      schema: z.boolean(),
      defaultValue: true,
      description: 'Check GitHub releases for updates.',
    },
  }),
  ...definitions('legal', {
    terms_updated_at: {
      schema: z.string().nullable(),
      defaultValue: null,
      description: 'Terms revision timestamp.',
    },
    privacy_updated_at: {
      schema: z.string().nullable(),
      defaultValue: null,
      description: 'Privacy revision timestamp.',
    },
  }),
];

export const settingDefinitions = new Map(
  settingRegistry.map((definition) => [`${definition.group}.${definition.name}`, definition]),
);

export const settingsGroups = [...new Set(settingRegistry.map((definition) => definition.group))];

export const settingsImportSchema = z.object({
  version: z.literal(1),
  settings: z.record(z.string(), z.record(z.string(), z.unknown())),
});

export const settingsPatchSchema = z.record(z.string(), z.record(z.string(), z.unknown()));

export type SettingsPatch = z.infer<typeof settingsImportSchema>['settings'];

export function settingKey(group: SettingsGroup, name: string): string {
  return `${group}.${name}`;
}
