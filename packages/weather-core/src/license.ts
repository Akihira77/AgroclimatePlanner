/**
 * Open-Meteo license mode and URL redaction (`OPEN-03`).
 *
 * Deployment may explicitly choose `"non_commercial"` (CC BY 4.0 free tier)
 * or `"commercial"` (paid API key required). Secrets are redacted before any URL
 * is persisted into `sourceUrl` or emitted to logs.
 */

export type WeatherProviderLicenseMode = "non_commercial" | "commercial";

export interface OpenMeteoLicenseConfig {
  readonly mode: WeatherProviderLicenseMode;
  readonly apiKey?: string;
  readonly forecastBaseUrl?: string;
  readonly ensembleBaseUrl?: string;
  readonly archiveBaseUrl?: string;
  readonly seasonalBaseUrl?: string;
  readonly attribution: string;
}

export class WeatherLicenseConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeatherLicenseConfigError";
  }
}

export function resolveOpenMeteoLicenseConfig(
  env: Readonly<Record<string, string | undefined>> = process.env,
): OpenMeteoLicenseConfig {
  const rawMode = (env["WEATHER_PROVIDER_LICENSE_MODE"] ?? "non_commercial").trim();
  if (rawMode !== "non_commercial" && rawMode !== "commercial") {
    throw new WeatherLicenseConfigError(
      `Invalid WEATHER_PROVIDER_LICENSE_MODE="${rawMode}". Expected "non_commercial" or "commercial".`,
    );
  }

  const apiKey = env["OPEN_METEO_API_KEY"]?.trim();
  if (rawMode === "commercial" && (!apiKey || apiKey.length === 0)) {
    throw new WeatherLicenseConfigError(
      "OPEN_METEO_API_KEY is required when WEATHER_PROVIDER_LICENSE_MODE=commercial.",
    );
  }

  const forecastBaseUrl = env["OPEN_METEO_FORECAST_BASE_URL"]?.trim();
  const ensembleBaseUrl = env["OPEN_METEO_ENSEMBLE_BASE_URL"]?.trim();
  const archiveBaseUrl = env["OPEN_METEO_ARCHIVE_BASE_URL"]?.trim();
  const seasonalBaseUrl = env["OPEN_METEO_SEASONAL_BASE_URL"]?.trim();

  const attribution =
    env["OPEN_METEO_ATTRIBUTION"]?.trim() ||
    "Weather data by Open-Meteo.com (CC BY 4.0); ECMWF; Copernicus Climate Change Service";

  return {
    mode: rawMode,
    ...(apiKey && apiKey.length > 0 ? { apiKey } : {}),
    ...(forecastBaseUrl ? { forecastBaseUrl } : {}),
    ...(ensembleBaseUrl ? { ensembleBaseUrl } : {}),
    ...(archiveBaseUrl ? { archiveBaseUrl } : {}),
    ...(seasonalBaseUrl ? { seasonalBaseUrl } : {}),
    attribution,
  };
}

/** Appends `apikey` only for outbound HTTPS requests when configured. */
export function appendApiKey(url: string, apiKey: string | undefined): string {
  if (!apiKey || apiKey.trim().length === 0) return url;
  const parsed = new URL(url);
  parsed.searchParams.set("apikey", apiKey.trim());
  return parsed.toString();
}

/** Strips `apikey` query parameter before persisting `sourceUrl` or logging. */
export function redactUrlApiKey(url: string): string {
  try {
    const parsed = new URL(url);
    parsed.searchParams.delete("apikey");
    return parsed.toString();
  } catch {
    return url.replace(/([?&])apikey=[^&]*/gi, "$1apikey=REDACTED");
  }
}
