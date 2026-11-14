import type { FastifyError, FastifyInstance } from "fastify";
import { ZodError } from "zod";
import { TooManyAttemptsError } from "./rate-limit.js";

/** Bad input → 400 with the zod issues; lockouts → 429 with Retry-After. Scoped to the plugin it's added to. */
export function useAuthErrors(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({ error: "Bad request", issues: err.issues });
    }
    if (err instanceof TooManyAttemptsError) {
      reply.header("retry-after", Math.ceil(err.retryAfterMs / 1000));
    }
    return reply.send(err);
  });
}
