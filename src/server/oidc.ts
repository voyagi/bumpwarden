import { OAuth2Client } from 'google-auth-library';

/**
 * Claims extracted from a verified Google ID token.
 */
export interface IdTokenClaims {
  email?: string;
  email_verified?: boolean;
  aud?: string | string[];
  iss?: string;
}

/**
 * Function type for verifying an ID token and extracting its claims.
 */
export type TokenVerifier = (idToken: string, audience: string) => Promise<IdTokenClaims | null>;

/**
 * Configuration for authenticating requests to the run endpoint.
 */
export interface RunAuthConfig {
  /** Service account Cloud Scheduler signs with. No value means the endpoint stays shut. */
  invokerEmail: string | null;
  /**
   * The exact URL Cloud Scheduler calls. Required, not optional: google-auth-library only checks
   * the `aud` claim when an audience is passed, so verifying without one accepts any Google-signed
   * token carrying the invoker's email, including one minted for a completely different service.
   */
  audience: string | null;
  verify: TokenVerifier;
}

/**
 * Result of an authorization check, either successful with the caller's identity or failed with a status code and reason.
 */
export type AuthResult =
  { ok: true; caller: string } | { ok: false; status: 401 | 403 | 503; reason: string };

const BEARER = /^Bearer\s+(.+)$/i;

/**
 * Cloud Run's own invoker IAM is service-wide, and this service also serves a public dashboard, so
 * the run endpoint has to check the caller itself. It fails CLOSED: a deployment with no configured
 * invoker refuses every call rather than accepting any, because the failure mode of the other
 * choice is an open endpoint that opens GitHub issues.
 */
export async function authorizeRun(
  authorizationHeader: string | undefined,
  config: RunAuthConfig,
): Promise<AuthResult> {
  if (!config.invokerEmail) {
    return { ok: false, status: 503, reason: 'the run endpoint has no configured invoker' };
  }
  if (!config.audience) {
    return { ok: false, status: 503, reason: 'the run endpoint has no configured audience' };
  }

  const bearer = BEARER.exec(authorizationHeader ?? '');
  if (!bearer?.[1]) {
    return { ok: false, status: 401, reason: 'no bearer token' };
  }

  let claims: IdTokenClaims | null;
  try {
    claims = await config.verify(bearer[1], config.audience);
  } catch {
    return { ok: false, status: 401, reason: 'token did not verify' };
  }

  if (!claims) return { ok: false, status: 401, reason: 'token did not verify' };
  // Not `=== false`: a token with no email_verified claim at all is one Google did not say was
  // verified, and this endpoint opens issues on someone's repository.
  if (claims.email_verified !== true) {
    return { ok: false, status: 403, reason: 'token email is not verified' };
  }
  if (!claims.email || claims.email !== config.invokerEmail) {
    return { ok: false, status: 403, reason: 'token is not the configured invoker' };
  }

  return { ok: true, caller: claims.email };
}

/**
 * Creates a token verifier that uses Google's OAuth2 client to verify ID tokens.
 */
export function googleTokenVerifier(client = new OAuth2Client()): TokenVerifier {
  return async (idToken, audience) => {
    const ticket = await client.verifyIdToken({ idToken, audience });
    return ticket.getPayload() ?? null;
  };
}
