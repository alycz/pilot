import { AppShell } from "@/components/shell";

export default function ChatPage() {
  return (
    <AppShell active="chat" eyebrow="XRPL Testnet" title="Conversation">
      <div aria-hidden="true" className="min-h-[calc(100dvh-3.5rem)] lg:min-h-[calc(100dvh-4rem)]" />
    </AppShell>
  );
}
