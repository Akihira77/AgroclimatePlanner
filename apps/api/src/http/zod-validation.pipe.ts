import type { ArgumentMetadata, PipeTransform } from "@nestjs/common";
import { BadRequestException } from "@nestjs/common";
import type { ZodIssue, ZodType } from "zod";
import { z } from "zod";

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

    // `details` is the only place the failure reason goes. The filter forwards it
    // for a 400 and drops it everywhere else, so this cannot become a second way
    // to describe an error.
    throw new BadRequestException({ details: toIssues(result.error.issues) });
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
export interface ValidationIssue {
  readonly path: string;
  readonly issue: string;
}

const ROOT_PATH = "(root)";

export function toIssues(issues: readonly ZodIssue[]): ValidationIssue[] {
  const mapped: ValidationIssue[] = [];

  for (const issue of issues) {
    const path = formatPath(issue.path);

    // One strict-object violation reports every unknown key at once; splitting it
    // keeps one entry per offending path, which is what a client needs to fix it.
    if (issue.code === "unrecognized_keys") {
      for (const key of issue.keys) {
        mapped.push({ path: path === ROOT_PATH ? key : `${path}.${key}`, issue: issue.code });
      }
      continue;
    }

    mapped.push({ path, issue: issue.code });
  }

  // Zod's order follows object key order; sorting makes the response stable
  // regardless of how the schema was assembled.
  return mapped.sort((left, right) =>
    left.path === right.path
      ? left.issue.localeCompare(right.issue)
      : left.path.localeCompare(right.path),
  );
}

function formatPath(path: readonly PropertyKey[]): string {
  let formatted = "";

  for (const segment of path) {
    if (typeof segment === "number") {
      formatted += `[${segment}]`;
      continue;
    }
    formatted = formatted === "" ? String(segment) : `${formatted}.${String(segment)}`;
  }

  return formatted === "" ? ROOT_PATH : formatted;
}
