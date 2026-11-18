import { describe, expect, it } from "vitest";
import { weatherValueSchema } from "../src/weather.js";

const forecastValue = {
  dataClass: "weather_forecast",
  evaluationBasis: "daily",
  dataAvailability: "available",
  amount: 12.4,
  unit: "mm",
  spatialResolutionKm: 9,
  servedValueIsInterpolated: true,
  freshness: {
    kind: "source",
    dataAvailability: "available",
    initializedAt: "2026-11-18T00:00:00Z",
  },
  attribution: "BMKG",
  source: {
    provider: "open-meteo",
    model: "ecmwf_ifs025",
    forecastRunId: "0192f0aa-0000-7000-8000-000000000001",
    ingestionRunId: "0192f0aa-0000-7000-8000-000000000002",
    initializedAt: "2026-11-18T00:00:00Z",
  },
} as const;

const climatologyValue = {
  dataClass: "climatology",
  evaluationBasis: "climatology",
  dataAvailability: "available",
  amount: 244.2,
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
} as const;

describe("WeatherValue", () => {
  it("accepts a forecast value with full provenance", () => {
    expect(weatherValueSchema.safeParse(forecastValue).success).toBe(true);
  });

  it("accepts a climatology value with a baseline", () => {
    expect(weatherValueSchema.safeParse(climatologyValue).success).toBe(true);
  });

  it("rejects climatology carrying an initializedAt", () => {
    const result = weatherValueSchema.safeParse({
      ...climatologyValue,
      initializedAt: "2026-11-18T00:00:00Z",
    });
    expect(result.success).toBe(false);
  });

  it("rejects climatology carrying forecast source provenance", () => {
    const result = weatherValueSchema.safeParse({
      ...climatologyValue,
      source: forecastValue.source,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown data class", () => {
    expect(weatherValueSchema.safeParse({ ...forecastValue, dataClass: "nowcast" }).success).toBe(
      false,
    );
  });

  it("rejects a missing data class", () => {
    const { dataClass: _omitted, ...withoutClass } = forecastValue;
    expect(weatherValueSchema.safeParse(withoutClass).success).toBe(false);
  });

  it("rejects a fabricated amount on an unavailable value", () => {
    expect(
      weatherValueSchema.safeParse({
        ...forecastValue,
        dataAvailability: "unavailable",
        amount: 0,
      }).success,
    ).toBe(false);
  });

  it("accepts a stale value that still carries an amount", () => {
    expect(
      weatherValueSchema.safeParse({
        ...forecastValue,
        dataAvailability: "stale",
        freshness: {
          kind: "source",
          dataAvailability: "stale",
          reason: "provider_unavailable",
        },
      }).success,
    ).toBe(true);
  });
});
