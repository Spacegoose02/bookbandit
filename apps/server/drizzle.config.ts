import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/db/schema.ts", "./src/integrations/schema.ts", "./src/ai/schema.ts"],
  out: "./drizzle",
});
