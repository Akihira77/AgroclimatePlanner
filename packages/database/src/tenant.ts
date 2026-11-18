/**
 * The only way this codebase enters a tenant's data.
 *
 * PostgreSQL enforces isolation through RLS policies that read `app.user_id`
 * (`docs/architecture/system-architecture.md` §RLS). Getting that context wrong
 * is not a bug that shows up in one query: a session-level setting on a pooled
 * connection becomes another request's identity. So the setting is written with
 * `set_config(..., true)` inside an interactive transaction, and the callback
 * receives that transaction's client — not the global one.
 *
 * Why `$queryRaw` and not `$executeRaw`: `set_config` returns a row. A write-path
 * call discards the result, which would turn "the context failed to apply" into
 * "the context silently is not there" — and the policy would then return zero
 * rows instead of failing. Failing closed is right; failing silently is not.
 */
import { AsyncLocalStorage } from "node:async_hooks";

import type { Prisma, PrismaClient } from "./generated/prisma/client.js";

/**
 * Canonical form only. PostgreSQL accepts `{...}` and dash-less input and would
 * happily normalise it, but an id that is canonical in one place and not another
 * is how two representations of the same tenant end up in the same column.
 */
const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class TenantContextError extends Error {
  override readonly name = "TenantContextError";
}

/** The transaction client handed to the callback: Prisma's own, minus lifecycle methods. */
export type TenantTransaction = Prisma.TransactionClient;

export interface TenantScope {
  /**
   * Runs `fn` with `app.user_id` set for the lifetime of one transaction.
   *
   * Nested calls are rejected rather than supported: an inner `withTenant` would
   * open an independent transaction with a different tenant, and with a single
   * connection in the pool it would deadlock waiting for the connection its own
   * caller holds. Internal functions take the `tx` they are given.
   */
  withTenant<T>(userId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T>;
}

/**
 * Tracks the client that currently has a tenant transaction open, per async
 * context — so two concurrent requests never see each other's scope, and a
 * nested call inside one request is detected.
 */
const activeScope = new AsyncLocalStorage<PrismaClient>();

export function normaliseTenantId(userId: string): string {
  if (typeof userId !== "string" || !CANONICAL_UUID.test(userId)) {
    const shown = typeof userId === "string" ? userId.slice(0, 40) : typeof userId;
    throw new TenantContextError(`tenant id must be a canonical UUID, received ${shown}`);
  }
  return userId.toLowerCase();
}

export function createTenantScope(prisma: PrismaClient): TenantScope {
  return {
    async withTenant<T>(userId: string, fn: (tx: TenantTransaction) => Promise<T>): Promise<T> {
      const tenantId = normaliseTenantId(userId);

      if (typeof fn !== "function") {
        throw new TenantContextError("withTenant requires a callback");
      }
      if (activeScope.getStore() === prisma) {
        throw new TenantContextError(
          "withTenant is already active on this client: pass the existing transaction to internal functions instead of opening a nested tenant scope",
        );
      }

      return prisma.$transaction(async (tx) => {
        await tx.$queryRaw`select set_config('app.user_id', ${tenantId}, true)`;
        return activeScope.run(prisma, () => fn(tx));
      });
    },
  };
}
