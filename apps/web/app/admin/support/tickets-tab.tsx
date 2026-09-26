'use client';

import { useState } from 'react';
import { useTranslations } from 'next-intl';
import Link from 'next/link';
import { z } from 'zod';

import {
  Badge,
  Button,
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  DataTable,
  Input,
  Label,
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@remnaray/ui';

import { adminApi } from '../../../lib/admin-client';
import { useResource } from '../../../lib/resource';
import { AdminSection } from '../admin-states';

const userSchema = z.object({
  id: z.string(),
  telegramId: z.string().nullable(),
  username: z.string().nullable(),
  firstName: z.string().nullable(),
});
const ticketSchema = z.object({
  id: z.string(),
  number: z.number(),
  status: z.enum(['open', 'in_progress', 'closed']),
  channel: z.string(),
  assignee: z.object({ telegramId: z.string(), name: z.string().nullable() }).nullable(),
  createdAt: z.string(),
  closedAt: z.string().nullable(),
  closedSilently: z.boolean(),
  rating: z.number().nullable(),
  user: userSchema,
});
export const ticketListSchema = z.object({
  items: z.array(ticketSchema),
  nextCursor: z.string().nullable(),
});
export const ticketDetailSchema = ticketSchema.extend({
  messages: z.array(
    z.object({
      id: z.string(),
      direction: z.enum(['customer', 'operator', 'note', 'system']),
      kind: z.string(),
      text: z.string().nullable(),
      hasFile: z.boolean(),
      authorName: z.string().nullable(),
      createdAt: z.string(),
    }),
  ),
});

const STATUS_VARIANT = { open: 'success', in_progress: 'warning', closed: 'secondary' } as const;
const STATUSES = ['live', 'open', 'in_progress', 'closed', 'all'] as const;

function customerName(user: z.infer<typeof userSchema>): string {
  return (
    [user.firstName, user.username ? `@${user.username}` : null].filter(Boolean).join(' ') ||
    (user.telegramId ?? '—')
  );
}

function when(value: string): string {
  return new Date(value).toLocaleString('ru', { dateStyle: 'short', timeStyle: 'short' });
}

/** The tickets with filters; a ticket opens with its history below the list. */
export function TicketsTab() {
  const t = useTranslations('admin');
  const [status, setStatus] = useState<(typeof STATUSES)[number]>('live');
  const [search, setSearch] = useState('');
  const [applied, setApplied] = useState('');
  // The user page links here with `?userId=`.
  const [userId, setUserId] = useState<string | null>(() =>
    typeof window === 'undefined'
      ? null
      : new URLSearchParams(window.location.search).get('userId'),
  );
  const [selected, setSelected] = useState<string | null>(null);
  const resource = useResource(`admin:support:tickets:${status}:${applied}:${userId ?? ''}`, () =>
    adminApi().get('api/admin/v1/support/tickets', ticketListSchema, {
      query: {
        limit: 100,
        ...(status === 'all' ? {} : { status }),
        ...(applied ? { q: applied } : {}),
        ...(userId ? { userId } : {}),
      },
    }),
  );

  return (
    <div className="flex flex-col gap-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          setApplied(search.trim());
        }}
      >
        <div className="flex flex-col gap-1">
          <Label htmlFor="support-status">{t('helpdesk.status')}</Label>
          <Select
            value={status}
            onValueChange={(value) => {
              setStatus(value as (typeof STATUSES)[number]);
            }}
          >
            <SelectTrigger className="w-44" id="support-status">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUSES.map((item) => (
                <SelectItem key={item} value={item}>
                  {t(`helpdesk.statuses.${item}`)}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
        <div className="flex flex-col gap-1">
          <Label htmlFor="support-search">{t('helpdesk.search')}</Label>
          <Input
            className="w-60"
            id="support-search"
            placeholder="#128, 123456789, @username"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
            }}
          />
        </div>
        <Button type="submit" variant="secondary">
          {t('helpdesk.find')}
        </Button>
        {userId ? (
          <Button
            type="button"
            variant="ghost"
            onClick={() => {
              setUserId(null);
            }}
          >
            {t('helpdesk.allCustomers')}
          </Button>
        ) : null}
      </form>

      <AdminSection refresh={resource.refresh} state={resource.state}>
        {(data) => (
          <DataTable
            columns={[
              {
                key: 'number',
                header: '#',
                cell: (row) => (
                  <Button
                    size="sm"
                    variant="link"
                    onClick={() => {
                      setSelected(row.id);
                    }}
                  >
                    #{row.number}
                  </Button>
                ),
              },
              {
                key: 'status',
                header: t('helpdesk.status'),
                cell: (row) => (
                  <Badge variant={STATUS_VARIANT[row.status]}>
                    {t(`helpdesk.statuses.${row.status}`)}
                  </Badge>
                ),
              },
              {
                key: 'customer',
                header: t('helpdesk.customer'),
                cell: (row) => (
                  <Link className="underline" href={`/admin/users/${row.user.id}`}>
                    {customerName(row.user)}
                  </Link>
                ),
              },
              {
                key: 'assignee',
                header: t('helpdesk.assignee'),
                cell: (row) => row.assignee?.name ?? '—',
              },
              { key: 'opened', header: t('helpdesk.opened'), cell: (row) => when(row.createdAt) },
              {
                key: 'rating',
                header: t('helpdesk.rating'),
                cell: (row) => (row.rating === null ? '—' : `★${row.rating.toString()}`),
              },
            ]}
            labels={{ loadMore: t('more'), emptyTitle: t('helpdesk.empty') }}
            rowKey={(row) => row.id}
            rows={data.items}
          />
        )}
      </AdminSection>

      {selected ? <TicketView id={selected} /> : null}
    </div>
  );
}

/** A ticket's history as the console keeps it: text, attachments by kind, notes. */
function TicketView({ id }: { id: string }) {
  const t = useTranslations('admin');
  const resource = useResource(`admin:support:ticket:${id}`, () =>
    adminApi().get(`api/admin/v1/support/tickets/${id}`, ticketDetailSchema),
  );
  return (
    <AdminSection refresh={resource.refresh} state={resource.state}>
      {(ticket) => (
        <Card>
          <CardHeader>
            <CardTitle>
              {t('helpdesk.ticketTitle', { number: ticket.number })} · {customerName(ticket.user)}
            </CardTitle>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            <p className="text-sm text-muted-foreground">
              {t(`helpdesk.statuses.${ticket.status}`)} · {when(ticket.createdAt)}
              {ticket.assignee?.name ? ` · ${ticket.assignee.name}` : ''}
              {ticket.closedAt
                ? ` · ${t(ticket.closedSilently ? 'helpdesk.closedSilently' : 'helpdesk.closed')} ${when(ticket.closedAt)}`
                : ''}
            </p>
            <ol className="flex flex-col gap-2">
              {ticket.messages.map((message) => (
                <li
                  className={
                    message.direction === 'customer'
                      ? 'mr-auto max-w-[85%] rounded-md bg-muted p-3 text-sm'
                      : message.direction === 'note'
                        ? 'mx-auto max-w-[85%] rounded-md border border-dashed p-3 text-sm'
                        : message.direction === 'system'
                          ? 'mx-auto text-xs text-muted-foreground'
                          : 'ml-auto max-w-[85%] rounded-md bg-primary/10 p-3 text-sm'
                  }
                  key={message.id}
                >
                  <div className="text-xs text-muted-foreground">
                    {t(`helpdesk.direction.${message.direction}`)}
                    {message.authorName ? ` · ${message.authorName}` : ''} ·{' '}
                    {when(message.createdAt)}
                  </div>
                  {message.hasFile || message.kind !== 'text' ? (
                    <div className="text-xs">
                      [{t('helpdesk.attachment', { kind: message.kind })}]
                    </div>
                  ) : null}
                  {message.text ? <p className="whitespace-pre-wrap">{message.text}</p> : null}
                </li>
              ))}
            </ol>
          </CardContent>
        </Card>
      )}
    </AdminSection>
  );
}
