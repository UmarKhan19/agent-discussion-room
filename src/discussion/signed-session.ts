import { createHmac, randomUUID, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import { SessionIdentifierSchema } from "./contracts";

export const DISCUSSION_SESSION_COOKIE = "discussion_session";
const SESSION_MAX_AGE_SECONDS = 60 * 60 * 24 * 30;

export const SignedSessionTokenSchema = z
  .string()
  .regex(/^[0-9a-f-]{36}\.[A-Za-z0-9_-]{43}$/u);
export type SignedSessionToken = z.infer<typeof SignedSessionTokenSchema>;

export interface AuthenticatedSession {
  id: string;
  setCookie?: string;
}

function readCookie(request: Request, name: string): string | undefined {
  const cookieHeader = request.headers.get("cookie");
  if (!cookieHeader) return undefined;

  for (const part of cookieHeader.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;

    try {
      return decodeURIComponent(part.slice(separator + 1).trim());
    } catch {
      return undefined;
    }
  }

  return undefined;
}

export class SignedSessionManager {
  private readonly signingKey: string;

  constructor(signingKey: string) {
    this.signingKey = z.string().min(32).parse(signingKey);
  }

  authenticate(request: Request): AuthenticatedSession {
    const token = readCookie(request, DISCUSSION_SESSION_COOKIE);
    const existingSessionId = token ? this.verify(token) : null;

    if (existingSessionId) {
      return { id: existingSessionId };
    }

    const id = randomUUID();
    return {
      id,
      setCookie: this.serializeCookie(this.sign(id), request),
    };
  }

  /** Creates a valid cookie value for transport and ownership tests. */
  createToken(sessionId: string = randomUUID()): SignedSessionToken {
    return this.sign(SessionIdentifierSchema.parse(sessionId));
  }

  private sign(sessionId: string): SignedSessionToken {
    const signature = createHmac("sha256", this.signingKey)
      .update(sessionId)
      .digest("base64url");
    return SignedSessionTokenSchema.parse(`${sessionId}.${signature}`);
  }

  private verify(untrustedToken: string): string | null {
    const parsed = SignedSessionTokenSchema.safeParse(untrustedToken);
    if (!parsed.success) return null;

    const separator = parsed.data.indexOf(".");
    const sessionId = parsed.data.slice(0, separator);
    const signature = parsed.data.slice(separator + 1);
    if (!SessionIdentifierSchema.safeParse(sessionId).success) return null;

    const expected = Buffer.from(
      createHmac("sha256", this.signingKey)
        .update(sessionId)
        .digest("base64url"),
      "ascii",
    );
    const received = Buffer.from(signature, "ascii");
    if (
      expected.length !== received.length ||
      !timingSafeEqual(expected, received)
    ) {
      return null;
    }

    return sessionId;
  }

  private serializeCookie(token: SignedSessionToken, request: Request): string {
    const secure = new URL(request.url).protocol === "https:" ? "; Secure" : "";
    return `${DISCUSSION_SESSION_COOKIE}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${SESSION_MAX_AGE_SECONDS}${secure}`;
  }
}
