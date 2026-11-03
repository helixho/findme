import { defineConfig } from "drizzle-kit";

export default defineConfig({
  schema: [
    "./src/schema.ts",
    "./src/schema-archive.ts",
    "./src/schema-core.ts",
    "./src/schema-diagnostic.ts",
    "./src/schema-auth.ts",
    "./src/schema-platform.ts",
    "./src/schema-specialist.ts",
    "./src/schema-knowledge.ts",
  ],
  out: "./migrations",
  dialect: "postgresql",
  dbCredentials: {
    url:
      process.env.DATABASE_URL_MIGRATION ??
      process.env.DATABASE_URL_UNPOOLED ??
      process.env.DATABASE_URL ??
      "",
  },
});
