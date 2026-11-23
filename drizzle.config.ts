import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: "./storage/schema.ts",
  out: "./drizzle",
  casing: "snake_case",
});