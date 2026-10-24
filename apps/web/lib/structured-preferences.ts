export function resolveStructuredPreferenceTenant(
  environment: Readonly<Record<string, string | undefined>> = process.env,
): string | undefined {
  const flag = environment.PILOT_STRUCTURED_PREFERENCES;
  if (flag === undefined || flag === "0") return undefined;
  if (flag !== "1") throw new Error("PILOT_STRUCTURED_PREFERENCES must be exactly 0 or 1");
  const tenantId = environment.PILOT_PERSONALIZATION_TENANT_ID?.trim();
  if (!tenantId || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(tenantId)) {
    throw new Error("Structured preference tenant identity is not configured");
  }
  return tenantId;
}
