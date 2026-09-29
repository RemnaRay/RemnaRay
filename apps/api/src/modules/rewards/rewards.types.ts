import type { Prisma } from '@remnaray/db/generated';

export type Tx = Prisma.TransactionClient;

export type ReferralConfig = {
  enabled: boolean;
  mode: 'percent_first' | 'percent_all' | 'fixed_first';
  percent: number;
  fixedMinor: bigint;
  allMonths: number;
  inviteeBonus: { type: 'none' | 'days' | 'balance'; value: number };
  inviteeBonusTrigger: 'signup' | 'first_paid';
  holdHours: number;
  maxRewardsPerDay: number;
  minSourceAmountMinor: bigint;
};

export type TrialLimits = {
  days: number;
  trafficGb: number;
  deviceLimit: number;
  squads: string[];
};

export type SourceTransaction = {
  id: string;
  userId: string;
  type: string;
  amountMinor: bigint;
};
