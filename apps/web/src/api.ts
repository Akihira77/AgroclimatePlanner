import type {
  AiBriefing,
  BriefingGenerateRequest,
  ClimateDailyOutlook,
  ClimateOutlook,
  CropCycle,
  CropDetail,
  CropList,
  CropProfileVersion,
  CsrfTokenResponse,
  DashboardAdvisory,
  Farm,
  Field,
  FieldAgronomyProfile,
  FieldAgronomyUpdateRequest,
  FieldEvaluateRequest,
  FieldObservation,
  FieldObservationCreateRequest,
  FieldRecommendations,
  Harvest,
  HarvestCreateRequest,
  HarvestListMeta,
  PageMeta,
  Planting,
  PlantingCreateRequest,
  PlantingListQuery,
  PlantingStatus,
  PlantingWindow,
  PlantingWindowListQuery,
  RegisteredUser,
  SuitabilityRunWithWindows,
} from "@agroclimate/contracts";

/**
 * The browser's only door to the API.
 *
 * One base URL, one error type, one CSRF cache. Nothing here retries a request
 * except the CSRF refresh, and that retry happens once: a token is per session and
 * per issuance, so a second 403 after a fresh token is a real refusal, not a stale
 * value.
 *
 * The session cookie is `HttpOnly`; this client never sees it. Every request
 * therefore sets `credentials: "include"`. In development the Vite proxy answers
 * `/v1` on the app's own origin, so the cookie is same-site and no CORS response is
 * needed; a deployment serving the two apart sets `VITE_API_BASE_URL` and admits
 * the origin through `CORS_ORIGINS`.
 */

const configured = import.meta.env["VITE_API_BASE_URL"];
export const API_BASE = (
  configured ?? (import.meta.env.DEV ? "/v1" : "http://localhost:3000/v1")
).replace(/\/$/, "");

export interface ApiFailure {
  readonly code: string;
  readonly message: string;
  readonly details?: readonly { path: string; issue: string }[];
  readonly requestId?: string;
}

export class ApiError extends Error {
  readonly status: number;
  readonly code: string;
  readonly details: ApiFailure["details"];
  readonly requestId: string | undefined;

  constructor(status: number, failure: ApiFailure) {
    super(failure.message);
    this.name = "ApiError";
    this.status = status;
    this.code = failure.code;
    this.details = failure.details;
    this.requestId = failure.requestId;
  }

  /** A 401 means "no usable session", never "wrong password" on an authenticated route. */
  get isUnauthenticated(): boolean {
    return this.status === 401;
  }
}

let csrfToken: string | null = null;

async function fetchCsrfToken(): Promise<string> {
  const response = await fetch(`${API_BASE}/auth/csrf`, {
    credentials: "include",
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await toError(response);
  const body = (await response.json()) as { data: CsrfTokenResponse };
  csrfToken = body.data.token;
  return body.data.token;
}

export function forgetCsrfToken(): void {
  csrfToken = null;
}

async function toError(response: Response): Promise<ApiError> {
  let failure: ApiFailure = { code: "UNKNOWN", message: `HTTP ${response.status}` };
  const requestId = response.headers.get("X-Request-Id") ?? undefined;
  try {
    const body = (await response.json()) as { error?: Partial<ApiFailure> };
    if (body.error?.code !== undefined && body.error.message !== undefined) {
      failure = {
        code: body.error.code,
        message: body.error.message,
        ...(body.error.details === undefined ? {} : { details: body.error.details }),
        ...(requestId === undefined ? {} : { requestId }),
      };
    }
  } catch {
    // A non-JSON error body is still an error. The status line is all we know, but
    // the request id came from a header and survives: a proxy's HTML page is
    // exactly the failure an operator needs to correlate.
  }
  return new ApiError(response.status, {
    ...failure,
    ...(requestId === undefined ? {} : { requestId }),
  });
}

interface RequestOptions {
  readonly method?: "GET" | "POST" | "PATCH" | "DELETE";
  readonly body?: unknown;
  /** Set for the two auth calls that must not touch the CSRF cache. */
  readonly skipCsrf?: boolean;
}

async function send(path: string, options: RequestOptions = {}): Promise<Response> {
  const method = options.method ?? "GET";
  const headers: Record<string, string> = { Accept: "application/json" };

  if (options.body !== undefined) headers["Content-Type"] = "application/json";

  const needsCsrf = method !== "GET" && options.skipCsrf !== true;
  if (needsCsrf) headers["X-CSRF-Token"] = csrfToken ?? (await fetchCsrfToken());

  return fetch(`${API_BASE}${path}`, {
    method,
    credentials: "include",
    headers,
    ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
  });
}

/**
 * Called when an authenticated request answers `401` mid-session. `/auth/*` is
 * excluded on purpose: a wrong password is also a `401`, and it is not a lost
 * session. Without this, a page renders "Sesi berakhir" over a shell that still
 * believes it is signed in, and a reload is the only way out.
 */
let sessionLost: (() => void) | null = null;

export function onSessionLost(handler: (() => void) | null): void {
  sessionLost = handler;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response = await send(path, options);

  // One retry, and only for a mutation: a session that predates this tab carries a
  // token this tab never saw. GET never sends one, so a 403 there is not ours to fix.
  if (response.status === 403 && (options.method ?? "GET") !== "GET") {
    forgetCsrfToken();
    response = await send(path, options);
  }

  if (response.status === 401 && !path.startsWith("/auth/")) sessionLost?.();

  if (!response.ok) throw await toError(response);
  if (response.status === 204) return undefined as T;
  return (await response.json()) as T;
}

const query = (params: Record<string, string | number | undefined>): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) search.set(key, String(value));
  }
  const encoded = search.toString();
  return encoded === "" ? "" : `?${encoded}`;
};

/** A guard against a server that never runs out of pages. See `allPages`. */
const MAX_PAGES = 50;

/**
 * Every page, not the first one.
 *
 * `pageSize` is capped at 100 by the server, so a single request is a truncation,
 * and a truncated list rendered as a total is a lie: farm 101 would simply stop
 * existing on screen. The loop stops at `total`, which the server counts under
 * the same predicates as the page.
 *
 * `MAX_PAGES` is a guard, not a limit anyone should reach: `total` comes from the
 * server, and a proxy returning a constant non-empty page with a large `total`
 * would otherwise spin forever. Fifty pages is 5 000 rows — past any v1 account.
 */
async function allPages<T>(
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const body = await request<{ data: T[]; meta: PageMeta }>(
      `${path}${query({ ...params, page, pageSize: 100 })}`,
    );
    items.push(...body.data);
    if (body.data.length === 0 || items.length >= body.meta.total) return items;
  }
  // Returning a prefix here would be the same lie the loop exists to avoid.
  throw new Error(`list at ${path} exceeded ${MAX_PAGES} pages; refusing to render a prefix`);
}

export const api = {
  async register(email: string, password: string): Promise<RegisteredUser> {
    const body = await request<{ data: RegisteredUser }>("/auth/register", {
      method: "POST",
      body: { email, password },
      skipCsrf: true,
    });
    return body.data;
  },

  async login(email: string, password: string): Promise<RegisteredUser> {
    forgetCsrfToken();
    const body = await request<{ data: RegisteredUser }>("/auth/login", {
      method: "POST",
      body: { email, password },
      skipCsrf: true,
    });
    return body.data;
  },

  async logout(): Promise<void> {
    await request<void>("/auth/logout", { method: "POST", skipCsrf: true });
    forgetCsrfToken();
  },

  async deleteAccount(): Promise<void> {
    await request<void>("/auth/account", { method: "DELETE" });
    forgetCsrfToken();
  },

  async changePassword(currentPassword: string, newPassword: string): Promise<void> {
    await request<void>("/auth/password", {
      method: "POST",
      body: { currentPassword, newPassword },
    });
  },

  async me(): Promise<RegisteredUser> {
    const body = await request<{ data: RegisteredUser }>("/auth/me");
    return body.data;
  },

  async listFarms(): Promise<Farm[]> {
    return allPages<Farm>("/farms", {});
  },

  async updateFarm(farmId: string, body: { name?: string; region?: string | null }): Promise<Farm> {
    const response = await request<{ data: Farm }>(`/farms/${encodeURIComponent(farmId)}`, {
      method: "PATCH",
      body,
    });
    return response.data;
  },

  async deleteFarm(farmId: string): Promise<void> {
    await request<void>(`/farms/${encodeURIComponent(farmId)}`, { method: "DELETE" });
  },

  async createFarm(name: string, region: string | null): Promise<Farm> {
    const body = await request<{ data: Farm }>("/farms", {
      method: "POST",
      body: { name, region },
    });
    return body.data;
  },

  async listFields(farmId?: string): Promise<Field[]> {
    return allPages<Field>("/fields", { farmId });
  },

  async createField(farmId: string, name: string, geometry: Field["geometry"]): Promise<Field> {
    const body = await request<{ data: Field }>("/fields", {
      method: "POST",
      body: { farmId, name, geometry },
    });
    return body.data;
  },

  async updateField(
    fieldId: string,
    body: { name?: string; geometry?: Field["geometry"] },
  ): Promise<Field> {
    const response = await request<{ data: Field }>(`/fields/${encodeURIComponent(fieldId)}`, {
      method: "PATCH",
      body,
    });
    return response.data;
  },

  async deleteField(fieldId: string): Promise<void> {
    await request<void>(`/fields/${encodeURIComponent(fieldId)}`, { method: "DELETE" });
  },

  async getFieldAgronomy(fieldId: string): Promise<FieldAgronomyProfile> {
    const body = await request<{ data: FieldAgronomyProfile }>(
      `/fields/${encodeURIComponent(fieldId)}/agronomy`,
    );
    return body.data;
  },

  async updateFieldAgronomy(
    fieldId: string,
    payload: FieldAgronomyUpdateRequest,
  ): Promise<FieldAgronomyProfile> {
    const body = await request<{ data: FieldAgronomyProfile }>(
      `/fields/${encodeURIComponent(fieldId)}/agronomy`,
      {
        method: "PATCH",
        body: payload,
      },
    );
    return body.data;
  },

  async listCrops(): Promise<CropList> {
    const body = await request<{ data: CropList }>("/crops");
    return body.data;
  },

  async cropDetail(slug: string): Promise<CropDetail> {
    const body = await request<{ data: CropDetail }>(`/crops/${encodeURIComponent(slug)}`);
    return body.data;
  },

  async profileVersion(id: string): Promise<CropProfileVersion> {
    const body = await request<{ data: CropProfileVersion }>(
      `/crop-profiles/${encodeURIComponent(id)}`,
    );
    return body.data;
  },

  /**
   * The version's stages placed on the calendar. The date travels as a plain
   * `YYYY-MM-DD` because a cycle boundary is a calendar day; sending an instant
   * would make the answer depend on the browser's time zone.
   */
  async cropCycle(profileVersionId: string, cycleStartDate: string): Promise<CropCycle> {
    const body = await request<{ data: CropCycle }>(
      `/crop-profiles/${encodeURIComponent(profileVersionId)}/cycle?cycleStartDate=${encodeURIComponent(cycleStartDate)}`,
    );
    return body.data;
  },

  async outlook(fieldId: string, provider: string, model: string): Promise<ClimateOutlook> {
    const body = await request<{ data: ClimateOutlook }>(
      `/climate/outlook${query({ fieldId, provider, model })}`,
    );
    return body.data;
  },

  async forecast(fieldId: string, provider: string, model: string): Promise<ClimateDailyOutlook> {
    const body = await request<{ data: ClimateDailyOutlook }>(
      `/climate/forecast${query({ fieldId, provider, model })}`,
    );
    return body.data;
  },

  async listPlantings(filters: PlantingListQuery = {}): Promise<Planting[]> {
    const body = await request<{ data: Planting[] }>(
      `/plantings${query({ fieldId: filters.fieldId, status: filters.status })}`,
    );
    return body.data;
  },

  async createPlanting(payload: PlantingCreateRequest): Promise<Planting> {
    const body = await request<{ data: Planting }>("/plantings", {
      method: "POST",
      body: payload,
    });
    return body.data;
  },

  async updatePlantingStatus(plantingId: string, status: PlantingStatus): Promise<Planting> {
    const body = await request<{ data: Planting }>(`/plantings/${encodeURIComponent(plantingId)}`, {
      method: "PATCH",
      body: { status },
    });
    return body.data;
  },

  async listHarvests(plantingId: string): Promise<{ data: Harvest[]; meta: HarvestListMeta }> {
    return request<{ data: Harvest[]; meta: HarvestListMeta }>(
      `/plantings/${encodeURIComponent(plantingId)}/harvests`,
    );
  },

  async createHarvest(plantingId: string, payload: HarvestCreateRequest): Promise<Harvest> {
    const body = await request<{ data: Harvest }>(
      `/plantings/${encodeURIComponent(plantingId)}/harvests`,
      {
        method: "POST",
        body: payload,
      },
    );
    return body.data;
  },

  async listFieldObservations(fieldId: string): Promise<FieldObservation[]> {
    const body = await request<{ data: FieldObservation[] }>(
      `/fields/${encodeURIComponent(fieldId)}/observations`,
    );
    return body.data;
  },

  async createFieldObservation(
    fieldId: string,
    payload: FieldObservationCreateRequest,
  ): Promise<FieldObservation> {
    const body = await request<{ data: FieldObservation }>(
      `/fields/${encodeURIComponent(fieldId)}/observations`,
      {
        method: "POST",
        body: payload,
      },
    );
    return body.data;
  },

  async evaluateField(
    fieldId: string,
    payload: FieldEvaluateRequest,
  ): Promise<SuitabilityRunWithWindows> {
    const body = await request<{ data: SuitabilityRunWithWindows }>(
      `/fields/${encodeURIComponent(fieldId)}/evaluate`,
      {
        method: "POST",
        body: payload,
      },
    );
    return body.data;
  },

  async getLatestSuitability(fieldId: string): Promise<SuitabilityRunWithWindows> {
    const body = await request<{ data: SuitabilityRunWithWindows }>(
      `/fields/${encodeURIComponent(fieldId)}/suitability`,
    );
    return body.data;
  },

  async listPlantingWindows(filters: PlantingWindowListQuery = {}): Promise<PlantingWindow[]> {
    const body = await request<{ data: PlantingWindow[] }>(
      `/planting-windows${query({
        fieldId: filters.fieldId,
        cropId: filters.cropId,
        suitability: filters.suitability,
        from: filters.from,
        to: filters.to,
      })}`,
    );
    return body.data;
  },

  async generateBriefing(
    fieldId: string,
    payload: Partial<BriefingGenerateRequest> = {},
  ): Promise<AiBriefing> {
    const body = await request<{ data: AiBriefing }>(
      `/fields/${encodeURIComponent(fieldId)}/briefing`,
      {
        method: "POST",
        body: payload,
      },
    );
    return body.data;
  },

  async getLatestBriefing(fieldId: string): Promise<AiBriefing> {
    const body = await request<{ data: AiBriefing }>(
      `/fields/${encodeURIComponent(fieldId)}/briefing`,
    );
    return body.data;
  },

  async dashboardAdvisory(): Promise<DashboardAdvisory> {
    const body = await request<{ data: DashboardAdvisory }>("/dashboard/advisory");
    return body.data;
  },

  async fieldRecommendations(
    fieldId: string,
    horizonMonths: 3 | 6 | 12 = 6,
  ): Promise<FieldRecommendations> {
    const body = await request<{ data: FieldRecommendations }>(
      `/fields/${encodeURIComponent(fieldId)}/recommendations?horizonMonths=${horizonMonths}`,
    );
    return body.data;
  },
};

/** Human wording for the codes the UI can actually meet. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : "Terjadi kesalahan yang tidak dikenali.";
  }
  switch (error.code) {
    case "GRID_NOT_FOUND":
      return "Sumber data cuaca yang dipilih belum tersedia. Gunakan pengaturan sumber data bawaan (simulasi).";
    case "CELL_NOT_FOUND":
      return "Lokasi lahan berada di luar cakupan wilayah data cuaca yang tersedia.";
    case "FIELD_NOT_FOUND":
      return "Lahan tidak ditemukan, atau bukan milik akun ini.";
    case "CROP_NOT_FOUND":
      return "Komoditas tidak ada di panduan tanaman.";
    case "PROFILE_NOT_FOUND":
      return "Data syarat tumbuh tanaman tidak ditemukan.";
    case "NOT_FOUND":
      return "Data yang diminta tidak ditemukan.";
    case "INVALID_TRANSITION":
      return "Perubahan status penanaman tidak diizinkan.";
    case "INVALID_DATE":
      return "Tanggal tidak valid (mis. panen sebelum tanggal tanam atau pengamatan di masa depan).";
    case "UNAUTHENTICATED":
      return "Sesi berakhir. Masuk kembali.";
    case "CONFLICT":
      return "Permintaan bentrok dengan data yang sudah ada.";
    case "VALIDATION_FAILED": {
      const first = error.details?.[0];
      return first === undefined
        ? "Permintaan ditolak validasi."
        : `Permintaan ditolak: ${first.path} — ${first.issue}.`;
    }
    default:
      return error.message;
  }
}
