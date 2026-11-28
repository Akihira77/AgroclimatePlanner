import { describe, expect, it } from "vitest";

import {
  appendApiKey,
  redactUrlApiKey,
  resolveOpenMeteoLicenseConfig,
  WeatherLicenseConfigError,
} from "./license.js";

describe("resolveOpenMeteoLicenseConfig (OPEN-03)", () => {
  it("defaults to non_commercial mode with CC BY 4.0 attribution", () => {
    const cfg = resolveOpenMeteoLicenseConfig({});
    expect(cfg.mode).toBe("non_commercial");
    expect(cfg.apiKey).toBeUndefined();
    expect(cfg.attribution).toContain("Open-Meteo.com");
  });

  it("refuses commercial mode without OPEN_METEO_API_KEY", () => {
    expect(() =>
      resolveOpenMeteoLicenseConfig({ WEATHER_PROVIDER_LICENSE_MODE: "commercial" }),
    ).toThrow(WeatherLicenseConfigError);
  });

  it("accepts commercial mode with API key and custom base URLs", () => {
    const cfg = resolveOpenMeteoLicenseConfig({
      WEATHER_PROVIDER_LICENSE_MODE: "commercial",
      OPEN_METEO_API_KEY: "secret-key-123",
      OPEN_METEO_FORECAST_BASE_URL: "https://customer-api.open-meteo.com",
    });
    expect(cfg.mode).toBe("commercial");
    expect(cfg.apiKey).toBe("secret-key-123");
    expect(cfg.forecastBaseUrl).toBe("https://customer-api.open-meteo.com");
  });

  it("redacts apikey before storing sourceUrl", () => {
    const raw = appendApiKey("https://api.open-meteo.com/v1/forecast?latitude=-6.25", "secret-key");
    expect(raw).toContain("apikey=secret-key");
    const redacted = redactUrlApiKey(raw);
    expect(redacted).not.toContain("secret-key");
    expect(redacted).not.toContain("apikey=");
    expect(redacted).toContain("latitude=-6.25");
  });
});
