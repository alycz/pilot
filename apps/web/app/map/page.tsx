import type { Metadata } from "next";

import { MapExplorer } from "@/components/map/map-explorer";
import { AppShell } from "@/components/shell";

export const metadata: Metadata = {
  title: "Venue map",
  description: "Explore XRPL venues and their network availability.",
};

export default function MapPage() {
  return (
    <AppShell active="map" title="Venue map" eyebrow="Explore" ownHeading>
      <MapExplorer />
    </AppShell>
  );
}
