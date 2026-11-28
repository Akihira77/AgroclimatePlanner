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
  EC46_ADAPTER_VERSION,
  EC46_DAILY_VARIABLE,
  EC46_ENSEMBLE_MEMBERS,
  EC46_FORECAST_DAYS,
  EC46_LAST_LEAD_DAY,
  EC46_MODEL,
  SEAS5_ADAPTER_VERSION,
  SEAS5_DEFAULT_BASE_URL,
  SEAS5_ENSEMBLE_MEMBERS,
  SEAS5_EXPECTED_MONTHS,
  SEAS5_MEMBER_ADAPTER_VERSION,
  SEAS5_MEMBER_DAILY_VARIABLE,
  SEAS5_MONTHLY_FORECAST_DAYS,
  SEAS5_MONTHLY_VARIABLE,
  buildEc46DailyUrl,
  buildSeas5MemberDailyUrl,
  buildSeas5MonthlyUrl,
  fetchEc46Daily,
  fetchSeas5MemberDaily,
  fetchSeas5Monthly,
  seas5MemberWindow,
  type ProviderMonth,
  type Seas5MemberWindow,
  type Seas5MonthlyConfig,
  type Seas5MonthlyPayload,
} from "./adapters/open-meteo-seasonal.js";

export {
  MONTHLY_MEMBER_AGGREGATION_LEVEL,
  MONTHLY_MEMBER_AGGREGATION_VERSION,
  MONTHLY_NORMALIZER_VERSION,
  SUPPORTED_PRECIPITATION_UNIT,
  aggregateMonthlyMemberTotals,
  normalizeMonthlySeries,
  type MonthlyMemberMissingReason,
  type NormalizedMonth,
  type NormalizedMonthlyMemberSeries,
  type NormalizedMonthlyMemberValue,
  type NormalizedMonthlySeries,
} from "./normalize/monthly.js";

export {
  DAILY_ENSEMBLE_ADAPTER_VERSION,
  DAILY_ENSEMBLE_MEMBERS,
  DAILY_ENSEMBLE_MODEL,
  DAILY_FORECAST_ADAPTER_VERSION,
  DAILY_FORECAST_DAYS,
  DAILY_LAST_LEAD_DAY,
  DAILY_VARIABLE,
  ENSEMBLE_DEFAULT_BASE_URL,
  FORECAST_DEFAULT_BASE_URL,
  buildDailyEnsembleUrl,
  buildDailyForecastUrl,
  fetchDailyEnsemble,
  fetchDailyForecast,
  type DailyAdapterConfig,
  type DailyProviderPayload,
  type ProviderDay,
} from "./adapters/open-meteo-daily.js";

export {
  DAILY_NORMALIZER_VERSION,
  SUPPORTED_DAILY_UNIT,
  normalizeDailyPrecipitation,
  type NormalizedDailySeries,
  type NormalizedForecastValue,
} from "./normalize/daily.js";

export {
  ARCHIVE_ADAPTER_VERSION,
  ARCHIVE_DEFAULT_BASE_URL,
  ARCHIVE_EARLIEST_DATE,
  ARCHIVE_MODEL,
  ARCHIVE_PERIOD_FROM,
  ARCHIVE_PERIOD_TO,
  ARCHIVE_UNIT,
  ARCHIVE_VARIABLE,
  archiveDayCount,
  buildArchiveDailyUrl,
  buildArchiveSourceReference,
  fetchArchiveDaily,
  type ArchiveAdapterConfig,
  type ArchiveDailyPayload,
  type ProviderArchiveDay,
} from "./adapters/open-meteo-archive.js";

export {
  SYNTHETIC_GRID_ID,
  SYNTHETIC_GRID_MODEL,
  SYNTHETIC_GRID_PROVIDER,
} from "./grids/synthetic.js";

export {
  ECMWF_IFS025_GRID_ENTRY,
  ECMWF_IFS025_GRID_SPEC,
  ECMWF_IFS025_VALIDATED_GRID_ENTRY,
} from "./grids/ecmwf-ifs025.js";
export { ERA5_GRID_SPEC, ERA5_VALIDATED_GRID_ENTRY } from "./grids/era5.js";
export {
  syntheticGridRegistry,
  unvalidatedGridRegistry,
  validatedOpenMeteoGridRegistry,
} from "./grids/registry.js";
export {
  WeatherLicenseConfigError,
  appendApiKey,
  redactUrlApiKey,
  resolveOpenMeteoLicenseConfig,
  type OpenMeteoLicenseConfig,
  type WeatherProviderLicenseMode,
} from "./license.js";
