"use client";

export type BranchLabel = { id: string; name: string; code: string };

// Branch selector shared by the POS workspaces. `branchIds` is the AUTHORITY: the options come only from it and a change is only reported
// for an id inside it. `labels` (name + code, from /auth/me `branches`) is display text and never creates an option; a branch without a
// label (older API, missing row) shows its short id as before.
function optionText(id: string, labels: BranchLabel[] | undefined) {
  const label = labels?.find((candidate) => candidate.id === id);
  return label ? `${label.name} (${label.code})` : id.slice(0, 8).toUpperCase();
}

export default function BranchSelect({
  value,
  branchIds,
  labels,
  disabled,
  onChange,
}: {
  value: string;
  branchIds: string[];
  labels?: BranchLabel[];
  disabled: boolean;
  onChange: (branchId: string) => void;
}) {
  return (
    <label className="branch-select">
      Sucursal autorizada
      <select
        value={value}
        onChange={(event) => {
          if (branchIds.includes(event.target.value)) onChange(event.target.value);
        }}
        disabled={branchIds.length === 0 || disabled}
      >
        {branchIds.map((id) => (
          <option key={id} value={id}>
            {optionText(id, labels)}
          </option>
        ))}
      </select>
    </label>
  );
}
