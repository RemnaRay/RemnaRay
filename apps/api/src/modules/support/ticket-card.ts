import type { CardData } from './card-data';
import type { Ticket } from './tickets.repository';

/** A message of the operators' locale; values are HTML-escaped by `formatMessage`. */
export type Translate = (key: string, values?: Record<string, unknown>) => string;

export type Formats = {
  date: (value: Date) => string;
  money: (amountMinor: bigint) => string;
  bytes: (value: bigint) => string;
};

/** How much of the administrator's note the card shows. */
const NOTES_MAX = 300;

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

type Button = { text: string; callback_data: string } | { text: string; url: string };

const STATUS_ICON: Record<Ticket['status'], string> = {
  open: '🟢',
  in_progress: '🟡',
  closed: '⚪',
};

export function formats(locale: string, timeZone: string): Formats {
  const date = new Intl.DateTimeFormat(locale, {
    timeZone,
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
  const money = new Intl.NumberFormat(locale, {
    style: 'currency',
    currency: 'RUB',
    maximumFractionDigits: 2,
    minimumFractionDigits: 0,
  });
  const gigabytes = new Intl.NumberFormat(locale, { maximumFractionDigits: 1 });
  return {
    date: (value) => date.format(value),
    money: (amountMinor) => money.format(Number(amountMinor) / 100),
    bytes: (value) => `${gigabytes.format(Number(value) / 1024 ** 3)} GB`,
  };
}

/** `🟢 Anna · 42`: the topic's name shows the ticket's status (F36). */
export function topicName(
  status: Ticket['status'],
  user: { firstName: string | null; username: string | null; telegramId: string },
): string {
  const name = user.firstName ?? user.username ?? 'user';
  return `${STATUS_ICON[status]} ${name} · ${user.telegramId}`.slice(0, 128);
}

/** The customer's card: the ticket, the profile, the subscription, money, support. */
export function cardText(data: CardData, t: Translate, f: Formats): string {
  const { ticket, user, subscription, money, support } = data;
  const number = Number(ticket.number);
  const lines: string[] = [
    t('bot.support.card.title', {
      number,
      icon: STATUS_ICON[ticket.status],
      status: t(`bot.support.status.${ticket.status}`),
    }),
  ];
  if (ticket.assigneeName)
    lines.push(t('bot.support.card.assignee', { name: ticket.assigneeName }));
  lines.push(t('bot.support.card.opened', { at: f.date(ticket.createdAt) }));
  if (ticket.closedAt)
    lines.push(
      t(ticket.closedSilently ? 'bot.support.card.closedSilently' : 'bot.support.card.closed', {
        at: f.date(ticket.closedAt),
      }),
    );
  if (ticket.rating !== null) lines.push(t('bot.support.card.rating', { rating: ticket.rating }));

  lines.push(
    '',
    t('bot.support.card.user', {
      name: user.firstName ?? '—',
      username: user.username ? `@${user.username}` : '',
      id: user.telegramId,
      language: user.language,
    }),
    t('bot.support.card.registered', {
      at: f.date(user.createdAt),
      seen: user.lastSeenAt ? f.date(user.lastSeenAt) : '—',
    }),
  );
  if (user.referrer) lines.push(t('bot.support.card.referrer', { referrer: user.referrer }));
  const flags = [
    user.isBanned ? t('bot.support.card.banned') : null,
    user.botBlocked ? t('bot.support.card.botBlocked') : null,
    user.trialUsed ? t('bot.support.card.trialUsed') : null,
  ].filter((flag): flag is string => flag !== null);
  if (flags.length > 0) lines.push(flags.join(' · '));

  lines.push('');
  if (subscription) {
    lines.push(
      t('bot.support.card.subscription', {
        status: t(`bot.support.subscription.${subscription.status}`),
        plan: subscription.plan ?? '—',
        until: f.date(subscription.expiresAt),
      }),
      t('bot.support.card.traffic', {
        used: subscription.usedBytes === null ? '—' : f.bytes(subscription.usedBytes),
        limit: subscription.limitBytes === 0n ? '∞' : f.bytes(subscription.limitBytes),
        devices: subscription.deviceLimit === 0 ? '∞' : subscription.deviceLimit,
      }),
    );
    if (subscription.url) lines.push(t('bot.support.card.link', { url: subscription.url }));
  } else lines.push(t('bot.support.card.noSubscription'));

  lines.push('', t('bot.support.card.balance', { balance: f.money(money.balanceMinor) }));
  if (money.lastPurchase)
    lines.push(
      t('bot.support.card.lastPurchase', {
        plan: money.lastPurchase.plan ?? '—',
        amount: f.money(money.lastPurchase.amountMinor),
        at: f.date(money.lastPurchase.at),
        provider:
          money.lastPurchase.provider === 'balance'
            ? t('bot.support.card.fromBalance')
            : (money.lastPurchase.provider ?? '—'),
      }),
    );
  lines.push(
    t('bot.support.card.received', {
      total: f.money(money.receivedMinor),
      count: money.payments,
      pending: money.pendingInvoices,
    }),
  );

  lines.push(
    '',
    support.previous
      ? t('bot.support.card.history', {
          count: support.tickets,
          number: Number(support.previous.number),
          at: f.date(support.previous.at),
          rating: support.previous.rating === null ? '—' : `★${String(support.previous.rating)}`,
        })
      : t('bot.support.card.first'),
  );
  // The console allows 4000 characters of notes; Telegram, 4096 for the whole card.
  if (user.notes) lines.push(t('bot.support.card.notes', { notes: clip(user.notes, NOTES_MAX) }));
  return lines.join('\n');
}

/**
 * The card's buttons: take (until someone takes it), close, close silently,
 * the actions on the customer, refresh and the console's user page. A closed
 * ticket keeps the last two.
 */
export function cardKeyboard(
  ticket: Pick<Ticket, 'id' | 'status' | 'takenAt'>,
  t: Translate,
  consoleUrl: string,
): { inline_keyboard: Button[][] } {
  const data = (action: string) => `st:${action}:${ticket.id}`;
  const rows: Button[][] = [];
  if (ticket.status !== 'closed') {
    if (ticket.takenAt === null)
      rows.push([{ text: t('bot.support.btn.take'), callback_data: data('take') }]);
    rows.push([
      { text: t('bot.support.btn.close'), callback_data: data('close') },
      { text: t('bot.support.btn.silent'), callback_data: data('silent') },
    ]);
    // Actions on the customer, for console admins (F36).
    rows.push(
      [
        { text: t('bot.support.btn.ext7'), callback_data: data('ext7') },
        { text: t('bot.support.btn.ext30'), callback_data: data('ext30') },
      ],
      [
        { text: t('bot.support.btn.reset'), callback_data: data('reset') },
        { text: t('bot.support.btn.link'), callback_data: data('link') },
      ],
    );
  }
  rows.push([
    { text: t('bot.support.btn.refresh'), callback_data: data('card') },
    { text: t('bot.support.btn.console'), url: consoleUrl },
  ]);
  return { inline_keyboard: rows };
}
