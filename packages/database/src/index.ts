/**
 * Database access. Phase 2.2.1 exposed the client factory; Phase 2.2.3 adds the
 * one entry point through which tenant-owned data may be read or written.
 *
 * The generated client lives in `src/generated/prisma` and is rebuilt by
 * `pnpm build` before `tsc` runs. It is not committed.
 */
import { PrismaPg } from "@prisma/adapter-pg";

import { PrismaClient } from "./generated/prisma/client.js";

export { PrismaClient } from "./generated/prisma/client.js";
export { Prisma } from "./generated/prisma/client.js";
export {
  EMAIL_UNIQUE_CONSTRAINT,
  EmailAlreadyRegisteredError,
  findAuthUserByEmail,
  insertRegisteredUser,
  isEmailUniqueViolation,
} from "./auth-registration.js";
export type { AuthUserRecord, RegisteredUser } from "./auth-registration.js";
export { insertSession, resolveSession, revokeSession } from "./auth-sessions.js";
export type {
  ActiveSession,
  IssuedSession,
  SessionOutcome,
  SessionResolution,
} from "./auth-sessions.js";
export { readSessionCsrfToken, resolveSessionCsrfToken } from "./auth-csrf.js";
export { createFarm, findFarm, listFarms, softDeleteFarm, updateFarm } from "./farms.js";
export {
  findCropBySlug,
  findProfileVersion,
  listCrops,
  listCultivars,
  listProfileVersionsForCrop,
} from "./crops.js";
export type {
  ConstraintRow,
  CropProfileVersionRow,
  CropProfileVersionSummaryRow,
  CropRow,
  CultivarRow,
  GrowthStageRow,
  SourceRefRow,
} from "./crops.js";
export type {
  Farm,
  FarmCreate,
  FarmDeleteOutcome,
  FarmListOptions,
  FarmPage,
  FarmSort,
  FarmUpdate,
} from "./farms.js";
export {
  createField,
  FieldGeometryError,
  findField,
  listAllFields,
  listFields,
  selectFieldAnchor,
  softDeleteField,
  updateField,
} from "./fields.js";
export type {
  Field,
  FieldAnchor,
  FieldCreate,
  FieldListOptions,
  FieldPage,
  FieldSort,
  FieldUpdate,
  PolygonGeometry,
} from "./fields.js";
export {
  beginIngestionExecution,
  markIngestionStatus,
  OutlookCellIdentityError,
  upsertCell,
  upsertForecastRun,
} from "./climate.js";
export type {
  BeginIngestionExecutionInput,
  ForecastRunRecord,
  IngestionExecution,
  IngestionOutcome,
  NewForecastRun,
  OutlookCellIdentity,
  SqlExecutor,
  TerminalIngestionStatus,
} from "./climate.js";
export {
  IngestionAlreadyOwnedError,
  IngestionRunMissingError,
  IngestionTerminalError,
  InvariantViolationError,
  isCheckViolation,
  isTransientTransactionError,
  isUniqueViolationOn,
  JobRetryExhaustedError,
  LeaseLostError,
  PG_CHECK_VIOLATION,
  PG_DEADLOCK_DETECTED,
  PG_FOREIGN_KEY_VIOLATION,
  PG_NOT_NULL_VIOLATION,
  PG_SERIALIZATION_FAILURE,
  PG_UNIQUE_VIOLATION,
  pgErrorInfo,
  TransientTransactionError,
} from "./run-errors.js";
export { createTenantScope, normaliseTenantId, TenantContextError } from "./tenant.js";
export type { TenantScope, TenantTransaction } from "./tenant.js";
export {
  advisoryLockKeyOf,
  configureTransactionTimeouts,
  footprintLockKeyOf,
  lockForecastFootprint,
  loadActiveDailyRecords,
  lockForecastRun,
  lockForecastWriteScope,
  persistForecastRun,
  ProviderCoordinateDriftError,
  resolveForecastCells,
  revalidateLease,
} from "./weather.js";
export type {
  ActiveDailyRecord,
  ForecastCell,
  ForecastFootprint,
  ForecastRecordInput,
  PersistForecastRunInput,
  PersistForecastRunResult,
} from "./weather.js";
export {
  InconsistentSettlementError,
  JobMissingError,
  lockJobForSettlement,
  settlePair,
  settlePairAsWorker,
} from "./settlement.js";
export type {
  SettlementAuthority,
  SettlementMode,
  SettlementOutcome,
  SettlementRequest,
} from "./settlement.js";
export {
  ClimatologyConflictError,
  ClimatologySourceConflictError,
  persistClimatologyBaseline,
} from "./climatology.js";
export type {
  ClimatologyCellInput,
  ClimatologyNormalInput,
  ClimatologySourceMetadata,
  PersistClimatologyBaselineInput,
  PersistClimatologyBaselineResult,
} from "./climatology.js";
export {
  findOutlookCellId,
  loadActiveOutlookMonths,
  loadClimatologyOutlookSource,
  loadSeasonalForecastRun,
  loadSeasonalMemberPopulation,
  OutlookBaselineNotFoundError,
  OutlookCellNotFoundError,
  persistClimatologyOutlook,
  persistSeasonalOutlook,
} from "./outlook.js";
export type {
  ActiveOutlookMonthRow,
  ActiveOutlookMonths,
  ClimatologyOutlookMonthRow,
  ClimatologyOutlookSource,
  LoadSeasonalPopulationInput,
  PersistClimatologyOutlookInput,
  PersistClimatologyOutlookOptions,
  PersistClimatologyOutlookResult,
  PersistSeasonalOutlookInput,
  PersistSeasonalOutlookResult,
  SeasonalForecastRun,
  SeasonalMemberPopulation,
  SeasonalOutlookMonthRow,
  SeasonalPopulationOutcome,
} from "./outlook.js";

export interface DatabaseOptions {
  /** `postgresql://…` connection string. Validated by `pg`, not by us. */
  readonly connectionString: string;
  /**
   * Pool size. Only the connection-reuse tests set this — `1` forces every
   * transaction onto the same physical connection, which is the condition under
   * which a leaked `app.user_id` would actually cross tenants.
   */
  readonly poolMax?: number;
}

/**
 * Prisma 7 talks to PostgreSQL through a driver adapter; there is no bundled
 * query engine. That also means connection pooling is `pg`'s Pool.
 *
 * This factory is the *runtime* identity. It must never be handed
 * `MIGRATION_DATABASE_URL`: migrations connect as the schema owner, and the
 * runtime roles are the ones the RLS policies are written against.
 */
export function createPrismaClient(options: DatabaseOptions): PrismaClient {
  const adapter = new PrismaPg({
    connectionString: options.connectionString,
    ...(options.poolMax === undefined ? {} : { max: options.poolMax }),
  });
  return new PrismaClient({ adapter });
}
