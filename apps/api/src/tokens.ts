/**
 * Injection tokens. Symbols rather than strings so a typo is a compile error and
 * two modules cannot accidentally share a provider name.
 */
export const APP_CONFIG = Symbol("APP_CONFIG");
export const DATABASE_CLIENT = Symbol("DATABASE_CLIENT");
