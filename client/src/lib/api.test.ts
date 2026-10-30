import { afterEach, describe, expect, it, vi } from "vitest";
import { API_URL, CodedApiError, apiRequest, apiRequestCoded, userFacingError } from "./api";

function respond(status: number, body: unknown, jsonFails = false): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: jsonFails ? async () => { throw new Error("not json"); } : async () => body,
  } as Response;
}

function mockFetch(response: Response) {
  const fetchMock = vi.fn(async () => response);
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => vi.unstubAllGlobals());

describe("userFacingError", () => {
  it("translates the known server messages and passes any other through", () => {
    expect(userFacingError("Unauthorized", "x")).toBe("No autorizado.");
    expect(userFacingError("Forbidden", "x")).toBe("No tenés permiso para realizar esta acción.");
    expect(userFacingError("Invalid credentials", "x")).toBe("Usuario o contraseña incorrectos.");
    expect(userFacingError("Stock insuficiente", "x")).toBe("Stock insuficiente");
  });

  it("uses the fallback when there is no message", () => {
    expect(userFacingError(undefined, "Fallback")).toBe("Fallback");
  });
});

describe("apiRequest", () => {
  it("sends JSON and the bearer token only when there is one, against API_URL", async () => {
    const fetchMock = mockFetch(respond(200, { ok: true }));
    await expect(apiRequest("/sales/pending", "tok")).resolves.toEqual({ ok: true });
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe(`${API_URL}/sales/pending`);
    const headers = new Headers(init.headers);
    expect(headers.get("Authorization")).toBe("Bearer tok");
    expect(headers.get("Content-Type")).toBe("application/json");

    await apiRequest("/auth/login", null);
    const [, anonymous] = fetchMock.mock.calls[1] as unknown as [string, RequestInit];
    expect(new Headers(anonymous.headers).has("Authorization")).toBe(false);
  });

  it("maps 401, 403 and other failures to the Spanish fallbacks when the body has no message", async () => {
    mockFetch(respond(401, {}, true));
    await expect(apiRequest("/x", "t")).rejects.toThrow("No autorizado.");
    mockFetch(respond(403, {}));
    await expect(apiRequest("/x", "t")).rejects.toThrow("No tenés permiso para realizar esta acción.");
    mockFetch(respond(500, {}));
    await expect(apiRequest("/x", "t")).rejects.toThrow("No se pudo completar la operación.");
  });

  it("surfaces the server message (top-level or nested) as a plain Error without code or status", async () => {
    mockFetch(respond(409, { error: { code: "INSUFFICIENT_STOCK", message: "Sin stock" } }));
    const caught = await apiRequest("/x", "t").catch((cause: unknown) => cause);
    expect(caught).toBeInstanceOf(Error);
    expect(caught).not.toBeInstanceOf(CodedApiError);
    expect((caught as Error).message).toBe("Sin stock");

    mockFetch(respond(400, { message: "Dato inválido" }));
    await expect(apiRequest("/x", "t")).rejects.toThrow("Dato inválido");
  });
});

describe("apiRequestCoded", () => {
  it("returns the body on success", async () => {
    mockFetch(respond(201, { id: "1" }));
    await expect(apiRequestCoded("/x", "t", { method: "POST" })).resolves.toEqual({ id: "1" });
  });

  it("keeps status, code and details of a failed answer in a CodedApiError", async () => {
    mockFetch(respond(409, { error: { code: "CHECKOUT_QUOTE_CHANGED", message: "Cambió", details: { total: "100" } } }));
    const caught = await apiRequestCoded("/x", "t").catch((cause: unknown) => cause);
    expect(caught).toBeInstanceOf(CodedApiError);
    const error = caught as CodedApiError;
    expect(error.name).toBe("CodedApiError");
    expect(error.status).toBe(409);
    expect(error.code).toBe("CHECKOUT_QUOTE_CHANGED");
    expect(error.details).toEqual({ total: "100" });
    expect(error.message).toBe("Cambió");
  });

  it("uses null code and details when the answer carries none, and the status fallbacks for the message", async () => {
    mockFetch(respond(403, {}));
    const error = (await apiRequestCoded("/x", "t").catch((cause: unknown) => cause)) as CodedApiError;
    expect(error.status).toBe(403);
    expect(error.code).toBeNull();
    expect(error.details).toBeNull();
    expect(error.message).toBe("No tenés permiso para realizar esta acción.");
  });
});

describe("CodedApiError", () => {
  it("is an Error carrying status, code and details", () => {
    const error = new CodedApiError("m", null, null, undefined);
    expect(error).toBeInstanceOf(Error);
    expect(error.status).toBeNull();
    expect(error.code).toBeNull();
  });
});
