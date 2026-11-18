import type { ArgumentMetadata, PipeTransform } from "@nestjs/common";
import type { ValidationIssue } from "@agroclimate/contracts";
import { MAX_VALIDATION_ISSUES, MAX_VALIDATION_PATH_LENGTH } from "@agroclimate/contracts";
import type { ZodIssue, ZodType } from "zod";
import { z } from "zod";

import { ValidationFailedException } from "./validation-failed.exception.js";

/**
 * Request validation for a single parameter boundary, bound to one Zod schema.
 *
 * Deliberately not a global pipe: a global one would have to guess which schema
 * applies to which argument, and a pipe that validates without a schema is a pipe
 * that validates nothing. The schema is named where the input arrives, which is
 * also where a reader looks to find the contract.
 *
 * ```ts
 * @Get()
 * list(@Query(new ZodValidationPipe(listQuerySchema)) query: z.infer<typeof listQuerySchema>) {}
 * ```
 *
 * Zod is the only validation engine in this repository — the same schemas in
 * `packages/contracts` that generate the OpenAPI document validate the request, so
 * the document cannot drift from what the server accepts.
 */
export class ZodValidationPipe<T extends ZodType> implements PipeTransform<unknown, z.infer<T>> {
  constructor(private readonly schema: T) {}

  transform(value: unknown, _metadata: ArgumentMetadata): z.infer<T> {
    const result = this.schema.safeParse(value);
    if (result.success) return result.data;

    // `details` is the only place the failure reason goes, and the exception type
    // is what tells the filter those details are ours rather than a payload some
    // other thrower attached to a 400.
    throw new ValidationFailedException(toIssues(result.error.issues));
  }
}

/**
 * Path and issue code, and nothing else.
 *
 * `issue.message` is excluded even though Zod's own messages are usually safe:
 * they are template text that a custom schema, or a future Zod release, can fill
 * with the submitted value. `issue.input` is excluded for the same reason, and
 * because it is the value itself.
 */
export type { ValidationIssue };

const ROOT_PATH = "(root)";

/**
 * A segment is reflected verbatim only if it cannot be confused with the path
 * syntax: no dot, no bracket, no quote, no control or bidi character, and a
 * bounded length. Everything else becomes a positional marker — see
 * `formatPath`.
 *
 * Unicode letters and digits are allowed because a field name is not the place to
 * force ASCII; the ranges above still exclude every character that could make the
 * path ambiguous or unprintable.
 */
const IDENTIFIER_SEGMENT = /^[\p{L}_][\p{L}\p{N}_]{0,63}$/u;

/**
 * Builds the `details` list: bounded, ordered, and free of submitted values *and*
 * submitted names.
 *
 * A strict object reports every unknown key at once, and those keys are the
 * caller's text — a payload can name a key `password=hunter2`, add a newline, or
 * put a dot where the path syntax puts a separator. Reflecting such a name turns
 * the response into a channel for whatever the caller put in it, so a key that is
 * not a plain identifier is replaced by `[…n]`: the n-th unnamed key of that
 * object, which the caller can still map back to their own payload.
 */
export function toIssues(issues: readonly ZodIssue[]): ValidationIssue[] {
  const mapped: ValidationIssue[] = [];

  for (const issue of issues) {
    if (issue.code === "unrecognized_keys") {
      // Sorted so the ordinals depend on the set of keys, not on the order they
      // happened to arrive in.
      const keys = [...issue.keys].sort(compareCodeUnits);

      keys.forEach((key, index) => {
        mapped.push(
          IDENTIFIER_SEGMENT.test(key)
            ? { path: appendSegment(issue.path, key), issue: issue.code }
            : { path: appendMarker(issue.path, index + 1), issue: issue.code },
        );
      });
      continue;
    }

    mapped.push({ path: bound(formatPath(issue.path)), issue: issue.code });
  }

  // Zod's order follows object key order; sorting makes the response stable
  // regardless of how the schema was assembled. Equal paths fall back to the issue
  // code, and the comparator is code-unit rather than locale-aware.
  mapped.sort(
    (left, right) =>
      compareCodeUnits(left.path, right.path) || compareCodeUnits(left.issue, right.issue),
  );

  return mapped.slice(0, MAX_VALIDATION_ISSUES);
}

/** Locale-independent: `<` on strings compares UTF-16 code units. */
function compareCodeUnits(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function formatPath(path: readonly PropertyKey[]): string {
  let formatted = "";
  let unnamed = 0;

  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
      continue;
    }

    const key = String(segment);
    if (IDENTIFIER_SEGMENT.test(key)) {
      formatted = formatted === "" ? key : `${formatted}.${key}`;
      continue;
    }

    unnamed += 1;
    formatted += `[…${unnamed}]`;
  }

  return formatted === "" ? ROOT_PATH : formatted;
}

function appendSegment(path: readonly PropertyKey[], key: string): string {
  const parent = formatPath(path);
  return bound(parent === ROOT_PATH ? key : `${parent}.${key}`);
}

function appendMarker(path: readonly PropertyKey[], ordinal: number): string {
  const parent = formatPath(path);
  return bound(parent === ROOT_PATH ? `[…${ordinal}]` : `${parent}[…${ordinal}]`);
}

/** Truncation is the last resort, after encoding has removed the dangerous part. */
function bound(path: string): string {
  return path.length <= MAX_VALIDATION_PATH_LENGTH
    ? path
    : `${path.slice(0, MAX_VALIDATION_PATH_LENGTH - 1)}…`;
}
