"use client";

import type { PilotWallet } from "@pilot/wallet";
import { Check, ShieldCheck } from "lucide-react";
import * as React from "react";

import { BlindSignLegend } from "../ledger/blind-sign-legend";
import { LedgerDeviceStatus } from "../ledger/device-status";
import { VirtualDevicePanel } from "../ledger/virtual-device-panel";

export type LedgerOnboardingTransport = "webhid" | "virtual";
export type LedgerOnboardingAccountIndex = 0 | 1 | 2;

export type LedgerOnboardingConfig = Readonly<{
  enabled: boolean;
  transports: readonly LedgerOnboardingTransport[];
  defaultAccountIndex: number;
}>;

export type StoredLedgerOnboardingConfig = Readonly<{
  transport: LedgerOnboardingTransport;
  accountIndex: number;
}>;

export const LEDGER_ONBOARDING_ACCOUNT_INDEXES = [0, 1, 2] as const;
export const LEDGER_PERMISSION_VALUES = [8, 9, 21, 37, 38, 3, 18] as const;
export const LEDGER_SESSION_TTL_MS = 60 * 60 * 1_000;

export function defaultLedgerAccountIndex(value: number): LedgerOnboardingAccountIndex {
  return LEDGER_ONBOARDING_ACCOUNT_INDEXES.includes(value as LedgerOnboardingAccountIndex)
    ? value as LedgerOnboardingAccountIndex
    : 0;
}
export function defaultLedgerTransport(
  config: LedgerOnboardingConfig | undefined,
  hidAvailable = ledgerWebHidAvailable(),
): LedgerOnboardingTransport {
  if (hidAvailable && config?.transports.includes("webhid")) return "webhid";
  if (config?.transports.includes("virtual")) return "virtual";
  return "webhid";
}

export function ledgerTransportAvailable(
  config: LedgerOnboardingConfig | undefined,
  transport: LedgerOnboardingTransport,
  hidAvailable = ledgerWebHidAvailable(),
): boolean {
  return config?.enabled === true && config.transports.includes(transport) &&
    (transport !== "webhid" || hidAvailable);
}

export function ledgerWebHidAvailable(navigatorValue: unknown = globalThis.navigator): boolean {
  return navigatorValue !== null && typeof navigatorValue === "object" &&
    "hid" in navigatorValue;
}

export function ledgerSessionMatches(
  session: {
    authenticated: boolean;
    account?: string;
    network?: string;
    expiresAt?: number;
  },
  expected: { account: string; network: "testnet" | "devnet" },
  now = Date.now(),
): boolean {
  return session.authenticated && session.account === expected.account &&
    session.network === expected.network &&
    typeof session.expiresAt === "number" && Number.isSafeInteger(session.expiresAt) &&
    session.expiresAt > now && session.expiresAt <= now + LEDGER_SESSION_TTL_MS;
}

export function validStoredLedgerConfig(
  value: unknown,
): value is StoredLedgerOnboardingConfig {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return Object.keys(record).length === 2 &&
    (record.transport === "webhid" || record.transport === "virtual") &&
    Number.isInteger(record.accountIndex) &&
    Number(record.accountIndex) >= 0 && Number(record.accountIndex) <= 2;
}

export function isLedgerBlindSigningDisabled(error: unknown): boolean {
  return error !== null && typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code === "LEDGER_BLIND_SIGNING_DISABLED";
}

export function hasExactLedgerPermissionSet(permissions: readonly string[]): boolean {
  const expected = [
    "OfferCreate",
    "OfferCancel",
    "TrustSet",
    "AMMDeposit",
    "AMMWithdraw",
    "EscrowFinish",
    "CheckCash",
  ];
  return permissions.length === expected.length &&
    new Set(permissions).size === expected.length &&
    expected.every((permission) => permissions.includes(permission));
}

export const LEDGER_SIGN_IN_SCREENS = [
  "Account Setting",
  "Fee · XRP 0",
  "Memo · pilot-wallet-auth-v1",
  "Nonce · fresh one-time challenge",
] as const;

const TRUST_SET_SCREENS = [
  "Set Trust Line",
  "Limit · configured stablecoin",
  "Issuer · exact configured issuer",
  "Fee · review on device",
] as const;

function ExpectedScreens({ screens }: { screens: readonly string[] }) {
  return (
    <section className="border border-border bg-white/[0.02] p-4 rounded-xl overflow-hidden" aria-label="Expected Ledger screens">
      <p className="label-mono text-foreground">Expected Ledger screens</p>
      <ul className="mt-3 grid gap-2 text-xs text-muted-foreground sm:grid-cols-2">
        {screens.map((screen) => (
          <li className="flex items-start gap-2" key={screen}>
            <Check aria-hidden="true" className="mt-0.5 size-3.5 shrink-0 text-[color-mix(in_oklab,var(--executed)_80%,var(--foreground))]" />
            {screen}
          </li>
        ))}
      </ul>
    </section>
  );
}

export function LedgerSigningGuide({
  phase,
  wallet,
  transport,
  delegateAddress,
  blindSigningConfirmed,
  onBlindSigningConfirmed,
}: {
  phase: "sign-in" | "trust" | "delegate";
  wallet?: Pick<PilotWallet, "onDeviceState">;
  transport: LedgerOnboardingTransport;
  delegateAddress?: string;
  blindSigningConfirmed?: boolean;
  onBlindSigningConfirmed?: (confirmed: boolean) => void;
}) {
  return (
    <div className="space-y-3">
      {phase === "sign-in" ? <ExpectedScreens screens={LEDGER_SIGN_IN_SCREENS} /> : null}
      {phase === "trust" ? <ExpectedScreens screens={TRUST_SET_SCREENS} /> : null}
      {phase === "delegate" && delegateAddress ? (
        <>
          <BlindSignLegend
            delegateAddress={delegateAddress}
            permissions={LEDGER_PERMISSION_VALUES}
          />
          <label className="flex items-start gap-3 border border-approval bg-approval/10 p-4 text-sm text-slate-950 rounded-xl">
            <input
              checked={blindSigningConfirmed ?? false}
              className="mt-0.5 size-4"
              onChange={(event) => onBlindSigningConfirmed?.(event.currentTarget.checked)}
              type="checkbox"
            />
            <span>
              <span className="block font-semibold">Blind signing is on</span>
              <span className="mt-1 block text-xs leading-5 text-slate-700">
                I will match the Authorize address and all seven values before approving.
              </span>
            </span>
          </label>
        </>
      ) : null}
      {wallet ? <LedgerDeviceStatus wallet={wallet} transport={transport} /> : null}
      {transport === "virtual" ? <VirtualDevicePanel /> : null}
    </div>
  );
}

export function LedgerWalletStep({
  config,
  transport,
  accountIndex,
  accounts,
  wallet,
  onTransportChange,
  onAccountIndexChange,
  simulatedDeviceSlot,
}: {
  config: LedgerOnboardingConfig;
  transport: LedgerOnboardingTransport;
  accountIndex: LedgerOnboardingAccountIndex;
  accounts: Partial<Record<LedgerOnboardingAccountIndex, string>>;
  wallet?: Pick<PilotWallet, "onDeviceState">;
  onTransportChange(transport: LedgerOnboardingTransport): void;
  onAccountIndexChange(index: LedgerOnboardingAccountIndex): void;
  /** LG-5 may inject its local-only replay in logged-out fixtures. Authenticated flows omit it. */
  simulatedDeviceSlot?: React.ReactNode;
}) {
  const hidAvailable = ledgerWebHidAvailable();
  return (
    <section className="space-y-4 border border-border bg-white/[0.02] p-4 rounded-xl overflow-hidden" aria-label="Ledger wallet setup">
      <div>
        <p className="label-mono text-foreground">Ledger device</p>
        <p className="mt-2 text-xs leading-5 text-muted-foreground">
          Pilot reads public addresses and requests sign-only approvals. It never receives a seed or private key.
        </p>
      </div>

      <div className="grid gap-2 sm:grid-cols-2" aria-label="Ledger transport">
        {config.transports.map((choice) => {
          const unavailable = !ledgerTransportAvailable(config, choice, hidAvailable);
          return (
            <button
              className={`border p-3 text-left text-sm transition rounded-md ${transport === choice ? "border-border-strong bg-primary-soft" : "border-border bg-card"}`}
              disabled={unavailable}
              key={choice}
              onClick={() => onTransportChange(choice)}
              type="button"
            >
              <span className="font-medium">{choice === "webhid" ? "Real Ledger" : "Virtual Ledger"}</span>
              <span className="mt-1 block text-xs text-muted-foreground">
                {unavailable
                  ? "Unavailable: use desktop Chrome, Edge, or Brave with WebHID."
                  : choice === "webhid"
                    ? "Your physical device signs on this computer."
                    : "Ledger's XRP app 2.8.2 in the local emulator."}
              </span>
            </button>
          );
        })}
      </div>

      {LEDGER_ONBOARDING_ACCOUNT_INDEXES.some((index) => accounts[index]) ? (
        <fieldset className="space-y-2">
          <legend className="label-mono text-foreground">Choose an account</legend>
          {LEDGER_ONBOARDING_ACCOUNT_INDEXES.map((index) => (
            <label className="flex cursor-pointer items-start gap-3 border border-border bg-card p-3 rounded-xl" key={index}>
              <input
                checked={accountIndex === index}
                className="mt-0.5 size-4"
                name="ledger-account-index"
                onChange={() => onAccountIndexChange(index)}
                type="radio"
              />
              <span className="min-w-0">
                <span className="block text-sm font-medium">Account {index}</span>
                <span className="mt-1 block break-all font-mono text-xs text-muted-foreground">
                  {accounts[index] ?? "Unavailable"}
                </span>
              </span>
            </label>
          ))}
          {transport === "webhid" ? (
            <p className="border-l-2 border-info/60 bg-info/[0.05] px-3 py-2 text-xs leading-5 text-muted-foreground">
              Prefer account 1 or 2. Pilot only acts on test networks; keep main holdings on another account.
            </p>
          ) : null}
        </fieldset>
      ) : (
        <p className="text-xs leading-5 text-muted-foreground">
          Connect once to read public addresses for Ledger account indexes 0–2. You will verify the selected address on the device before signing in.
        </p>
      )}

      {Object.keys(accounts).length > 0 ? (
        <LedgerSigningGuide phase="sign-in" transport={transport} wallet={wallet} />
      ) : simulatedDeviceSlot ? (
        simulatedDeviceSlot
      ) : transport === "virtual" ? <VirtualDevicePanel /> : null}
      <p className="flex items-start gap-2 text-xs leading-5 text-muted-foreground">
        <ShieldCheck aria-hidden="true" className="mt-0.5 size-3.5 shrink-0" />
        This proves you control the account. It is never submitted. Wallet authorization lasts 60 minutes.
      </p>
    </section>
  );
}
