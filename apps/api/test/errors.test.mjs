import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  BadRequestException,
  ConflictException,
  HttpException,
  NotFoundException,
  ServiceUnavailableException,
  UnauthorizedException,
} from "@nestjs/common";
import { errorResponseSchema } from "@agroclimate/contracts";

import { ApiExceptionFilter } from "../dist/http/api-exception.filter.js";
import { testConfig } from "./helpers.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function run(exception, requestId = "0b1f5e2a-9d3c-4a5b-8c7d-6e5f4a3b2c1d") {
  // `null` means "the middleware never ran", so the property is absent rather
  // than undefined.
  const request = requestId === null ? {} : { requestId };
  const response = {
    statusCode: undefined,
    headers: {},
    body: undefined,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(body) {
      this.body = body;
      return this;
    },
    setHeader(name, value) {
      this.headers[name.toLowerCase()] = value;
    },
  };

  const host = {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  };

  new ApiExceptionFilter(testConfig()).catch(exception, host);

  assert.equal(
    errorResponseSchema.safeParse(response.body).success,
    true,
    JSON.stringify(response.body),
  );
  assert.match(response.body.error.requestId, UUID);
  return response;
}

describe("exception filter", () => {
  it("maps recognised exceptions to the documented code", () => {
    assert.equal(run(new UnauthorizedException()).body.error.code, "UNAUTHENTICATED");
    assert.equal(run(new ConflictException()).body.error.code, "CONFLICT");
    assert.equal(run(new BadRequestException()).body.error.code, "VALIDATION_FAILED");
  });

  it("gives a 404 a not-found code from the branded family", () => {
    const generic = run(new NotFoundException());
    assert.equal(generic.statusCode, 404);
    assert.equal(generic.body.error.code, "RESOURCE_NOT_FOUND");

    const specific = run(new NotFoundException({ code: "FIELD_NOT_FOUND" }));
    assert.equal(specific.statusCode, 404);
    assert.equal(specific.body.error.code, "FIELD_NOT_FOUND");
  });

  it("keeps the two 503s distinct", () => {
    const dependency = run(new ServiceUnavailableException());
    assert.equal(dependency.statusCode, 503);
    assert.equal(dependency.body.error.code, "DEPENDENCY_UNAVAILABLE");

    const provider = run(new ServiceUnavailableException({ code: "PROVIDER_UNAVAILABLE" }));
    assert.equal(provider.statusCode, 503);
    assert.equal(provider.body.error.code, "PROVIDER_UNAVAILABLE");
  });

  it("ignores a code outside the contract", () => {
    const response = run(new ServiceUnavailableException({ code: "MADE_UP_CODE" }));
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.error.code, "DEPENDENCY_UNAVAILABLE");
  });

  it("ignores a code that contradicts the status it was thrown with", () => {
    const response = run(new HttpException({ code: "INTERNAL_ERROR" }, 409));
    assert.equal(response.statusCode, 409);
    assert.equal(response.body.error.code, "CONFLICT");
  });

  it("fails closed on an unexpected error and leaks nothing", () => {
    const error = new Error(
      'relation "app.users" does not exist; connection postgresql://app_api:hunter2@db/app',
    );
    error.stack = "at handler (SELECT password_hash FROM app.users)";

    const response = run(error);
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.error.code, "INTERNAL_ERROR");

    const serialised = JSON.stringify(response.body);
    for (const leak of ["hunter2", "app.users", "password_hash", "SELECT", "at handler"]) {
      assert.equal(serialised.includes(leak), false, `leaked ${leak}`);
    }
  });

  it("fails closed on a status the contract does not define", () => {
    const response = run(new HttpException({ detail: "teapot" }, 418));
    assert.equal(response.statusCode, 500);
    assert.equal(response.body.error.code, "INTERNAL_ERROR");
    assert.equal(JSON.stringify(response.body).includes("teapot"), false);
  });

  it("passes structured validation details through, and only for 400", () => {
    const details = [{ path: "isAdmin", issue: "whitelistValidation" }];
    const validation = run(new BadRequestException({ details }));
    assert.deepEqual(validation.body.error.details, details);

    const outage = run(new ServiceUnavailableException({ details: [{ internal: true }] }));
    assert.equal("details" in outage.body.error, false);
  });

  it("mints a request id when the middleware did not set one, and pins the header", () => {
    const response = run(new Error("boom"), null);
    assert.match(response.body.error.requestId, UUID);
    assert.equal(response.headers["x-request-id"], response.body.error.requestId);
  });
});
