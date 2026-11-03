import { jsonb, pgTable, text, timestamp } from "drizzle-orm/pg-core";

/** Instance-wide application settings, such as the model provider. Not personal data. */
export const appSettings = pgTable("app_settings", {
  key: text("key").primaryKey(),
  value: jsonb("value").notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
