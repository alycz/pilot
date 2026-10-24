export const pilotRoutes = {
  home: "/",
  onboarding: "/onboarding",
  chat: "/chat",
  map: "/map",
  portfolio: "/portfolio",
  memory: "/memory",
  publicConfig: "/api/config/public",
  vaultSnapshot: "/api/vault/snapshot",
} as const;

export type PilotRoute = (typeof pilotRoutes)[keyof typeof pilotRoutes];
