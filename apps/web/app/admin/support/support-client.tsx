'use client';

import { useCallback } from 'react';
import { useTranslations } from 'next-intl';

import { Tabs, TabsContent, TabsList, TabsTrigger, useToast } from '@remnaray/ui';

import { errorCode } from '../../../lib/admin-client';
import { AdminShell } from '../admin-shell';
import { useAdminErrorMessage } from '../admin-states';
import { FaqTab } from './faq-tab';
import { StatsTab } from './stats-tab';
import { TemplatesTab } from './templates-tab';
import { TicketsTab } from './tickets-tab';

/**
 * Owner decision F36: the support tickets worked in the operators' Telegram
 * chat, their statistics, and the owner's answer templates and self-help
 * questions. Operators read (`support.read`); only `support.write` edits.
 */
export default function SupportClient() {
  const t = useTranslations('admin');
  const { toast } = useToast();
  const message = useAdminErrorMessage();
  const fail = useCallback(
    (error: unknown) => {
      toast({ title: t('errorTitle'), description: message(errorCode(error)), variant: 'danger' });
    },
    [message, t, toast],
  );
  const notify = useCallback(
    (title: string) => {
      toast({ title });
    },
    [toast],
  );

  return (
    <AdminShell>
      {(me) => {
        const canWrite = me.permissions.includes('support.write');
        return (
          <section className="flex flex-col gap-6">
            <h1 className="text-2xl font-bold">{t('helpdesk.title')}</h1>
            <Tabs defaultValue="tickets">
              <TabsList className="flex-wrap">
                <TabsTrigger value="tickets">{t('helpdesk.tabs.tickets')}</TabsTrigger>
                <TabsTrigger value="stats">{t('helpdesk.tabs.stats')}</TabsTrigger>
                <TabsTrigger value="templates">{t('helpdesk.tabs.templates')}</TabsTrigger>
                <TabsTrigger value="faq">{t('helpdesk.tabs.faq')}</TabsTrigger>
              </TabsList>
              <TabsContent value="tickets">
                <TicketsTab />
              </TabsContent>
              <TabsContent value="stats">
                <StatsTab />
              </TabsContent>
              <TabsContent value="templates">
                <TemplatesTab canWrite={canWrite} fail={fail} notify={notify} />
              </TabsContent>
              <TabsContent value="faq">
                <FaqTab canWrite={canWrite} fail={fail} notify={notify} />
              </TabsContent>
            </Tabs>
          </section>
        );
      }}
    </AdminShell>
  );
}
