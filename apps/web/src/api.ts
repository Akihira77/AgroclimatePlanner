import type {
  ClimateDailyOutlook,
  ClimateOutlook,
  CropDetail,
  CropList,
  CropProfileVersion,
  Field,
  Farm,
  PageMeta,
  RegisteredUser,
  CsrfTokenResponse,
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
 * therefore sets `credentials: "include"`, and the API answers with CORS
 * credentials for the origins in `CORS_ORIGINS` — in development, the Vite origin.
 */

const configured = import.meta.env["VITE_API_BASE_URL"];
export const API_BASE = (configured ?? "http://localhost:3000/v1").replace(/\/$/, "");

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

/**
 * Every page, not the first one.
 *
 * `pageSize` is capped at 100 by the server, so a single request is a truncation,
 * and a truncated list rendered as a total is a lie: farm 101 would simply stop
 * existing on screen. The loop stops at `total`, which the server counts under
 * the same predicates as the page.
 */
async function allPages<T>(
  path: string,
  params: Record<string, string | number | undefined>,
): Promise<T[]> {
  const items: T[] = [];
  for (let page = 1; ; page += 1) {
    const body = await request<{ data: T[]; meta: PageMeta }>(
      `${path}${query({ ...params, page, pageSize: 100 })}`,
    );
    items.push(...body.data);
    if (body.data.length === 0 || items.length >= body.meta.total) return items;
  }
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

  async me(): Promise<RegisteredUser> {
    const body = await request<{ data: RegisteredUser }>("/auth/me");
    return body.data;
  },

  async listFarms(): Promise<Farm[]> {
    return allPages<Farm>("/farms", {});
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
};

/** Human wording for the codes the UI can actually meet. */
export function describeError(error: unknown): string {
  if (!(error instanceof ApiError)) {
    return error instanceof Error ? error.message : "Terjadi kesalahan yang tidak dikenali.";
  }
  switch (error.code) {
    case "GRID_NOT_FOUND":
      return "Tidak ada grid produksi untuk provider/model ini. Registry hanya memuat grid sintetis sampai OPEN-18 selesai.";
    case "CELL_NOT_FOUND":
      return "Titik tengah lahan berada di luar cakupan grid ini.";
    case "FIELD_NOT_FOUND":
      return "Lahan tidak ditemukan, atau bukan milik akun ini.";
    case "CROP_NOT_FOUND":
      return "Komoditas tidak ada di katalog.";
    case "PROFILE_NOT_FOUND":
      return "Versi profil tidak ditemukan.";
    case "UNAUTHENTICATED":
      return "Sesi berakhir. Masuk kembali.";
    case "CONFLICT":
      return "Alamat email sudah terdaftar.";
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
