import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dialect: "sqlite",
  schema: ["./src/db/schema.ts", "./src/integrations/schema.ts", "./src/storyteller/schema.ts", "./src/ereader/schema.ts", "./src/ai/schema.ts", "./src/jobs/schema.ts", "./src/librarian/schema.ts", "./src/audio/schema.ts", "./src/imports/schema.ts", "./src/rewards/schema.ts", "./src/narration/schema.ts", "./src/learning/schema.ts"],
  out: "./drizzle",
});
