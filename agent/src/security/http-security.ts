import { MAX_SEALED_REQUEST } from '@kubernanny/protocol';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { raw } from 'express';
import type { NextFunction, Request, Response } from 'express';

/**
 * Content Security Policy for the web UI the agent serves.
 *
 * - Scripts only from this origin, no inline scripts, no eval: an injected
 *   string can never run as code, so the device key in the page's storage
 *   cannot be read out by a cross-site script.
 * - Styles allow inline: Ionic sets style attributes at runtime.
 * - connect-src: this agent, other agents over HTTPS (the app manages several
 *   clusters), local port-forwards, and data: (ionicons loads its SVGs that way).
 * - No frames, no plugins, no forms posting elsewhere, no <base> tricks.
 */
export const CONTENT_SECURITY_POLICY = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self'",
  "connect-src 'self' https: http://localhost:* http://127.0.0.1:* data:",
  "frame-ancestors 'none'",
  "frame-src 'none'",
  "object-src 'none'",
  // Angular's index.html sets <base href="/">; only this origin is allowed as base.
  "base-uri 'self'",
  "form-action 'none'",
].join('; ');

export function securityHeaders(req: Request, res: Response, next: NextFunction): void {
  res.setHeader('Content-Security-Policy', CONTENT_SECURITY_POLICY);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  // Pairing links carry the code in the fragment, which browsers never send; this also keeps paths out of other sites' logs.
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), usb=(), payment=()');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
  res.removeHeader('X-Powered-By');
  // No HSTS: the agent never speaks TLS itself, and X-Forwarded-Proto is
  // whatever any caller writes. HSTS belongs on whatever terminates TLS (the
  // ingress controller), docs/SECURITY.md.
  if (req.path.startsWith('/api/')) {
    // Cluster state and logs must never land in a browser or proxy cache.
    res.setHeader('Cache-Control', 'no-store');
  }
  next();
}

/** Everything HTTP-level the agent enforces; used by main.ts and by the tests. */
export function applyHttpSecurity(app: NestExpressApplication): void {
  app.disable('x-powered-by');
  // The end-to-end channel: one Noise message 1 plus the version byte.
  app.use('/api/e2e', raw({ type: () => true, limit: MAX_SEALED_REQUEST }));
  // Internal routes (over the socket only) take small JSON bodies.
  app.useBodyParser('json', { limit: '4kb' });
  app.use(securityHeaders);
}
