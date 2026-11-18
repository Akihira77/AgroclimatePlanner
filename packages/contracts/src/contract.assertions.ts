/**
 * Compile-time assertions. Checked by `pnpm typecheck`; not emitted (excluded
 * from the build tsconfig). If one of these stops holding, it is a contract
 * regression, not a style issue.
 */
import type { DerivationDescriptor, FieldSnapshot, FieldSnapshotPayload } from "./provenance.js";
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
