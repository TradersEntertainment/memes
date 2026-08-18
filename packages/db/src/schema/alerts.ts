import { bigint, bigserial, jsonb, pgTable, text, timestamp } from 'drizzle-orm/pg-core';
import { liveEvents } from './live-events';

export const alerts = pgTable('alerts', {
  id: bigserial('id', { mode: 'number' }).primaryKey(),
  eventId: bigint('event_id', { mode: 'number' }).references(() => liveEvents.id),
  channel: text('channel').notNull(),
  sentAt: timestamp('sent_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  payload: jsonb('payload'),
});

export type AlertRow = typeof alerts.$inferSelect;
export type NewAlertRow = typeof alerts.$inferInsert;
