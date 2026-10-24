import * as React from "react";

const DEFAULT_PERMISSIONS = [8, 9, 21, 37, 38, 3, 18] as const;

const PERMISSIONS: Readonly<Record<number, { name: string; meaning: string }>> =
  Object.freeze({
    8: { name: "OfferCreate", meaning: "Place DEX offers (swaps) within policy" },
    9: { name: "OfferCancel", meaning: "Cancel its own offers" },
    21: { name: "TrustSet", meaning: "Add or adjust trust lines" },
    37: { name: "AMMDeposit", meaning: "Add liquidity to AMM pools" },
    38: { name: "AMMWithdraw", meaning: "Remove liquidity" },
    3: { name: "EscrowFinish", meaning: "Finish escrows" },
    18: { name: "CheckCash", meaning: "Cash checks" },
  });

export function BlindSignLegend({
  delegateAddress,
  permissions = DEFAULT_PERMISSIONS,
}: {
  delegateAddress: string;
  permissions?: readonly number[];
}) {
  return (
    <section
      aria-label="Ledger blind-signing guide"
      className="grid gap-4 border border-amber-300 bg-amber-50 p-4 text-slate-950 lg:grid-cols-[minmax(0,0.8fr)_minmax(0,1.2fr)]"
    >
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-amber-900">
          Expected Ledger screens
        </p>
        <dl className="mt-3 grid gap-px border border-amber-200 bg-amber-200 text-xs">
          <div className="bg-white p-2">
            <dt className="font-semibold">Type</dt>
            <dd className="mt-1 font-mono">Unknown</dd>
          </div>
          <div className="bg-white p-2">
            <dt className="font-semibold">Authorize · Harbor delegate</dt>
            <dd className="mt-1 break-all font-mono">{delegateAddress}</dd>
          </div>
          {permissions.map((value, index) => {
            const permission = PERMISSIONS[value];
            return (
              <div key={`${value}-${index}`} className="bg-white p-2">
                <dt className="font-mono">Unknown [{index + 1}] | {value}</dt>
                <dd className="mt-1 font-semibold">
                  {permission?.name ?? "Unrecognized permission"}
                </dd>
                <dd className="mt-0.5 text-slate-600">
                  {permission?.meaning ?? "Do not approve an unexpected permission."}
                </dd>
              </div>
            );
          })}
        </dl>
      </div>
      <div>
        <h3 className="text-sm font-semibold">Blind signing is required for DelegateSet</h3>
        <ol className="mt-3 list-decimal space-y-2 pl-5 text-xs leading-5 text-slate-700">
          <li>Open the XRP app on the Ledger.</li>
          <li>Open Settings and enable Blind signing.</li>
          <li>Match the full Authorize address and every permission value shown here.</li>
          <li>Approve only when the values match Pilot exactly.</li>
          <li>After delegation is validated, return to Settings and disable Blind signing.</li>
        </ol>
        <p className="mt-3 border border-amber-300 bg-white p-3 text-xs font-medium text-amber-950">
          The device may label this transaction and its permissions as Unknown. Pilot never hides that limitation.
        </p>
      </div>
    </section>
  );
}
