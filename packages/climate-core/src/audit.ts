/**
 * Data-quality audit — Phase 5.8, the two checks §8.8 names.
 *
 * Pure: the caller supplies what it read. Nothing here queries, and nothing here
 * rewrites — an orphan reference is **reported**, not repaired, because a repair
 * would hide which artifact carries it.
 *
 * Two checks, and only two:
 *
 * - **Dangling references.** An artifact that names a forecast run or ingestion run
 *   which does not exist has lost the ability to be reproduced while still claiming
 *   provenance. Reported per artifact, with the offending id.
 * - **Coverage reconciliation.** Expected records versus stored records, keyed by
 *   `(cellKey, variable, validAt)`. What is *expected* is an argument, not a rule
 *   invented here: a daily cell owes one record per variable per day, a seasonal
 *   cell owes one per member per month, and only the caller knows which contract it
 *   asked the provider for. Finding a missing day is arithmetic; deciding a day was
 *   owed is a specification.
 *
 * Duplicates fall out of the same keying, so they are found here rather than in a
 * second pass over the same rows.
 *
 * Not implemented, deliberately: abnormal-value detection (needs per-variable
 * physical bounds that no document states), alerting thresholds, and freshness
 * reporting (which `freshness.ts` already answers for the hours that matter).
 */

/** A reference to a stored record, as the reconciliation needs to see it. */
export interface StoredRecordRef {
  readonly cellKey: string;
  readonly variable: string;
  /** UTC ISO instant the value is valid for. */
  readonly validAt: string;
}

/** An artifact and the run ids it claims. */
export interface ArtifactRunRefs {
  readonly artifact: string;
  readonly artifactId: string;
  readonly forecastRunIds: readonly string[];
  readonly ingestionRunIds: readonly string[];
}

export type AuditFindingCode =
  | "dangling_forecast_run"
  | "dangling_ingestion_run"
  | "missing_record"
  | "duplicate_record"
  | "unexpected_record";

export interface AuditFinding {
  readonly code: AuditFindingCode;
  /** The artifact that made the claim, for the dangling-reference codes. */
  readonly artifactId?: string;
  /** The record or run the finding is about. */
  readonly key: string;
  /** One sentence an operator can act on without reading this module. */
  readonly detail: string;
}

/** The key a record is reconciled on. One string, so a report can be diffed. */
export function recordKey(record: StoredRecordRef): string {
  return `${record.cellKey}|${record.variable}|${record.validAt}`;
}

/**
 * Orphan references, one finding per offending id.
 *
 * Both sides are explicit sets. A missing *set* is not the same as an empty one, so
 * the caller cannot pass `undefined` and get a silent pass — an audit that cannot
 * see the run table must say so by not calling this.
 */
export function auditRunRefs(input: {
  readonly artifacts: readonly ArtifactRunRefs[];
  readonly knownForecastRunIds: ReadonlySet<string>;
  readonly knownIngestionRunIds: ReadonlySet<string>;
}): readonly AuditFinding[] {
  const findings: AuditFinding[] = [];

  for (const artifact of input.artifacts) {
    for (const runId of artifact.forecastRunIds) {
      if (!input.knownForecastRunIds.has(runId)) {
        findings.push({
          code: "dangling_forecast_run",
          artifactId: artifact.artifactId,
          key: runId,
          detail: `${artifact.artifact} names a forecast run that does not exist`,
        });
      }
    }
    for (const runId of artifact.ingestionRunIds) {
      if (!input.knownIngestionRunIds.has(runId)) {
        findings.push({
          code: "dangling_ingestion_run",
          artifactId: artifact.artifactId,
          key: runId,
          detail: `${artifact.artifact} names an ingestion run that does not exist`,
        });
      }
    }
  }

  return findings;
}

export interface CoverageReconciliation {
  readonly expected: number;
  readonly present: number;
  /** Present, but not in the expected set: a stored value nobody asked for. */
  readonly unexpected: number;
  readonly findings: readonly AuditFinding[];
}

/**
 * Expected versus stored, per record key.
 *
 * The counts are reported next to the findings because "98 of 100" and "0 of 100"
 * are different incidents that both produce a missing-record finding.
 */
export function reconcileCoverage(input: {
  readonly expected: readonly StoredRecordRef[];
  readonly present: readonly StoredRecordRef[];
}): CoverageReconciliation {
  const expectedKeys = new Set(input.expected.map(recordKey));
  const seen = new Set<string>();
  const findings: AuditFinding[] = [];
  let unexpected = 0;

  for (const record of input.present) {
    const key = recordKey(record);
    if (seen.has(key)) {
      findings.push({
        code: "duplicate_record",
        key,
        detail: "the same cell, variable and instant is stored more than once",
      });
      continue;
    }
    seen.add(key);
    if (!expectedKeys.has(key)) {
      unexpected += 1;
      findings.push({
        code: "unexpected_record",
        key,
        detail: "stored record was not requested by the expected set",
      });
    }
  }

  for (const key of expectedKeys) {
    if (!seen.has(key)) {
      findings.push({
        code: "missing_record",
        key,
        detail: "expected record was never stored",
      });
    }
  }

  return {
    expected: expectedKeys.size,
    present: seen.size,
    unexpected,
    findings,
  };
}

/**
 * The whole audit as one report.
 *
 * `reconciles` is the single question an operator asks after a scheduled run, and it
 * is derived rather than stored, so it cannot disagree with the findings it sits
 * beside.
 */
export interface ClimateAuditReport {
  readonly refs: readonly AuditFinding[];
  readonly coverage: CoverageReconciliation;
  readonly reconciles: boolean;
}

export function auditClimate(input: {
  readonly artifacts: readonly ArtifactRunRefs[];
  readonly knownForecastRunIds: ReadonlySet<string>;
  readonly knownIngestionRunIds: ReadonlySet<string>;
  readonly expected: readonly StoredRecordRef[];
  readonly present: readonly StoredRecordRef[];
}): ClimateAuditReport {
  const refs = auditRunRefs(input);
  const coverage = reconcileCoverage(input);

  return {
    refs,
    coverage,
    reconciles: refs.length === 0 && coverage.findings.length === 0,
  };
}
