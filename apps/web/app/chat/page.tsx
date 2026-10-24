import { ChatView } from "@/components/chat";
import { AppShell } from "@/components/shell";

export default function ChatPage() {
  return (
    <AppShell active="chat" eyebrow="XRPL Testnet" title="Conversation">
      <ChatView />
    </AppShell>
  );
}
