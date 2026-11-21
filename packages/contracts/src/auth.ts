import { z } from "zod";

/**
 * Authentication request contracts (S7), `docs/architecture/api-conventions.md`
 * §8.1 and owner decisions `IG-1`/`IG-2`/`IG-4` in
 * `docs/review/phase-3.2-s7-owner-decisions.md`.
 *
 * Registration is the only endpoint here. Login joins in S8 and reuses
 * `normalizeEmail` and `passwordSchema` through `loginRequestSchema`; this module
 * is the one place the email rule and the password rule are written, so the two
 * endpoints cannot diverge.
 */

/**
 * `IG-1`: one function, `trim()` then `toLowerCase()`, used by registration and
 * (later) login. The database unique constraint stays case-sensitive; the
 * normalisation is an application invariant, deliberately not a `citext` column
 * or a functional index.
 *
 * Unicode normalisation is **not** applied. It is not in the decision, and
 * applying it here would silently change which addresses collide.
 */
export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * The email schema normalises before validating, so `"  A@B.example "` is
 * accepted and stored as `a@b.example`. `.pipe` rather than `.transform` after
 * `z.email()` because the check must see the value that will be stored.
 */
export const emailSchema = z.string().transform(normalizeEmail).pipe(z.email().max(254));

/** `IG-4`: minimum counted in Unicode code points, maximum in UTF-8 bytes. */
export const PASSWORD_MIN_CODE_POINTS = 12;
export const PASSWORD_MAX_UTF8_BYTES = 1024;

/**
 * Counts Unicode code points, not UTF-16 code units. An astral character is two
 * code units and one code point, and `String.length` would count it twice.
 *
 * A grapheme cluster (`e` + combining acute) counts as two code points. That is
 * the approved rule; grapheme semantics are explicitly not approved.
 */
export function countCodePoints(value: string): number {
  let count = 0;
  // Iterating a string yields code points, so a surrogate pair is one step.
  for (const _character of value) count += 1;
  return count;
}

/**
 * UTF-8 byte length. `Buffer.byteLength` encodes to UTF-8, so a 1025-byte
 * password made of three-byte characters is rejected even though it has fewer
 * than 1024 characters.
 */
export function passwordByteLength(value: string): number {
  return Buffer.byteLength(value, "utf8");
}

/**
 * `IG-4` requires that an unpaired surrogate be a `400`, not something repaired.
 *
 * `Buffer.from` substitutes `U+FFFD` for a lone surrogate, so hashing such a
 * string would hash bytes that are not the bytes the caller supplied — a direct
 * contradiction of "hashed exactly as supplied".
 */
export function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index);

    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
      continue;
    }

    if (unit >= 0xdc00 && unit <= 0xdfff) return true;
  }

  return false;
}

/**
 * The password rule. No trimming, no normalisation, no truncation: the value is
 * hashed exactly as it arrives, so every check here is a rejection, never a
 * repair.
 */
export const passwordSchema = z.string().superRefine((password, context) => {
  if (hasUnpairedSurrogate(password)) {
    context.addIssue({
      code: "custom",
      message: "password contains an unpaired surrogate",
    });
    return;
  }

  if (passwordByteLength(password) > PASSWORD_MAX_UTF8_BYTES) {
    context.addIssue({
      code: "custom",
      message: `password exceeds ${PASSWORD_MAX_UTF8_BYTES} UTF-8 bytes`,
    });
    return;
  }

  if (countCodePoints(password) < PASSWORD_MIN_CODE_POINTS) {
    context.addIssue({
      code: "custom",
      message: `password must be at least ${PASSWORD_MIN_CODE_POINTS} characters`,
    });
  }
});

/**
 * `IG-2` relies on unknown keys being a `400`: a caller cannot smuggle a `role`,
 * `locale`, or `id` into an insert by adding it to the body.
 */
export const registerRequestSchema = z.strictObject({
  email: emailSchema,
  password: passwordSchema,
});
export type RegisterRequest = z.infer<typeof registerRequestSchema>;

/**
 * The login password rule deliberately does **not** reuse `passwordSchema`.
 *
 * The minimum length is a registration policy, not an input shape: applying it
 * here would answer a too-short password with `400` and a wrong one with `401`,
 * so the failure a caller sees would depend on the password they submitted. Login
 * has one public failure (`401 UNAUTHENTICATED`), and it is reached by verifying,
 * not by validating. The upper bound and the surrogate rule stay, because those
 * describe bytes that cannot be hashed as supplied, and they bound the work a
 * request may trigger.
 */
export const loginPasswordSchema = z
  .string()
  .min(1)
  .superRefine((password, context) => {
    if (hasUnpairedSurrogate(password)) {
      context.addIssue({ code: "custom", message: "password contains an unpaired surrogate" });
      return;
    }

    if (passwordByteLength(password) > PASSWORD_MAX_UTF8_BYTES) {
      context.addIssue({
        code: "custom",
        message: `password exceeds ${PASSWORD_MAX_UTF8_BYTES} UTF-8 bytes`,
      });
    }
  });

/** Same email rule and same normalisation as registration (`IG-1`). */
export const loginRequestSchema = z.strictObject({
  email: emailSchema,
  password: loginPasswordSchema,
});
export type LoginRequest = z.infer<typeof loginRequestSchema>;

/**
 * The safe registration response (`H-1`). `createdAt` is absent because the
 * `app_auth` grant does not include `created_at`; widening the grant to return it
 * is explicitly forbidden.
 */
export const registeredUserSchema = z.strictObject({
  id: z.uuid(),
  email: z.email(),
  role: z.string().min(1),
  locale: z.string().min(1),
  timezone: z.string().min(1),
});
export type RegisteredUser = z.infer<typeof registeredUserSchema>;
