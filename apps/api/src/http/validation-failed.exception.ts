import { BadRequestException } from "@nestjs/common";
import type { ValidationIssue } from "@agroclimate/contracts";

/**
 * The only exception whose `details` may reach a client.
 *
 * `BadRequestException` is a public Nest class: any controller, guard, or
 * interceptor can throw one with whatever payload it likes, and the filter cannot
 * tell that payload from validation metadata. A marker type makes the trust
 * explicit — the details are ours, produced by `toIssues` from Zod's issue list,
 * and bounded by `validationIssueSchema`.
 *
 * `api-conventions.md` §3 says `details` is code-owned; this class is how the
 * server knows a producer is the owner of the shape it is claiming.
 */
export class ValidationFailedException extends BadRequestException {
  constructor(readonly issues: readonly ValidationIssue[]) {
    super({ details: issues });
  }
}
