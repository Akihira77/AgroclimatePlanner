/**
 * Compile-time assertions. Checked by `pnpm typecheck`; not emitted (excluded
 * from the build tsconfig). If one of these stops holding, it is a contract
 * regression, not a style issue.
 */
import type { DerivationDescriptor, FieldSnapshot, FieldSnapshotPayload } from "./provenance.js";
import type { Envelope, ErrorCode, ErrorResponse, NotFoundErrorCode } from "./response.js";
import { notFoundErrorCodeSchema } from "./response.js";
import type { WeatherValue } from "./weather.js";

type Expect<T extends true> = T;
type MutuallyAssignable<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

/** The hash preimage is the persisted row minus the hash itself. */
export type PayloadOmitsHash = Expect<
  MutuallyAssignable<FieldSnapshotPayload, Omit<FieldSnapshot, "fieldSnapshotHash">>
>;

/** Four artifacts, four discriminators. A fifth would fail here. */
export type AllFourArtifacts = Expect<
  MutuallyAssignable<
    DerivationDescriptor["artifact"],
    "monthly_outlook" | "suitability_run" | "planting_window" | "ai_briefing"
  >
>;

type ClimatologyVariant = Extract<WeatherValue, { dataClass: "climatology" }>;
/** Climatology cannot declare a forecast initialization. */
export const climatologyWithInitializedAt: ClimatologyVariant = {
  dataClass: "climatology",
  evaluationBasis: "climatology",
  dataAvailability: "available",
  unit: "mm",
  spatialResolutionKm: 28,
  servedValueIsInterpolated: true,
  freshness: { kind: "source", dataAvailability: "available" },
  attribution: "Copernicus / ECMWF",
  baseline: {
    baselineVersion: "ERA5:1991-2020:v1",
    periodFrom: "1991-01-01",
    periodTo: "2020-12-31",
  },
  // @ts-expect-error — climatology has no initialization; the field is `never`
  initializedAt: "2026-11-18T00:00:00Z",
};

/** A payload-only envelope has no `meta` key at all, not an optional one. */
export type PayloadOnlyEnvelope = Expect<
  MutuallyAssignable<Envelope<{ id: string }>, { data: { id: string } }>
>;

export const envelopeWithUnexpectedMeta: Envelope<{ id: string }> = {
  data: { id: "a" },
  // @ts-expect-error — `meta` is not part of a payload-only envelope
  meta: {},
};

/** Declaring a meta schema makes `meta` required, not merely allowed. */
export type PaginatedEnvelope = Expect<
  MutuallyAssignable<
    Envelope<string[], { page: number }>,
    { data: string[]; meta: { page: number } }
  >
>;

// @ts-expect-error — declaring a meta schema makes `meta` required
export const paginatedEnvelopeWithoutMeta: Envelope<string[], { page: number }> = { data: [] };

/** The two 503s are separate members of the same closed set. */
export const providerUnavailable: ErrorResponse = {
  error: {
    code: "PROVIDER_UNAVAILABLE",
    message: "Penyedia cuaca tidak tersedia.",
    requestId: "018f5b7e-6f3a-7c2b-9d1e-4a5b6c7d8e9f",
  },
};

export const dependencyUnavailable: ErrorResponse = {
  error: {
    code: "DEPENDENCY_UNAVAILABLE",
    message: "Layanan autentikasi tidak tersedia.",
    requestId: "018f5b7e-6f3a-7c2b-9d1e-4a5b6c7d8e9f",
  },
};

/** A singleton code is assignable without parsing: it is a closed literal set. */
export const dependencyCode: ErrorCode = "DEPENDENCY_UNAVAILABLE";

/** A family member is only a code once it has been through the schema. */
export const fieldNotFoundCode: ErrorCode = notFoundErrorCodeSchema.parse("FIELD_NOT_FOUND");

// @ts-expect-error — unvalidated family member: the brand, not the spelling, is the proof
export const unvalidatedNotFoundCode: NotFoundErrorCode = "FIELD_NOT_FOUND";

// @ts-expect-error — a misspelling is not a code
export const misspelledCode: ErrorCode = "FIELD_NOT_FOUDN";

// @ts-expect-error — arbitrary strings are not codes
export const arbitraryCode: ErrorCode = "UNKNOWN_ERROR";

/** An error response carrying a validated family member. */
export const notFoundErrorResponse: ErrorResponse = {
  error: {
    code: notFoundErrorCodeSchema.parse("FIELD_NOT_FOUND"),
    message: "Petak tidak ditemukan.",
    requestId: "018f5b7e-6f3a-7c2b-9d1e-4a5b6c7d8e9f",
  },
};
