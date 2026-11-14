/**
 * Security headers on every response, plus a Content-Security-Policy on HTML pages.
 *
 * The policy fits what the web app does: scripts only from this server, book pages rendered by
 * foliate-js in blob: iframes (which inherit this policy, so scripts inside an EPUB never run),
 * pdf.js in a worker, and covers from Open Library, Google Books and Hardcover.
 * CONTENT_SECURITY_POLICY replaces it ("off" sends none) if a setup needs something else.
 */
import type { FastifyInstance } from "fastify";
import fp from "fastify-plugin";
import { isSecureRequest } from "../auth/plugin.js";

export const DEFAULT_CSP = [
  "default-src 'self'",
  "script-src 'self' 'wasm-unsafe-eval'",
  // React style={} attributes and EPUB stylesheets.
  "style-src 'self' 'unsafe-inline' blob:",
  "img-src 'self' data: blob: https:",
  "font-src 'self' data: blob:",
  "media-src 'self' blob: data:",
  "connect-src 'self' blob: data:",
  "worker-src 'self' blob:",
  "frame-src 'self' blob:",
  "child-src 'self' blob:",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'self'",
].join("; ");

export interface SecurityHeaderOptions {
  trustedProxies: string[];
  /** undefined = DEFAULT_CSP, "off" = none. */
  csp?: string;
}

export const securityHeaders = fp(async (app: FastifyInstance, opts: SecurityHeaderOptions) => {
  const csp = opts.csp === "off" ? null : opts.csp?.trim() || DEFAULT_CSP;
  app.addHook("onSend", async (req, reply, payload) => {
    reply.header("x-content-type-options", "nosniff");
    reply.header("referrer-policy", "same-origin");
    reply.header("x-frame-options", "SAMEORIGIN");
    reply.header("cross-origin-opener-policy", "same-origin");
    reply.header("permissions-policy", "camera=(self), microphone=(self), geolocation=(), payment=(), usb=(), interest-cohort=()");
    if (isSecureRequest(req, opts.trustedProxies)) {
      reply.header("strict-transport-security", "max-age=15552000");
    }
    const type = String(reply.getHeader("content-type") ?? "");
    if (csp && type.startsWith("text/html")) reply.header("content-security-policy", csp);
    // Signed-in API answers are personal: never let a shared proxy or the browser's disk cache keep them.
    if (req.url.startsWith("/api/") && !reply.hasHeader("cache-control")) reply.header("cache-control", "no-store");
    return payload;
  });
});
