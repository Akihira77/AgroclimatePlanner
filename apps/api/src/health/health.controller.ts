import { Controller, Get } from "@nestjs/common";
import { CONTRACTS_VERSION, weatherDataClassSchema } from "@agroclimate/contracts";

interface HealthResponse {
  status: "ok";
  contractsVersion: string;
  dataClassCount: number;
}

@Controller("health")
export class HealthController {
  /**
   * The handler deliberately loads a runtime value from `@agroclimate/contracts`.
   * A type-only import would prove nothing about workspace resolution.
   */
  @Get()
  check(): HealthResponse {
    return {
      status: "ok",
      contractsVersion: CONTRACTS_VERSION,
      dataClassCount: weatherDataClassSchema.options.length,
    };
  }
}
