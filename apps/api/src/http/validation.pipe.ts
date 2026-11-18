import { BadRequestException, ValidationPipe } from "@nestjs/common";
import type { ValidationError } from "class-validator";

/**
 * A validation issue carries the offending path and the failed constraint name —
 * never the submitted value. `value: false` on the pipe is what keeps
 * class-validator from formatting the value into its message, so `details` cannot
 * echo a password because someone sent a string where a number belonged.
 */
export interface ValidationIssue {
  readonly path: string;
  readonly issue: string;
}

export function createValidationPipe(): ValidationPipe {
  return new ValidationPipe({
    // Unknown properties are rejected, not stripped: a client that sends
    // `isAdmin` should be told, once, rather than have it silently disappear.
    whitelist: true,
    forbidNonWhitelisted: true,
    transform: true,
    // `"3"` stays a string unless a DTO asks for a number. Implicit conversion
    // turns a typo in a query parameter into a silently wrong value.
    transformOptions: { enableImplicitConversion: false },
    validationError: { target: false, value: false },
    exceptionFactory: (errors: ValidationError[]) =>
      new BadRequestException({ details: flatten(errors) }),
  });
}

function flatten(errors: readonly ValidationError[], prefix = ""): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  for (const error of errors) {
    const path = prefix === "" ? error.property : `${prefix}.${error.property}`;
    const constraints = error.constraints ?? {};
    const names = Object.keys(constraints).sort();
    for (const name of names) issues.push({ path, issue: name });

    if (error.children !== undefined && error.children.length > 0) {
      issues.push(...flatten(error.children, path));
    }
  }

  return issues;
}
