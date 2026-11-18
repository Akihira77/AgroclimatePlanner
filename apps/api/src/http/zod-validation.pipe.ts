import type { ArgumentMetadata, PipeTransform } from "@nestjs/common";
import type { ValidationIssue } from "@agroclimate/contracts";
import {
  isCanonicalArrayIndex,
  isSafeIdentifierSegment,
  MAX_VALIDATION_ISSUES,
  MAX_VALIDATION_PATH_LENGTH,
  VALIDATION_ROOT_PATH,
  VALIDATION_TRUNCATION_MARKER,
} from "@agroclimate/contracts";
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

/**
 * Builds the `details` list: bounded, ordered, and free of submitted values *and*
 * submitted names.
 *
 * A strict object reports every unknown key at once, and those keys are the
 * caller's text — a payload can name a key `password=hunter2`, add a newline, or
 * put a dot where the path syntax puts a separator. Reflecting such a name turns
 * the response into a channel for whatever the caller put in it, so a key that is
 * not a plain identifier is replaced by `[…n]`: the n-th named position of that
 * object, which the caller can still map back to their own payload.
 *
 * The output is not merely "usually safe": `validationDetailsSchema` re-derives
 * the same grammar when the details reach the filter, so a caller that constructs
 * `ValidationFailedException` directly gets the same refusal as one that went
 * through Zod.
 */
export function toIssues(issues: readonly ZodIssue[]): ValidationIssue[] {
  const mapped: ValidationIssue[] = [];

  for (const issue of issues) {
    const chunks = chunksFor(issue.path);

    if (issue.code === "unrecognized_keys") {
      // Sorted so the ordinals depend on the set of keys, not on the order they
      // happened to arrive in.
      const keys = [...issue.keys].sort(compareCodeUnits);

      keys.forEach((key, index) => {
        const appended = isSafeIdentifierSegment(key)
          ? [`${chunks.length === 0 ? "" : "."}${key}`]
          : [`[…${index + 1}]`];

        mapped.push({ path: render([...chunks, ...appended]), issue: issue.code });
      });
      continue;
    }

    mapped.push({ path: render(chunks), issue: issue.code });
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

/**
 * Each segment rendered with the separator it owns, so the join needs no rule
 * beyond concatenation: identifiers carry their `.`, indexes and markers their
 * brackets. An identifier that would be a segment's first chunk carries nothing.
 */
function chunksFor(path: readonly PropertyKey[]): string[] {
  const chunks: string[] = [];
  let unnamed = 0;

  for (const segment of path) {
    if (typeof segment === "number") {
      // Zod puts array indexes here and they are always canonical, but `toIssues`
      // is exported: a negative, fractional, non-finite, or over-long number would
      // otherwise be interpolated into a path the contract must reject. It falls
      // through to the same ordinal marker as an unprintable name.
      if (isCanonicalArrayIndex(segment)) {
        chunks.push(`[${segment}]`);
        continue;
      }

      unnamed += 1;
      chunks.push(`[…${unnamed}]`);
      continue;
    }

    const key = String(segment);
    if (isSafeIdentifierSegment(key)) {
      chunks.push(chunks.length === 0 ? key : `.${key}`);
      continue;
    }

    unnamed += 1;
    chunks.push(`[…${unnamed}]`);
  }

  return chunks;
}

/**
 * Joins the chunks under the contract's length limit, cutting at a segment boundary
 * and saying so with `[…]`.
 *
 * A mid-token cut would leave a value that is neither the path nor a marker, and
 * the contract could not accept it — which mattered the day the schema started
 * enforcing this grammar. Losing the tail of a deeply nested path is acceptable;
 * emitting a path the contract must reject is not.
 */
function render(chunks: readonly string[]): string {
  const capacity = MAX_VALIDATION_PATH_LENGTH - VALIDATION_TRUNCATION_MARKER.length;
  let formatted = "";

  for (const chunk of chunks) {
    if (formatted.length + chunk.length > capacity) {
      return `${formatted}${VALIDATION_TRUNCATION_MARKER}`;
    }
    formatted += chunk;
  }

  return formatted === "" ? VALIDATION_ROOT_PATH : formatted;
}
