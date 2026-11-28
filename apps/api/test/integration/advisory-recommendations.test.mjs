/**
 * Integration tests for proactive dashboard advisory (`GET /v1/dashboard/advisory`)
 * and 9-crop recommendations + 12-month matrix (`GET /v1/fields/:fieldId/recommendations`).
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";

import {
  SQUARE_JSON,
  apiFor,
  cleanupUsers,
  seedUser as seedFixture,
  startHarness,
  stopHarness,
} from "./support.mjs";

const EMAIL_PREFIX = "advisory-api-";

let harness;
let call;
let alice;
let bob;

const seedUser = (label) => seedFixture(harness.owner, EMAIL_PREFIX, label);

describe("Proactive Advisory & Crop Recommendations (RLS + Scientific Honesty)", () => {
  before(async () => {
    harness = await startHarness();
    ({ call } = apiFor(harness.base));
    await cleanupUsers(harness.owner, EMAIL_PREFIX);
    alice = await seedUser("alice");
    bob = await seedUser("bob");
  });

  after(async () => {
    await cleanupUsers(harness.owner, EMAIL_PREFIX);
    await stopHarness(harness);
  });

  it("requires auth on both endpoints and enforces RLS isolation on recommendations", async () => {
    const anonAdv = await call(alice, "GET", "/v1/dashboard/advisory", { anonymous: true });
    assert.equal(anonAdv.response.status, 401);

    const farm = await call(alice, "POST", "/v1/farms", {
      body: { name: "Kebun Uji Advisory" },
    });
    assert.equal(farm.response.status, 201);

    const field = await call(alice, "POST", "/v1/fields", {
      body: {
        farmId: farm.body.data.id,
        name: "Blok Advisory",
        geometry: JSON.parse(SQUARE_JSON),
      },
    });
    assert.equal(field.response.status, 201);
    const fieldId = field.body.data.id;

    // Cross-tenant RLS: Bob receives 404 on Alice's field recommendations
    const bobRec = await call(bob, "GET", `/v1/fields/${fieldId}/recommendations?horizonMonths=6`);
    assert.equal(bobRec.response.status, 404);

    // Alice gets honest degradation on dashboard advisory when no weather records exist
    const adv = await call(alice, "GET", "/v1/dashboard/advisory");
    assert.equal(adv.response.status, 200);
    assert.ok(adv.body.data.indicativeLabel.includes("Himbauan Indikatif"));
    assert.equal(adv.body.data.fieldWeather.length, 1);
    assert.equal(adv.body.data.fieldWeather[0].hasData, false);
    assert.equal(adv.body.data.fieldWeather[0].totalRainMm, null);

    // Alice gets all 9 catalog crops + 12-month matrix
    const rec = await call(alice, "GET", `/v1/fields/${fieldId}/recommendations?horizonMonths=6`);
    assert.equal(rec.response.status, 200);
    assert.equal(rec.body.data.horizonMonths, 6);
    assert.equal(rec.body.data.months.length, 12);
    assert.ok(rec.body.data.rankings.length >= 9);
    assert.equal(rec.body.data.matrix.length, rec.body.data.rankings.length);
    for (const row of rec.body.data.matrix) {
      assert.equal(row.cells.length, 12);
    }
  });
});
