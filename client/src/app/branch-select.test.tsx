import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import BranchSelect from "./BranchSelect";

afterEach(cleanup);

const IDS = ["aaaaaaaa-1111-4111-8111-111111111111", "bbbbbbbb-2222-4222-8222-222222222222"];
const LABELS = [
  { id: IDS[0]!, name: "Sucursal Centro", code: "CEN" },
  { id: IDS[1]!, name: "Sucursal Norte", code: "NOR" },
];

const select = () => screen.getByRole("combobox", { name: /Sucursal autorizada/ });
const optionTexts = () => Array.from((select() as HTMLSelectElement).options).map((option) => option.textContent);

describe("BranchSelect", () => {
  it("shows the real branch name and code instead of a truncated UUID", () => {
    render(<BranchSelect value={IDS[0]!} branchIds={IDS} labels={LABELS} disabled={false} onChange={() => undefined} />);
    expect(optionTexts()).toEqual(["Sucursal Centro (CEN)", "Sucursal Norte (NOR)"]);
  });

  it("falls back to the short id when no label is known (older API or missing row)", () => {
    render(<BranchSelect value={IDS[0]!} branchIds={IDS} disabled={false} onChange={() => undefined} />);
    expect(optionTexts()).toEqual(["AAAAAAAA", "BBBBBBBB"]);
    cleanup();
    render(<BranchSelect value={IDS[0]!} branchIds={IDS} labels={[LABELS[0]!]} disabled={false} onChange={() => undefined} />);
    expect(optionTexts()).toEqual(["Sucursal Centro (CEN)", "BBBBBBBB"]);
  });

  it("offers only branchIds: a label for a branch outside the scope never creates an option", () => {
    const outside = { id: "cccccccc-3333-4333-8333-333333333333", name: "Sucursal Sur", code: "SUR" };
    render(<BranchSelect value={IDS[0]!} branchIds={IDS} labels={[...LABELS, outside]} disabled={false} onChange={() => undefined} />);
    expect(optionTexts()).toHaveLength(2);
    expect(optionTexts().join(" ")).not.toContain("Sur");
  });

  it("reports a change only to a branch inside branchIds", () => {
    const onChange = vi.fn();
    render(<BranchSelect value={IDS[0]!} branchIds={IDS} labels={LABELS} disabled={false} onChange={onChange} />);
    fireEvent.change(select(), { target: { value: IDS[1]! } });
    expect(onChange).toHaveBeenCalledWith(IDS[1]);

    onChange.mockClear();
    // A value outside the scope (e.g. a tampered DOM) must never reach the caller.
    const element = select() as HTMLSelectElement;
    const rogue = document.createElement("option");
    rogue.value = "cccccccc-3333-4333-8333-333333333333";
    element.appendChild(rogue);
    fireEvent.change(element, { target: { value: rogue.value } });
    expect(onChange).not.toHaveBeenCalled();
  });

  it("is disabled when told to or when there is no branch", () => {
    render(<BranchSelect value="" branchIds={[]} disabled={false} onChange={() => undefined} />);
    expect(select()).toBeDisabled();
    cleanup();
    render(<BranchSelect value={IDS[0]!} branchIds={IDS} disabled onChange={() => undefined} />);
    expect(select()).toBeDisabled();
  });
});
