export {
  failure,
  type AdapterFailure,
  type AdapterFailureKind,
  type AdapterOutcome,
  type AdapterSuccess,
  type NormalizationFailure,
} from "./failures.js";

export {
  createFetchTransport,
  transportMaxBytes,
  transportTimeoutMs,
  type Transport,
  type TransportRequest,
  type TransportResponse,
  type TransportResult,
} from "./http.js";

export type { AdapterRuntime } from "./runtime.js";

export {
  SEAS5_ADAPTER_VERSION,
  SEAS5_DEFAULT_BASE_URL,
  SEAS5_EXPECTED_MONTHS,
  SEAS5_MONTHLY_FORECAST_DAYS,
  SEAS5_MONTHLY_VARIABLE,
  buildSeas5MonthlyUrl,
  fetchSeas5Monthly,
  type ProviderMonth,
  type Seas5MonthlyConfig,
  type Seas5MonthlyPayload,
} from "./adapters/open-meteo-seasonal.js";

export {
  MONTHLY_NORMALIZER_VERSION,
  SUPPORTED_PRECIPITATION_UNIT,
  normalizeMonthlySeries,
  type NormalizedMonth,
  type NormalizedMonthlySeries,
} from "./normalize/monthly.js";

export {
  SYNTHETIC_GRID_ID,
  SYNTHETIC_GRID_MODEL,
  SYNTHETIC_GRID_PROVIDER,
} from "./grids/synthetic.js";

export { syntheticGridRegistry } from "./grids/registry.js";
