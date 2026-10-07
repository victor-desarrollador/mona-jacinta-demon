import { describe, expect, it } from "vitest";
import { catalogCashPrice } from "./catalog-price";

// Pilot Pricing V2 catalog presentation. Cases preregistered before the first run (expected display/action):
//  U01 cashPrice present, list adjustment 0        -> CASH base shown, sellable
//  U02 cashPrice present, positive LIST adjustment -> still the CASH base (the client never derives LIST; the server prices the sale)
//  U03 cashPrice NULL, legacy price present        -> NOT configured (no legacy fallback), not sellable
//  U04 cashPrice and legacy price both present and different -> the CASH base wins, legacy is ignored
//  U05 wholesale base present / absent             -> irrelevant to the seller catalog price (never read here)
//  U06 QR adjustment configured                    -> irrelevant: the catalog shows the CASH base only
//  U07 cashPrice "0" or negative or malformed      -> NOT configured (the server rejects it too)
//  U08 stale legacy product (cashPrice NULL, big legacy price) -> NOT configured, legacy never leaks
//  U09 seller catalog confidentiality              -> the helper takes no wholesale/cost field and returns only cents
//  U10 huge centavo value                          -> exact (string/BigInt, no Number)
describe("catalogCashPrice", () => {
  it("U01/U02 shows the CASH base when configured, whatever the LIST adjustment is", () => {
    expect(catalogCashPrice({ cashPrice: "4500000" })).toEqual({ configured: true, cents: "4500000" });
  });

  it("U03/U08 does not fall back to the legacy price when cashPrice is NULL", () => {
    const legacyOnly = { cashPrice: null, price: "5400000" } as { cashPrice: string | null; price: string };
    expect(catalogCashPrice(legacyOnly)).toEqual({ configured: false });
  });

  it("U04 prefers the CASH base over a different legacy price", () => {
    const both = { cashPrice: "4500000", price: "9900000" } as { cashPrice: string | null; price: string };
    expect(catalogCashPrice(both)).toEqual({ configured: true, cents: "4500000" });
  });

  it("U05/U06/U09 returns only the CASH cents (no wholesale, cost or mode fields involved)", () => {
    const rich = { cashPrice: "100", wholesalePrice: "50", costPrice: "10", qr: 500 } as { cashPrice: string | null };
    expect(Object.keys(catalogCashPrice(rich)).sort()).toEqual(["cents", "configured"]);
  });

  it.each(["0", "-1", "", "12.5", "abc", "1e3"])("U07 treats %j as not configured", (cashPrice) => {
    expect(catalogCashPrice({ cashPrice })).toEqual({ configured: false });
  });

  it("U10 keeps very large centavo values exact", () => {
    expect(catalogCashPrice({ cashPrice: "9223372036854775807" })).toEqual({ configured: true, cents: "9223372036854775807" });
  });
});
