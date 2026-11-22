/**
 * Injection tokens. Symbols rather than strings so a typo is a compile error and
 * two modules cannot accidentally share a provider name.
 */
export const APP_CONFIG = Symbol("APP_CONFIG");
export const DATABASE_CLIENT = Symbol("DATABASE_CLIENT");
/**
 * The `app_auth` pool. A separate token, not a second name for
 * `DATABASE_CLIENT`: injecting the wrong one has to be a wiring error, and the
 * two clients must never be substitutable.
 */
export const AUTH_DATABASE_CLIENT = Symbol("AUTH_DATABASE_CLIENT");
/** Argon2id hashing, configured once from `RuntimeConfig.passwordHashing`. */
export const PASSWORD_HASHER = Symbol("PASSWORD_HASHER");
/** The in-process fixed-window limiter (`IG-7`). */
export const AUTH_RATE_LIMITER = Symbol("AUTH_RATE_LIMITER");
/**
 * The grid registry the resolution route selects a spec from.
 *
 * A token rather than a direct import so a test can supply an isolated registry
 * without editing the production one — and so there is exactly one place where
 * "which registry does this process use" is answered.
 */
export const GRID_REGISTRY = Symbol("GRID_REGISTRY");
