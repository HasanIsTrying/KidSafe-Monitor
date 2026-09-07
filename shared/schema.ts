import { pgTable, text, serial, integer, bigint } from "drizzle-orm/pg-core";
import { createInsertSchema } from "drizzle-zod";
import { z } from "zod";

// We'll use in-memory storage for Python, but we define the schema here
// so the frontend generator knows what the data looks like.

export const alerts = pgTable("alerts", {
  id: serial("id").primaryKey(),
  status: text("status").notNull(), // "CHILD_ONLY" | "SAFE"
  message: text("message").notNull(),
  timestamp: bigint("timestamp", { mode: "number" }).notNull(),
});

export const insertAlertSchema = createInsertSchema(alerts).omit({ id: true });

export type Alert = typeof alerts.$inferSelect;
export type InsertAlert = z.infer<typeof insertAlertSchema>;
