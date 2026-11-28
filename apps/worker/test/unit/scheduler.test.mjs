import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  climatologyJobPayloadSchema,
  ingestionJobPayloadSchema,
  outlookAggregationJobPayloadSchema,
} from "@agroclimate/contracts";
import { DEFAULT_BASELINE_VERSION, runSchedulerTick } from "../../dist/scheduler.js";

describe("worker scheduler (OPEN-03 / OPEN-18)", () => {
  it("enqueues climatology once when normals < 12 and skips forecast when fresh today", async () => {
    const enqueued = [];
    const logs = [];
    const db = {
      async $queryRawUnsafe(sql) {
        if (sql.includes("FROM app.outlook_cells")) {
          return [
            {
              id: "cell-1",
              provider: "open-meteo",
              model: "ecmwf_ifs025",
              cellKey: "-6.25,107.75",
              normalsCount: 0,
              activeOutlooks: 0,
              hasTodayForecast: true,
            },
            {
              id: "cell-2",
              provider: "open-meteo",
              model: "ecmwf_seas5",
              cellKey: "-6.25,107.75",
              normalsCount: 0,
              activeOutlooks: 0,
              hasTodayForecast: false,
            },
          ];
        }
        return [{ id: "run-1" }];
      },
    };
    const queue = {
      async enqueue(input) {
        enqueued.push(input);
        return { id: `job-${enqueued.length}`, enqueued: true };
      },
    };

    const summary = await runSchedulerTick({
      db,
      queue,
      log: (event, data) => logs.push({ event, data }),
      now: () => new Date("2026-11-28T06:00:00.000Z"),
    });

    assert.equal(summary.activeCells, 1);
    assert.equal(summary.climatologyEnqueued, 1);
    assert.equal(summary.outlookEnqueued, 0);
    assert.equal(summary.forecastEnqueued, 0);
    assert.equal(summary.seasonalDeferred, 1);
    assert.equal(enqueued[0].kind, "ingest.climate");
    assert.equal(enqueued[0].idempotencyKey, `sched:climatology:${DEFAULT_BASELINE_VERSION}:-6.25,107.75`);
    assert.doesNotThrow(() => climatologyJobPayloadSchema.parse(enqueued[0].payload));
  });

  it("enqueues aggregate outlook and daily forecast when normals exist and forecast is missing", async () => {
    const enqueued = [];
    const db = {
      async $queryRawUnsafe(sql) {
        if (sql.includes("FROM app.outlook_cells")) {
          return [
            {
              id: "cell-1",
              provider: "open-meteo",
              model: "era5",
              cellKey: "-6.75,107.50",
              normalsCount: 12,
              activeOutlooks: 0,
              hasTodayForecast: false,
            },
          ];
        }
        return [{ id: "01900000-0000-7000-8000-000000000001" }];
      },
    };
    const queue = {
      async enqueue(input) {
        enqueued.push(input);
        return { id: `job-${enqueued.length}`, enqueued: true };
      },
    };

    const summary = await runSchedulerTick({
      db,
      queue,
      log: () => {},
      now: () => new Date("2026-11-28T06:00:00.000Z"),
    });

    assert.equal(summary.climatologyEnqueued, 0);
    assert.equal(summary.outlookEnqueued, 1);
    assert.equal(summary.forecastEnqueued, 1);
    assert.deepEqual(
      enqueued.map((j) => j.kind),
      ["aggregate", "ingest.forecast"],
    );
    assert.doesNotThrow(() => outlookAggregationJobPayloadSchema.parse(enqueued[0].payload));
    assert.doesNotThrow(() => ingestionJobPayloadSchema.parse(enqueued[1].payload));
  });
});
