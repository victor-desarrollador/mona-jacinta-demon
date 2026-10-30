// Types shared by exchange-draft-store.ts and exchange-fresh-read.ts. They live here so neither module has to import the other just to get a
// type (that was an import cycle). Types only: no runtime code belongs in this file.

export type ExchangeLineDraft = {
  saleItemId: string;
  replacementVariantId: string | null;
  replacementLabel: string;
  returnQuantity: string;
  // What the read that opened the draft (GET /sales/exchangeable) said was ALREADY exchanged of this item. Never typed by a person.
  exchangedQuantityBefore: string;
};
