"use client";

import { Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";

export type ModelChoice = {
  id: string;
  name: string;
  description?: string;
};

export type BedrockPickerMode = "off" | "mock" | "aws";

type ModelPickerProps = {
  bedrockMode?: BedrockPickerMode;
  bedrockModels?: readonly string[];
  disabled?: boolean;
  models: ModelChoice[];
  onChange: (model: ModelChoice) => void;
  value?: string;
};

export type ModelChoiceGroup = {
  id: "openrouter" | "bedrock";
  label: string;
  models: ModelChoice[];
};

export function friendlyBedrockModelName(modelId: string): string {
  const leaf = modelId.split("/").at(-1) ?? modelId;
  const withoutProvider = leaf.includes(".") ? leaf.slice(leaf.indexOf(".") + 1) : leaf;
  return withoutProvider
    .split(/[._:-]+/)
    .filter(Boolean)
    .map((part) => part.length <= 3 ? part.toUpperCase() : `${part[0]?.toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

export function modelChoiceGroups(
  models: readonly ModelChoice[],
  bedrockMode: BedrockPickerMode = "off",
  bedrockModels: readonly string[] = [],
): ModelChoiceGroup[] {
  const groups: ModelChoiceGroup[] = [];
  if (models.length > 0) {
    groups.push({ id: "openrouter", label: "OpenRouter", models: [...models] });
  }
  if (bedrockMode !== "off" && bedrockModels.length > 0) {
    groups.push({
      id: "bedrock",
      label: "AWS Bedrock",
      models: [...new Set(bedrockModels)].map((id) => ({
        id,
        name: friendlyBedrockModelName(id),
        description: bedrockMode === "mock" ? "OpenRouter free-model stand-in" : "AWS Bedrock",
      })),
    });
  }
  return groups;
}

export function ModelPicker({
  bedrockMode = "off",
  bedrockModels = [],
  disabled,
  models,
  onChange,
  value,
}: ModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const groups = useMemo(
    () => modelChoiceGroups(models, bedrockMode, bedrockModels),
    [bedrockMode, bedrockModels, models],
  );
  const selected = groups.flatMap((group) => group.models).find((model) => model.id === value);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);

  // Close on Escape (returning focus to the trigger) and on outside clicks.
  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setOpen(false);
      setQuery("");
      triggerRef.current?.focus();
    };
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
        setQuery("");
      }
    };
    document.addEventListener("keydown", onKeyDown);
    document.addEventListener("pointerdown", onPointerDown);
    return () => {
      document.removeEventListener("keydown", onKeyDown);
      document.removeEventListener("pointerdown", onPointerDown);
    };
  }, [open]);
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return groups;
    return groups
      .map((group) => ({
        ...group,
        models: group.models.filter((model) =>
          `${group.label} ${model.name} ${model.id} ${model.description ?? ""}`.toLowerCase().includes(needle),
        ),
      }))
      .filter((group) => group.models.length > 0);
  }, [groups, query]);
  const filteredCount = filtered.reduce((count, group) => count + group.models.length, 0);

  return (
    <div ref={rootRef} className="bracket bracket-focus relative min-w-0">
      <button
        ref={triggerRef}
        aria-expanded={open}
        aria-haspopup="listbox"
        className="flex w-full min-w-0 items-center justify-between gap-4 border border-border bg-white/[0.03] px-4 py-3.5 text-left transition hover:border-border-strong hover:bg-white/[0.05] focus-visible:outline-offset-[-1px] disabled:cursor-not-allowed disabled:opacity-45"
        disabled={disabled}
        onClick={() => setOpen((current) => !current)}
        type="button"
      >
        <span className="min-w-0">
          <span className="block truncate text-sm font-medium">{selected?.name ?? "Choose a model"}</span>
          <span className="mt-0.5 block truncate font-mono text-[11px] text-muted-foreground">{selected?.id ?? "Tool-capable models only"}</span>
        </span>
        <ChevronDown aria-hidden="true" className={`size-4 shrink-0 text-muted-foreground transition ${open ? "rotate-180" : ""}`} />
      </button>

      {open ? (
        <div className="absolute z-30 mt-1 w-full overflow-hidden border border-border-strong bg-popover shadow-xl shadow-black/[0.08]">
          <label className="flex items-center gap-2 border-b border-border px-3 py-2.5">
            <Search className="size-4 text-muted-foreground" aria-hidden="true" />
            <span className="sr-only">Search models</span>
            <input
              autoFocus
              className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Search model or provider"
              value={query}
            />
          </label>
          <div className="max-h-64 overflow-y-auto" role="listbox" aria-label="Models">
            {filtered.map((group) => (
              <div aria-label={group.label} key={group.id} role="group">
                <p className="px-3 pb-1 pt-2 text-[10px] font-semibold uppercase tracking-[0.16em] text-muted-foreground">
                  {group.label}
                </p>
                {group.models.map((model) => (
                  <button
                    aria-selected={model.id === value}
                    className="flex w-full min-w-0 items-start gap-3 border-b border-border px-3 py-3 text-left last:border-b-0 hover:bg-white/[0.04] focus-visible:outline-offset-[-2px]"
                    key={model.id}
                    onClick={() => {
                      onChange(model);
                      setOpen(false);
                      setQuery("");
                    }}
                    role="option"
                    type="button"
                  >
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-sm font-medium">{model.name}</span>
                      <span className="mt-1 block break-all font-mono text-[10px] text-muted-foreground">{model.id}</span>
                    </span>
                    {model.id === value ? <Check className="mt-0.5 size-4 shrink-0 text-[color-mix(in_oklab,var(--primary)_80%,var(--foreground))]" aria-hidden="true" /> : null}
                  </button>
                ))}
              </div>
            ))}
            {filteredCount === 0 ? (
              <p className="px-3 py-5 text-center text-sm text-muted-foreground">No matching tool-capable models.</p>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}
