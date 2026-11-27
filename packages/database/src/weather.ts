/**
 * Forecast persistence — Phase 5.4.
 *
 * Everything here runs on a caller's transaction, and every caller is the
 * handler's T3. Four properties are load-bearing:
 *
 * 1. **One lock order.** Job → IngestionRun → forecast-run advisory → footprint
 *    advisory keys, sorted. The row locks come from
 *    `settlement.lockJobForSettlement` and never move; the advisory keys are
 *    taken afterwards, by `lockForecastWriteScope`.
 * 2. **Two advisory namespaces.** `advisoryLockKeyOf` (one key per forecast run)
 *    and `footprintLockKeyOf` (one key per `(cell_key, variable)`). They are
 *    derived differently so a footprint cannot accidentally be trusted to
 *    serialise a run.
 * 3. **One supersession order.** A row may only be superseded by a row from a
 *    newer ingestion. When the incoming ingestion is the older one, its own
 *    rows are born superseded instead — the newer persisted data stays live.
 * 4. **A horizon made of values.** `horizon_end` is the last instant that
 *    carries a non-null value; a null day is preserved as a row and never
 *    extends the horizon.
 */
import { createHash, randomUUID } from "node:crypto";

import { upsertCell } from "./climate.js";
import { InvariantViolationError } from "./run-errors.js";
import type { TenantTransaction } from "./tenant.js";

/**
 * Advisory-lock key for one forecast run.
 *
 * The last 8 bytes of the UUID are used, split into two signed 32-bit halves.
 * For UUIDv7 that is the random tail rather than the timestamp prefix, so two
 * runs created in the same millisecond do not collide.
 *
 * Collision property: a collision serialises two unrelated forecast runs. It
 * never corrupts data and never deadlocks: the run key is acquired before the
 * footprint set, in that order, by every writer. Widening to `bigint` would not
 * remove the possibility — any finite key collides — so the narrower type is
 * chosen for a signature that exists in every supported PostgreSQL version.
 */
export function advisoryLockKeyOf(forecastRunId: string): readonly [number, number] {
  const hex = forecastRunId.replaceAll("-", "").toLowerCase();
  if (!/^[0-9a-f]{32}$/.test(hex)) {
    throw new InvariantViolationError(`"${forecastRunId}" is not a UUID`);
  }
  const tail = hex.slice(16, 32);
  const first = Number.parseInt(tail.slice(0, 8), 16) | 0;
  const second = Number.parseInt(tail.slice(8, 16), 16) | 0;
  return [first, second];
}

/** Take the per-forecast-run advisory lock. Must run after the job row lock. */
export async function lockForecastRun(tx: TenantTransaction, forecastRunId: string): Promise<void> {
  const [first, second] = advisoryLockKeyOf(forecastRunId);
  // `pg_advisory_xact_lock` returns `void`, which Prisma cannot deserialize, so
  // the lock call is wrapped and only a constant is selected.
  await tx.$queryRaw`
    SELECT 1 AS locked
      FROM (SELECT pg_advisory_xact_lock(${first}::int, ${second}::int)) AS acquired
  `;
}

/**
 * The conflict domain of supersession: one logical value slot.
 *
 * Two writers disagree about a slot exactly when they write the same `cell_key`
 * and `variable` — `valid_at` and `ensemble_member` narrow which rows are
 * replaced, but they are decided *inside* the domain, so a lock keyed on the
 * wider pair cannot miss a conflict and must not be keyed narrower. Keying on
 * `(cell_key, variable, valid_at, member)` would serialise less and would have
 * to acquire one lock per value, which grows with horizon × members instead of
 * with the selector.
 *
 * Granularity consequence: writers of disjoint cells never block each other;
 * writers of the same cell serialise even when their instants do not overlap.
 * That is the intended direction — the cost of over-serialising one cell is a
 * short wait, the cost of under-serialising it is two live rows for one slot.
 */
export function footprintLockKeyOf(cellKey: string, variable: string): readonly [number, number] {
  // A namespace prefix inside the hash preimage keeps the footprint space
  // distinct from `advisoryLockKeyOf`, whose key is a raw UUID tail.
  const digest = createHash("sha256")
    .update(`agroclimate:forecast-footprint:v1\u0000${cellKey}\u0000${variable}`)
    .digest();
  return [digest.readInt32BE(0), digest.readInt32BE(4)];
}

export interface ForecastFootprint {
  readonly cellKey: string;
  readonly variable: string;
}

function compareLockKeys(a: readonly [number, number], b: readonly [number, number]): number {
  return a[0] === b[0] ? a[1] - b[1] : a[0] - b[0];
}

/**
 * Serialise every writer of the given footprints.
 *
 * Keys are de-duplicated, then acquired in ascending numeric order, one
 * statement each. The order is the deadlock defence: a writer holding key 3 and
 * waiting for key 7 can only meet a writer holding 7 and waiting for 3 if one of
 * them acquired out of order, and neither can. `lockForecastRun` is always taken
 * before this set, in every caller, so the run key never participates in a cycle
 * either.
 *
 * Cost: one round trip per distinct `(cellKey, variable)` pair. Selectors are
 * per-cell today (single digits to low tens), so this is a handful of local
 * statements inside a transaction that already has a 10 s statement bound. A
 * selector in the hundreds would want a single server-side loop over the sorted
 * set; the ordering contract above is what makes that swap safe.
 *
 * Collisions are possible (2^-32 per pair) and harmless: two unrelated
 * footprints sharing a key serialise each other for the duration of one
 * transaction. They never let two writers of the *same* footprint through,
 * because the derivation is a pure function of the same two strings.
 */
export async function lockForecastFootprint(
  tx: TenantTransaction,
  footprints: readonly ForecastFootprint[],
): Promise<void> {
  const keys = new Map<string, readonly [number, number]>();
  for (const footprint of footprints) {
    const key = footprintLockKeyOf(footprint.cellKey, footprint.variable);
    keys.set(`${key[0]}:${key[1]}`, key);
  }

  for (const [first, second] of [...keys.values()].sort(compareLockKeys)) {
    await tx.$queryRaw`
      SELECT 1 AS locked
        FROM (SELECT pg_advisory_xact_lock(${first}::int, ${second}::int)) AS acquired
    `;
  }
}

/**
 * The one way to take the write locks for a forecast ingest.
 *
 * Order: run key, then the footprint set. `revalidateLease` belongs *after*
 * this call and before `persistForecastRun`: these waits can be long, and the
 * lease that looked healthy before them is not evidence afterwards.
 */
export async function lockForecastWriteScope(
  tx: TenantTransaction,
  input: { readonly forecastRunId: string; readonly footprints: readonly ForecastFootprint[] },
): Promise<void> {
  await lockForecastRun(tx, input.forecastRunId);
  await lockForecastFootprint(tx, input.footprints);
}

/**
 * Transaction-local bounds.
 *
 * `set_config(..., true)` is used instead of `SET LOCAL` because it accepts
 * bound parameters and cannot be built by string concatenation. It must be the
 * first statement of the transaction: `lock_timeout` cannot bound a lock wait
 * that has already started.
 *
 * `transaction_timeout` is deliberately absent: the setting does not exist
 * before PostgreSQL 17, is not provisioned for these roles, and is not claimed
 * here. The remaining bound is the client-side transaction timeout, which is
 * greater than every value set here.
 */
export async function configureTransactionTimeouts(
  tx: TenantTransaction,
  options: { readonly lockTimeoutMs: number; readonly statementTimeoutMs: number },
): Promise<void> {
  await tx.$queryRaw`
    SELECT set_config('lock_timeout', ${String(options.lockTimeoutMs)}, true),
           set_config('statement_timeout', ${String(options.statementTimeoutMs)}, true)
  `;
}

export class ProviderCoordinateDriftError extends Error {
  override readonly name = "ProviderCoordinateDriftError";

  constructor(
    readonly provider: string,
    readonly model: string,
    readonly cellKey: string,
  ) {
    super(
      `provider "${provider}" model "${model}" moved the served coordinate for cell "${cellKey}" beyond 1e-6 degrees`,
    );
  }
}

export interface ForecastCell {
  readonly cellKey: string;
  readonly servedLat: number;
  readonly servedLon: number;
  readonly spatialResolutionKm: number | null;
}

const COORDINATE_TOLERANCE_DEGREES = 1e-6;

/**
 * Create the `outlook_cells` identity row if needed and record the provider's
 * served coordinate.
 *
 * A served coordinate that moves is not a rounding difference: it means the
 * provider re-gridded, so values are no longer comparable across runs. That is
 * a terminal `provider_changed` for the whole ingest, not a per-cell warning.
 * The caller maps `ProviderCoordinateDriftError` to that outcome.
 */
export async function resolveForecastCells(
  tx: TenantTransaction,
  input: {
    readonly provider: string;
    readonly model: string;
    readonly cells: readonly ForecastCell[];
  },
): Promise<Map<string, string>> {
  const ids = new Map<string, string>();

  for (const cell of input.cells) {
    const id = await upsertCell(tx, {
      provider: input.provider,
      model: input.model,
      cellKey: cell.cellKey,
    });
    ids.set(cell.cellKey, id);
  }

  const cellKeys = input.cells.map((cell) => cell.cellKey);
  const existing = await tx.$queryRaw<
    { id: string; cellKey: string; servedLat: number | null; servedLon: number | null }[]
  >`
    SELECT id::text AS "id",
           cell_key  AS "cellKey",
           served_lat AS "servedLat",
           served_lon AS "servedLon"
      FROM app.outlook_cells
     WHERE provider = ${input.provider}
       AND model = ${input.model}
       AND cell_key = ANY(${cellKeys}::text[])
       FOR UPDATE
  `;

  const byKey = new Map(existing.map((row) => [row.cellKey, row]));
  for (const cell of input.cells) {
    const row = byKey.get(cell.cellKey);
    if (row === undefined) {
      throw new InvariantViolationError(
        `outlook cell ${input.provider}/${input.model}/${cell.cellKey} was upserted but could not be read back`,
      );
    }
    if (row.servedLat !== null && row.servedLon !== null) {
      const movedLat = Math.abs(row.servedLat - cell.servedLat) > COORDINATE_TOLERANCE_DEGREES;
      const movedLon = Math.abs(row.servedLon - cell.servedLon) > COORDINATE_TOLERANCE_DEGREES;
      if (movedLat || movedLon) {
        throw new ProviderCoordinateDriftError(input.provider, input.model, cell.cellKey);
      }
    }
  }

  await tx.$queryRaw`
    UPDATE app.outlook_cells AS c
       SET served_lat           = v.served_lat,
           served_lon           = v.served_lon,
           spatial_resolution_km = v.spatial_resolution_km,
           served_updated_at    = now()
      FROM jsonb_to_recordset(${JSON.stringify(
        input.cells.map((cell) => ({
          cell_key: cell.cellKey,
          served_lat: cell.servedLat,
          served_lon: cell.servedLon,
          spatial_resolution_km: cell.spatialResolutionKm,
        })),
      )}::jsonb)
        AS v(cell_key text, served_lat double precision, served_lon double precision,
             spatial_resolution_km double precision)
     WHERE c.provider = ${input.provider}
       AND c.model = ${input.model}
       AND c.cell_key = v.cell_key
  `;

  return ids;
}

export interface ForecastRecordInput {
  readonly cellKey: string;
  readonly variable: string;
  readonly unit: string;
  readonly validAt: Date;
  readonly value: number | null;
  readonly temporalResolution: string | null;
  readonly ensembleMember: number | null;
  readonly ensembleSize: number | null;
  readonly aggregationLevel: string | null;
  readonly requestedLat: number;
  readonly requestedLon: number;
  readonly servedLat: number;
  readonly servedLon: number;
  readonly servedValueIsInterpolated: boolean;
  readonly spatialResolutionKm: number | null;
  readonly sourceUrl: string | null;
  readonly attribution: string | null;
  /**
   * Overrides `PersistForecastRunInput.normalizerVersion` for this row only.
   *
   * A row's `normalizer_version` names the transformation that produced it. Most
   * records come straight out of the ingestion's normalizer, so the run-level
   * value is right; a row produced by a separate, versioned derived step (the
   * SEAS5 per-member monthly aggregate) names that step instead, so a stored
   * aggregate remains traceable to the algorithm that computed it. Omitted means
   * "use the run's value".
   */
  readonly normalizerVersion?: string;
}

export interface PersistForecastRunInput {
  readonly forecastRunId: string;
  readonly ingestionRunId: string;
  readonly provider: string;
  readonly model: string;
  /**
   * Storage vocabulary (`forecast_runs_product_check`), not a provider's.
   * `seasonal` covers both EC46 and SEAS5: the model, not the product, is what
   * distinguishes them.
   */
  readonly product: "forecast" | "ensemble" | "seasonal";
  /**
   * Only the classes `weather_records_data_class_check` permits for a forecast
   * plane write. Climatology is not one of them: it is a baseline.
   */
  readonly dataClass: "weather_forecast" | "subseasonal_forecast" | "seasonal_forecast";
  readonly initializedAt: Date;
  /** The ingestion's own start instant: the tiebreak when the run is the same. */
  readonly ingestionCreatedAt: Date;
  readonly normalizerVersion: string;
  readonly records: readonly ForecastRecordInput[];
}

export interface PersistForecastRunResult {
  readonly inserted: number;
  readonly superseded: number;
  readonly bornSuperseded: number;
  readonly horizonEnd: Date;
}

/** `null` member is a real key component, not "missing". */
function recordKeyOf(
  cellKey: string,
  variable: string,
  validAt: string,
  member: number | null,
): string {
  return `${cellKey}\u0000${variable}\u0000${validAt}\u0000${member === null ? "null" : String(member)}`;
}

/**
 * Persist one ingestion's records, extending the horizon and reconciling
 * supersession in both directions.
 *
 * **Precondition:** the caller holds `lockForecastWriteScope` for
 * `forecastRunId` and this ingestion's footprints, and has revalidated its
 * lease after that acquisition. The locks are what make the reads below
 * meaningful: a writer of an overlapping footprint from a *different* forecast
 * run is excluded, so the pre-read and the last-moment recheck see committed
 * truth rather than racing uncommitted rows.
 *
 * The horizon is computed from records that carry a value. A null day is still
 * persisted — it is evidence that the provider has no value there — but it is
 * not evidence of coverage, so it must not extend `horizon_end`.
 */
export async function persistForecastRun(
  tx: TenantTransaction,
  input: PersistForecastRunInput,
): Promise<PersistForecastRunResult> {
  if (input.records.length === 0) {
    throw new InvariantViolationError("an ingestion must persist at least one record");
  }

  const cells = dedupeCells(input.records);
  const cellIds = await resolveForecastCells(tx, {
    provider: input.provider,
    model: input.model,
    cells,
  });

  const incomingJson = JSON.stringify(
    input.records.map((record) => ({
      cell_key: record.cellKey,
      variable: record.variable,
      valid_at: record.validAt.toISOString(),
      ensemble_member: record.ensembleMember,
    })),
  );

  // Who already outranks me, read *before* the insert. A same-run predecessor
  // cannot be inserted over (the live key includes `forecast_run_id`), so its
  // replacement id has to be decided now.
  const outranking = await tx.$queryRaw<
    {
      cellKey: string;
      variable: string;
      validAt: Date;
      ensembleMember: number | null;
      newerId: string;
    }[]
  >`
    WITH incoming AS (
      SELECT cell_key, variable, valid_at::timestamptz AS valid_at, ensemble_member
        FROM jsonb_to_recordset(${incomingJson}::jsonb)
          AS r(cell_key text, variable text, valid_at text, ensemble_member int)
    )
    SELECT DISTINCT ON (i.cell_key, i.variable, i.valid_at, i.ensemble_member)
           i.cell_key                    AS "cellKey",
           i.variable,
           i.valid_at                    AS "validAt",
           i.ensemble_member             AS "ensembleMember",
           n.id::text                    AS "newerId"
      FROM incoming i
      JOIN app.weather_records n
        ON n.cell_key = i.cell_key
       AND n.variable = i.variable
       AND n.valid_at = i.valid_at
       AND n.ensemble_member IS NOT DISTINCT FROM i.ensemble_member
       AND n.superseded_at IS NULL
      JOIN app.forecast_runs nf ON nf.id = n.forecast_run_id
      JOIN app.ingestion_runs ni ON ni.id = n.ingestion_run_id
     WHERE (n.forecast_run_id <> ${input.forecastRunId}::uuid
            AND nf.initialized_at > ${input.initializedAt})
        OR (n.forecast_run_id = ${input.forecastRunId}::uuid
            AND ni.created_at > ${input.ingestionCreatedAt})
     ORDER BY i.cell_key, i.variable, i.valid_at, i.ensemble_member,
              nf.initialized_at DESC, ni.created_at DESC
  `;

  const bornSuperseded = new Map(
    outranking.map((row) => [
      recordKeyOf(row.cellKey, row.variable, row.validAt.toISOString(), row.ensembleMember),
      row.newerId,
    ]),
  );

  const rows = input.records.map((record) => {
    const newId = randomUUID();
    const supersededBy = bornSuperseded.get(
      recordKeyOf(
        record.cellKey,
        record.variable,
        record.validAt.toISOString(),
        record.ensembleMember,
      ),
    );
    return {
      new_id: newId,
      cell_key: record.cellKey,
      variable: record.variable,
      valid_at: record.validAt.toISOString(),
      ensemble_member: record.ensembleMember,
      outlook_cell_id: cellIds.get(record.cellKey) ?? "",
      value: record.value,
      unit: record.unit,
      temporal_resolution: record.temporalResolution,
      ensemble_size: record.ensembleSize,
      aggregation_level: record.aggregationLevel,
      requested_lat: record.requestedLat,
      requested_lon: record.requestedLon,
      served_lat: record.servedLat,
      served_lon: record.servedLon,
      served_value_is_interpolated: record.servedValueIsInterpolated,
      spatial_resolution_km: record.spatialResolutionKm,
      source_url: record.sourceUrl,
      attribution: record.attribution,
      normalizer_version: record.normalizerVersion ?? input.normalizerVersion,
      superseded: supersededBy !== undefined,
      superseded_by_id: supersededBy ?? null,
    };
  });

  for (const row of rows) {
    if (row.outlook_cell_id === "") {
      throw new InvariantViolationError(`no outlook cell id for "${row.cell_key}"`);
    }
  }

  const rowsJson = JSON.stringify(rows);

  // 1. Supersede every live row this ingestion outranks. Runs before the insert
  //    because `weather_records_live_key` includes `forecast_run_id`: a
  //    re-normalisation of the same run would otherwise collide with itself.
  //    The replacement id is minted above, so the FK is named before the row
  //    exists; the constraint is deferred to COMMIT for exactly that reason.
  const replaced = await tx.$queryRaw<{ oldId: string; newId: string }[]>`
    WITH incoming AS (
      SELECT cell_key, variable, valid_at::timestamptz AS valid_at,
             ensemble_member, new_id::uuid AS new_id
        FROM jsonb_to_recordset(${rowsJson}::jsonb)
          AS r(new_id text, cell_key text, variable text, valid_at text, ensemble_member int)
    ),
    stale AS (
      SELECT e.id AS existing_id, i.new_id
        FROM incoming i
        JOIN app.weather_records e
          ON e.cell_key = i.cell_key
         AND e.variable = i.variable
         AND e.valid_at = i.valid_at
         AND e.ensemble_member IS NOT DISTINCT FROM i.ensemble_member
         AND e.superseded_at IS NULL
        JOIN app.forecast_runs ef ON ef.id = e.forecast_run_id
        JOIN app.ingestion_runs ei ON ei.id = e.ingestion_run_id
       WHERE (e.forecast_run_id <> ${input.forecastRunId}::uuid
              AND ef.initialized_at < ${input.initializedAt})
          OR (e.forecast_run_id = ${input.forecastRunId}::uuid
              AND ei.created_at < ${input.ingestionCreatedAt})
    )
    UPDATE app.weather_records w
       SET superseded_by_id = s.new_id,
           superseded_at    = now()
      FROM stale s
     WHERE w.id = s.existing_id
    RETURNING w.id::text AS "oldId", s.new_id::text AS "newId"
  `;

  // 2. Insert. `superseded_at` is written for rows a newer persisted ingestion
  //    already outranks, so an older run committing late never becomes live.
  const inserted = await tx.$queryRaw<{ id: string }[]>`
    INSERT INTO app.weather_records (
      id, forecast_run_id, ingestion_run_id, outlook_cell_id, cell_key, provider, model,
      data_class, variable, value, unit, valid_at, initialized_at,
      requested_lat, requested_lon, served_lat, served_lon,
      served_value_is_interpolated, spatial_resolution_km, temporal_resolution,
      ensemble_member, ensemble_size, aggregation_level, source_url, attribution,
      normalizer_version, supersedes_id, superseded_by_id, superseded_at
    )
    SELECT r.new_id::uuid, ${input.forecastRunId}::uuid, ${input.ingestionRunId}::uuid,
           r.outlook_cell_id::uuid, r.cell_key, ${input.provider}, ${input.model},
           ${input.dataClass}, r.variable, r.value, r.unit, r.valid_at::timestamptz,
           ${input.initializedAt}, r.requested_lat, r.requested_lon, r.served_lat,
           r.served_lon, r.served_value_is_interpolated, r.spatial_resolution_km,
           r.temporal_resolution, r.ensemble_member, r.ensemble_size,
           r.aggregation_level, r.source_url, r.attribution, r.normalizer_version,
           NULL,
           CASE WHEN r.superseded THEN r.superseded_by_id::uuid ELSE NULL END,
           CASE WHEN r.superseded THEN now() ELSE NULL END
      FROM jsonb_to_recordset(${rowsJson}::jsonb)
        AS r(new_id text, outlook_cell_id text, cell_key text, variable text,
             value double precision, unit text, valid_at text,
             requested_lat double precision, requested_lon double precision,
             served_lat double precision, served_lon double precision,
             served_value_is_interpolated boolean, spatial_resolution_km double precision,
             temporal_resolution text, ensemble_member int, ensemble_size int,
             aggregation_level text, source_url text, attribution text,
             normalizer_version text,
             superseded boolean, superseded_by_id text)
    RETURNING id::text AS "id"
  `;

  // 3. Record the backwards link. One row can be replaced by several older runs
  //    at once; `supersedes_id` holds one of them by id order and the rest stay
  //    visible from `superseded_by_id`. No ordering is claimed for the pair.
  if (replaced.length > 0) {
    await tx.$queryRaw`
      UPDATE app.weather_records w
         SET supersedes_id = x.old_id::uuid
        FROM (
          SELECT DISTINCT ON (p.new_id) p.new_id, p.old_id
            FROM jsonb_to_recordset(${JSON.stringify(replaced)}::jsonb)
              AS p(new_id text, old_id text)
           ORDER BY p.new_id, p.old_id
        ) x
       WHERE w.id = x.new_id::uuid
         AND w.supersedes_id IS NULL
    `;
  }

  // 4. Last-moment recheck for a newer run that committed between the read above
  //    and this statement. Only live rows are considered: born-superseded rows
  //    are already out of the way.
  const outranked = await tx.$queryRaw<{ id: string }[]>`
    UPDATE app.weather_records w
       SET superseded_by_id = x.newer_id,
           superseded_at    = now()
      FROM (
        SELECT DISTINCT ON (m.id) m.id AS mine_id, n.id AS newer_id
          FROM app.weather_records m
          JOIN app.weather_records n
            ON n.cell_key = m.cell_key
           AND n.variable = m.variable
           AND n.valid_at = m.valid_at
           AND n.ensemble_member IS NOT DISTINCT FROM m.ensemble_member
           AND n.superseded_at IS NULL
           AND n.id <> m.id
          JOIN app.forecast_runs nf ON nf.id = n.forecast_run_id
          JOIN app.ingestion_runs ni ON ni.id = n.ingestion_run_id
         WHERE m.ingestion_run_id = ${input.ingestionRunId}::uuid
           AND m.superseded_at IS NULL
           AND ((n.forecast_run_id <> ${input.forecastRunId}::uuid
                 AND nf.initialized_at > ${input.initializedAt})
             OR (n.forecast_run_id = ${input.forecastRunId}::uuid
                 AND ni.created_at > ${input.ingestionCreatedAt}))
         ORDER BY m.id, nf.initialized_at DESC, ni.created_at DESC
      ) x
     WHERE w.id = x.mine_id
    RETURNING w.id::text AS "id"
  `;

  // 5. Extend the horizon with the last instant that actually carries a value.
  //    Never shrink it: `GREATEST` keeps an older ingestion from pulling it back,
  //    and an all-null ingestion does not touch it at all.
  const horizonEnd = await extendHorizon(tx, input);

  return {
    inserted: inserted.length,
    superseded: replaced.length,
    // Rows born superseded, plus any the last-moment recheck caught.
    bornSuperseded: bornSuperseded.size + outranked.length,
    horizonEnd,
  };
}

/**
 * Advance `horizon_end` to the last non-null instant, or leave it alone.
 *
 * The single statement is safe against a missing run: it raises the invariant
 * instead of returning a partial write. When every record is null there is
 * nothing to advance, so the current value is read and returned — an all-null
 * ingestion still persists its rows, it just claims no horizon.
 */
async function extendHorizon(tx: TenantTransaction, input: PersistForecastRunInput): Promise<Date> {
  const latest = latestNonNullValidAt(input.records);

  if (latest === null) {
    const current = await tx.$queryRaw<{ horizonEnd: Date }[]>`
      SELECT horizon_end AS "horizonEnd"
        FROM app.forecast_runs
       WHERE id = ${input.forecastRunId}::uuid
    `;
    const horizonEnd = current[0]?.horizonEnd;
    if (horizonEnd === undefined) {
      throw new InvariantViolationError(`forecast run ${input.forecastRunId} does not exist`);
    }
    return horizonEnd;
  }

  const horizon = await tx.$queryRaw<{ horizonEnd: Date }[]>`
    UPDATE app.forecast_runs
       SET horizon_end = GREATEST(horizon_end, ${latest}::timestamptz)
     WHERE id = ${input.forecastRunId}::uuid
    RETURNING horizon_end AS "horizonEnd"
  `;
  const horizonEnd = horizon[0]?.horizonEnd;
  if (horizonEnd === undefined) {
    throw new InvariantViolationError(`forecast run ${input.forecastRunId} does not exist`);
  }
  return horizonEnd;
}

/**
 * The last instant a record actually describes. `null` means the ingestion
 * carried no values at all — not that it carried nothing.
 */
function latestNonNullValidAt(records: readonly ForecastRecordInput[]): Date | null {
  let latest: Date | null = null;
  for (const record of records) {
    if (record.value === null) continue;
    if (latest === null || record.validAt.getTime() > latest.getTime()) latest = record.validAt;
  }
  return latest;
}

/** One identity row per `(cellKey, served coordinate)`; records repeat cells. */
function dedupeCells(records: readonly ForecastRecordInput[]): readonly ForecastCell[] {
  const seen = new Map<string, ForecastCell>();
  for (const record of records) {
    if (seen.has(record.cellKey)) continue;
    seen.set(record.cellKey, {
      cellKey: record.cellKey,
      servedLat: record.servedLat,
      servedLon: record.servedLon,
      spatialResolutionKm: record.spatialResolutionKm,
    });
  }
  return [...seen.values()];
}

/**
 * Re-validate the lease after the advisory wait (D10/R10).
 *
 * The advisory lock can be held by another ingestion for seconds; the predicate
 * that was true when the job row was locked may not be true now.
 */
export async function revalidateLease(
  tx: TenantTransaction,
  input: { readonly jobId: string; readonly leaseToken: string; readonly minRemainingMs: number },
): Promise<boolean> {
  const rows = await tx.$queryRaw<{ ok: boolean }[]>`
    SELECT (status = 'running'
            AND lease_token = ${input.leaseToken}::uuid
            AND lease_expires_at > now()
            AND lease_expires_at - now() >= (${input.minRemainingMs}::int * interval '1 millisecond'))
           AS ok
      FROM app.jobs
     WHERE id = ${input.jobId}::uuid
  `;
  return rows[0]?.ok === true;
}

/**
 * The live daily precipitation rows for one cell, over the 0–45 day window
 * (Priority 2 read model, `loadActiveDailyRecords`).
 *
 * Read-only and tenant-scoped like every other read. It mirrors
 * `loadActiveOutlookMonths`' shape for the same reason: the cell is addressed by
 * `(provider, model, cell_key)` through `app.outlook_cells`, so a `cell_key` that
 * exists on two grids cannot be merged. `superseded_at IS NULL` is the only
 * liveness marker this table has, and `ensemble_member IS NULL` keeps one value
 * per day: a 50-member spread is not a served value.
 *
 * `from`/`to` are UTC ISO instants from `dailyHorizonWindow`, half-open. The
 * caller's window is the assembler's window, so a row cannot be fetched and then
 * silently dropped as out of horizon.
 */
export interface ActiveDailyRecord {
  readonly validAt: string;
  readonly value: number | null;
  readonly unit: string;
  readonly dataClass: string;
  readonly provider: string;
  readonly model: string;
  readonly initializedAt: string;
  readonly temporalResolution: string | null;
  readonly aggregationLevel: string | null;
  readonly ensembleMember: number | null;
}

export async function loadActiveDailyRecords(
  tx: TenantTransaction,
  input: {
    readonly provider: string;
    readonly model: string;
    readonly cellKey: string;
    /** Inclusive start instant, UTC ISO. */
    readonly from: string;
    /** Exclusive end instant, UTC ISO. */
    readonly to: string;
  },
): Promise<readonly ActiveDailyRecord[]> {
  return tx.$queryRaw<ActiveDailyRecord[]>`
    SELECT to_char(w.valid_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "validAt",
           w.value,
           w.unit,
           w.data_class                            AS "dataClass",
           w.provider,
           w.model,
           to_char(w.initialized_at AT TIME ZONE 'UTC',
                   'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') AS "initializedAt",
           w.temporal_resolution                    AS "temporalResolution",
           w.aggregation_level                      AS "aggregationLevel",
           w.ensemble_member                        AS "ensembleMember"
      FROM app.outlook_cells c
      JOIN app.weather_records w ON w.outlook_cell_id = c.id
     WHERE c.provider = ${input.provider}
       AND c.model = ${input.model}
       AND c.cell_key = ${input.cellKey}
       AND w.variable = 'precipitation'
       AND w.superseded_at IS NULL
       AND w.ensemble_member IS NULL
       AND w.valid_at >= ${input.from}::timestamptz
       AND w.valid_at < ${input.to}::timestamptz
     ORDER BY w.valid_at
  `;
}
