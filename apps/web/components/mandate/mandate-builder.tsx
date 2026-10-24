"use client";

import React from "react";

import type { MandateDraft, MandatePayeeOption } from "./types";

export type MandateBuilderProps = {
  availablePayees: readonly MandatePayeeOption[];
  disabled?: boolean;
  maximumTotalUsd: string;
  onChange: (value: MandateDraft) => void;
  value: MandateDraft;
};

export function MandateBuilder({
  availablePayees,
  disabled = false,
  maximumTotalUsd,
  onChange,
  value,
}: MandateBuilderProps) {
  function update<K extends keyof MandateDraft>(key: K, next: MandateDraft[K]) {
    onChange({ ...value, [key]: next });
  }

  function togglePayee(id: string) {
    update(
      "payees",
      value.payees.includes(id)
        ? value.payees.filter((payee) => payee !== id)
        : [...value.payees, id],
    );
  }

  return (
    <section aria-labelledby="mandate-builder-title" className="border border-slate-300 bg-white p-5 text-slate-950 rounded-xl overflow-hidden">
      <p className="text-[13px] font-bold text-sky-700">XRPL Testnet</p>
      <h3 className="mt-1 text-xl font-semibold" id="mandate-builder-title">Set the agent&apos;s hard limits</h3>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        You may lower the verified ${maximumTotalUsd} proposal. Pilot cannot raise it or pay a merchant you do not select.
      </p>

      <fieldset className="mt-5 grid gap-3 sm:grid-cols-3" disabled={disabled}>
        <legend className="sr-only">Mandate spending limits</legend>
        <MoneyField label="Per payment" value={value.perPaymentMaxUsd} onChange={(next) => update("perPaymentMaxUsd", next)} />
        <MoneyField label="Per day" value={value.dailyMaxUsd} onChange={(next) => update("dailyMaxUsd", next)} />
        <MoneyField label="Total" value={value.totalMaxUsd} max={maximumTotalUsd} onChange={(next) => update("totalMaxUsd", next)} />
      </fieldset>

      <fieldset className="mt-5" disabled={disabled}>
        <legend className="text-sm font-semibold">Allowed merchants</legend>
        <div className="mt-2 grid gap-2 sm:grid-cols-2">
          {availablePayees.map((payee) => (
            <label className="flex cursor-pointer items-center gap-3 border border-slate-200 px-3 py-2.5 text-sm rounded-xl" key={payee.id}>
              <input
                checked={value.payees.includes(payee.id)}
                className="size-4 accent-sky-700"
                onChange={() => togglePayee(payee.id)}
                type="checkbox"
              />
              <span><span className="block font-medium">{payee.name}</span><span className="block font-mono text-[10px] text-slate-500">{payee.id}</span></span>
            </label>
          ))}
        </div>
      </fieldset>

      <label className="mt-5 block text-sm font-semibold">
        Mandate expiry
        <input
          className="mt-2 block w-full border border-slate-300 bg-white px-3 py-2 text-sm rounded-md"
          disabled={disabled}
          onChange={(event) => update("expiresAt", event.target.value)}
          type="datetime-local"
          value={value.expiresAt}
        />
      </label>
    </section>
  );
}

function MoneyField({ label, max, value, onChange }: { label: string; max?: string; value: string; onChange: (value: string) => void }) {
  return (
    <label className="text-sm font-semibold">
      {label} (USD)
      <input
        className="mt-2 block w-full border border-slate-300 bg-white px-3 py-2 font-mono text-sm rounded-md"
        inputMode="decimal"
        max={max}
        min="0.01"
        onChange={(event) => onChange(event.target.value)}
        step="0.01"
        type="number"
        value={value}
      />
    </label>
  );
}
