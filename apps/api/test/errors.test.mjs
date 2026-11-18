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
import { ValidationFailedException } from "../dist/http/validation-failed.exception.js";
import { testConfig } from "./helpers.mjs";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DEFAULT_REQUEST_ID = "0b1f5e2a-9d3c-4a5b-8c7d-6e5f4a3b2c1d";

function recordLog() {
  const lines = [];
  return { lines, logger: { error: (message) => lines.push(message) } };
}

function run(exception, requestId = DEFAULT_REQUEST_ID, logger) {
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

  const filter =
    logger === undefined
      ? new ApiExceptionFilter(testConfig(), { error: () => {} })
      : new ApiExceptionFilter(testConfig(), logger);

  filter.catch(exception, host);

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

  it("keeps transport 4xx statuses and documents VALIDATION_FAILED as their code", () => {
    // The contract says the code names the category (the request was unusable)
    // and the status refines it. These three are raised before a handler runs.
    for (const status of [405, 406, 415]) {
      const response = run(new HttpException("transport rejection", status));
      assert.equal(response.statusCode, status);
      assert.equal(response.body.error.code, "VALIDATION_FAILED");
    }
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

  it("forwards details only when they came from the validation pipe", () => {
    const details = [{ path: "items[1].id", issue: "invalid_format" }];
    const trusted = run(new ValidationFailedException(details));
    assert.deepEqual(trusted.body.error.details, details);

    // `BadRequestException` is public API: any thrower can attach any payload, so
    // its `details` is not validation metadata and must not be forwarded.
    const untrusted = run(
      new BadRequestException({ details: [{ path: "password", issue: "hunter2" }] }),
    );
    assert.equal(untrusted.statusCode, 400);
    assert.equal(untrusted.body.error.code, "VALIDATION_FAILED");
    assert.equal("details" in untrusted.body.error, false);
    assert.equal(JSON.stringify(untrusted.body).includes("hunter2"), false);

    const outage = run(new ServiceUnavailableException({ details: [{ internal: true }] }));
    assert.equal("details" in outage.body.error, false);
  });

  it("drops malformed validation metadata instead of forwarding it", () => {
    const cases = [
      // An extra field is how a submitted value would ride along with a diagnosis.
      [{ path: "a", issue: "invalid_type", input: "hunter2" }],
      // The contract bounds path length; the producer is not trusted to respect it.
      [{ path: "x".repeat(500), issue: "invalid_type" }],
      // Not a list at all.
      { path: "a", issue: "invalid_type" },
    ];

    for (const details of cases) {
      const response = run(new ValidationFailedException(details));
      assert.equal(response.statusCode, 400);
      assert.equal(response.body.error.code, "VALIDATION_FAILED");
      assert.equal("details" in response.body.error, false);
      assert.equal(JSON.stringify(response.body).includes("hunter2"), false);
    }
  });

  it("mints a request id when the middleware did not set one, and pins the header", () => {
    const response = run(new Error("boom"), null);
    assert.match(response.body.error.requestId, UUID);
    assert.equal(response.headers["x-request-id"], response.body.error.requestId);
  });
});

describe("exception filter logging", () => {
  it("never writes the exception message, the stack, or a submitted value", () => {
    const error = new Error(
      'relation "app.users" does not exist; postgresql://app_api:hunter2@db/app',
    );
    error.stack =
      "Error: boom\n    at handler (SELECT password_hash FROM app.users WHERE email='a@b.c')";

    const { lines, logger } = recordLog();
    run(error, DEFAULT_REQUEST_ID, logger);

    assert.equal(lines.length, 1, "one line per failure");
    const line = lines[0];

    for (const leak of [
      "hunter2",
      "app.users",
      "password_hash",
      "SELECT",
      "at handler",
      "a@b.c",
      "boom",
    ]) {
      assert.equal(line.includes(leak), false, `logged ${leak}`);
    }

    assert.equal(line.includes(error.message), false);
    assert.equal(error.stack === undefined || line.includes(error.stack), false);
  });

  it("keeps the correlation fields an operator needs", () => {
    const { lines, logger } = recordLog();
    run(new Error("boom"), DEFAULT_REQUEST_ID, logger);

    const line = lines[0];
    assert.equal(line.includes(`requestId=${DEFAULT_REQUEST_ID}`), true);
    assert.equal(line.includes("status=500"), true);
    assert.equal(line.includes("code=INTERNAL_ERROR"), true);
    assert.equal(line.includes("exception=Error"), true);
  });

  it("does not trust the exception name, which is mutable", () => {
    const error = new Error("boom");
    error.name = "SECRET_TOKEN\nstatus=200 exception=Error";

    const { lines, logger } = recordLog();
    run(error, DEFAULT_REQUEST_ID, logger);

    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes("SECRET_TOKEN"), false);
    assert.equal(lines[0].includes("\n"), false);
    assert.equal(lines[0].includes("status=200"), false);
    assert.equal(lines[0].includes("exception=Error"), true);
  });

  it("labels a classified refusal by category, not by class name", () => {
    const { lines, logger } = recordLog();
    run(new ServiceUnavailableException(), DEFAULT_REQUEST_ID, logger);

    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes("exception=HttpException"), true);
    assert.equal(lines[0].includes("ServiceUnavailableException"), false);
  });

  it("labels a non-Error throw without serialising it", () => {
    const { lines, logger } = recordLog();
    run("a thrown string with hunter2 in it", DEFAULT_REQUEST_ID, logger);

    assert.equal(lines.length, 1);
    assert.equal(lines[0].includes("exception=Unknown"), true);
    assert.equal(lines[0].includes("hunter2"), false);
  });

  it("stays silent for a client error", () => {
    const { lines, logger } = recordLog();
    run(new BadRequestException(), DEFAULT_REQUEST_ID, logger);
    assert.equal(lines.length, 0);
  });
});
