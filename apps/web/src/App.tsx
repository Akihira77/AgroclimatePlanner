import { CONTRACTS_VERSION, weatherDataClassSchema } from "@agroclimate/contracts";

/**
 * Scaffold placeholder. No product UI is implemented in Phase 2.0; this only
 * shows that the web app resolves the shared contracts package at runtime.
 */
export function App() {
  return (
    <main>
      <h1>Agroclimate Planner</h1>
      <p>
        Workspace scaffold. Contracts v{CONTRACTS_VERSION} — {weatherDataClassSchema.options.length}{" "}
        weather data classes available.
      </p>
    </main>
  );
}
