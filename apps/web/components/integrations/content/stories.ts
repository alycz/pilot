import type { IntegrationSlug, IntegrationStory } from "../types";

/**
 * Plain-language versions of the four integration explainers. Each claim here
 * is a simplification of the matching technical explainer in this folder,
 * which stays on the page as the reference for reviewers.
 */

const mastercard: IntegrationStory = {
  title: "Let Pilot buy data for you, inside limits you sign once.",
  lede:
    "You approve one spending permission: which shops, which products, how much and until when. Pilot can then pay for things like a market report on its own, but only inside that permission. Payments settle on XRPL Testnet.",
  glance: {
    adds: "Agent purchases backed by a permission you signed.",
    control: "You sign the permission. Harbor enforces it on every payment.",
    status: "Built and tested with mock data. Live sandbox checks happen on event day.",
  },
  idea: {
    without:
      "An AI agent that can pay either needs you to approve every purchase, or holds a key with no limits.",
    with:
      "You sign one permission, called a mandate: allowed shops and products, a cap per purchase, a daily cap and an expiry date. Pilot shops inside it. Anything outside it is refused.",
    never:
      "The AI never sees prices, payment details or keys. It can only pick a shop and a product from your list.",
  },
  actors: [
    { id: "you", label: "You", role: "Sign the mandate", icon: "wallet", x: 10, y: 46 },
    { id: "pilot", label: "Pilot", role: "Asks for a product", icon: "pilot", x: 35, y: 46 },
    { id: "harbor", label: "Harbor", role: "Checks limits, pays", icon: "harbor", x: 61, y: 46 },
    { id: "shop", label: "Data shop", role: "Checks proof, sends data", icon: "store", x: 88, y: 16 },
    { id: "xrpl", label: "XRPL Testnet", role: "Settles payments", icon: "ledger", x: 88, y: 76 },
  ],
  flows: [
    {
      id: "purchase",
      label: "Approved purchase",
      tone: "success",
      takeaway: "Pilot can pay on its own, but only for what you approved and within the caps you set.",
      steps: [
        {
          label: "Approve",
          title: "You sign the mandate once",
          caption:
            "You review the shops, products, caps and expiry, then sign once in your wallet. Harbor records the setup on XRPL Testnet.",
          route: ["you", "pilot", "harbor", "xrpl"],
          carries: "Shops, products, caps, expiry",
          outcome: "ok",
        },
        {
          label: "Ask",
          title: "Pilot asks for one product",
          caption:
            "The AI picks a shop and a product from your list. Pilot adds the rest itself (your mandate, the network, a unique request ID) and sends it to Harbor.",
          route: ["pilot", "harbor"],
          carries: "Shop and product only",
        },
        {
          label: "Check",
          title: "Two sets of rules must pass",
          caption:
            "Your normal trading limits must allow it, and so must the mandate: right shop, right product, under every cap, not expired.",
          route: ["harbor"],
          outcome: "ok",
        },
        {
          label: "Prove",
          title: "The shop checks who's buying",
          caption:
            "Harbor sends a five-minute proof of who the agent is and what it may buy. The shop checks identity, then intent, then payment, the order Mastercard's agent-payment pattern uses.",
          route: ["harbor", "shop"],
          carries: "Short-lived proof",
        },
        {
          label: "Pay",
          title: "Harbor pays on the ledger",
          caption:
            "Harbor pays from its own capped account, never your wallet: one exact payment, or a running claim on a payment channel for frequent small purchases.",
          route: ["harbor", "xrpl"],
          carries: "Payment or channel claim",
        },
        {
          label: "Receipt",
          title: "You get the data and a receipt",
          caption:
            "Pilot only counts it as paid once the ledger confirms it. The receipt links mandate → proof → payment → ledger.",
          route: ["xrpl", "harbor", "pilot"],
          outcome: "ok",
        },
      ],
    },
    {
      id: "blocked",
      label: "Outside the mandate",
      tone: "blocked",
      takeaway: "Anything outside your mandate stops with a reason. It never turns into a surprise pop-up.",
      steps: [
        {
          label: "Ask",
          title: "Pilot asks for something off the list",
          caption: "For example a product you didn't approve, or one that costs more than your per-purchase cap.",
          route: ["pilot", "harbor"],
          carries: "Shop and product",
        },
        {
          label: "Stop",
          title: "One failed rule stops it",
          caption: "Harbor names the rule that failed. No proof is created and nothing is paid.",
          route: ["harbor"],
          outcome: "stop",
        },
        {
          label: "Explain",
          title: "No surprise wallet pop-up",
          caption:
            "A blocked purchase never turns into a request for your signature, and Pilot doesn't retry it. To allow more, you sign a new mandate on purpose.",
          route: ["harbor", "pilot", "you"],
          outcome: "stop",
        },
      ],
    },
    {
      id: "safety",
      label: "Revoke or pause",
      tone: "degraded",
      takeaway: "You can switch the agent off at any moment, and an unclear payment is never paid twice.",
      steps: [
        {
          label: "Revoke",
          title: "You switch the agent off",
          caption: "Revoke is a button for you, never a tool for the AI. Harbor marks the mandate revoked straight away.",
          route: ["you", "pilot", "harbor"],
          outcome: "stop",
        },
        {
          label: "Refuse",
          title: "The next purchase is refused",
          caption: "Harbor won't create proofs or payments for a revoked mandate.",
          route: ["pilot", "harbor"],
          outcome: "stop",
        },
        {
          label: "Freeze",
          title: "Unexpected payments freeze the payer",
          caption:
            "If the QuickNode watchdog sees Harbor's payer account used outside Harbor, Harbor freezes it. This is shown with mock data today.",
          route: ["xrpl", "harbor"],
          outcome: "stop",
        },
        {
          label: "Pending",
          title: "Unclear means pending, not paid",
          caption: "If a payment isn't confirmed yet, Pilot shows it as pending and never pays twice.",
          route: ["harbor", "pilot"],
          outcome: "wait",
        },
      ],
    },
  ],
};

const aws: IntegrationStory = {
  title: "Extra safety checks around Pilot, powered by AWS.",
  lede:
    "AWS adds three separate protections around Harbor. It screens text from the ledger for hidden instructions before the AI reads it, it can offer an AWS-hosted AI model, and it can keep Harbor's signing key locked inside AWS. None of them can approve a trade.",
  glance: {
    adds: "Text screening, an AWS-hosted AI model and locked signing keys.",
    control: "Harbor's rules and your wallet still decide what runs.",
    status: "Implemented and tested against a local AWS stand-in.",
  },
  idea: {
    without:
      "Text on the ledger, like a token's description, can hide instructions aimed at the AI. And an agent's signing key on a server could be copied.",
    with:
      "Guardrails scans that text first and hides anything suspicious. KMS signs inside AWS so the key can't leave. Every receipt shows which screen, model and signer were used.",
    never:
      "AWS can't grant permissions, raise limits or approve a trade. If a check fails, it stops; it never quietly skips the protection.",
  },
  actors: [
    { id: "model", label: "AI model", role: "AWS Bedrock", icon: "cpu", x: 26, y: 14 },
    { id: "guard", label: "Guardrails", role: "Screens text", icon: "scan", x: 46, y: 14 },
    { id: "kms", label: "KMS", role: "Holds the signing key", icon: "key", x: 84, y: 14 },
    { id: "pilot", label: "Pilot", role: "Request and receipt", icon: "pilot", x: 12, y: 50 },
    { id: "harbor", label: "Harbor", role: "Builds, applies rules", icon: "harbor", x: 58, y: 50 },
    { id: "you", label: "Your wallet", role: "Signs exceptions", icon: "wallet", x: 30, y: 80 },
    { id: "xrpl", label: "XRPL Testnet", role: "Final say", icon: "ledger", x: 84, y: 80 },
  ],
  flows: [
    {
      id: "screened-read",
      label: "Screened read",
      tone: "success",
      takeaway: "Strangers can't slip instructions to the AI through text stored on the ledger.",
      steps: [
        {
          label: "Ask",
          title: "You ask about ledger data",
          caption: "For example, “what is this token?”. Pilot asks Harbor to read it.",
          route: ["pilot", "harbor"],
        },
        {
          label: "Read",
          title: "Harbor reads the ledger",
          caption:
            "Some fields, like a token's name or a memo, are written by strangers and could contain hidden instructions for the AI.",
          route: ["harbor", "xrpl", "harbor"],
          carries: "Ledger data",
        },
        {
          label: "Screen",
          title: "Guardrails checks that text",
          caption:
            "Only the stranger-written fields are checked, and anything suspicious is replaced. If the screen is down, the text is hidden rather than passed through. Addresses and amounts stay visible.",
          route: ["harbor", "guard", "harbor"],
          outcome: "ok",
        },
        {
          label: "Answer",
          title: "The AI sees only the clean version",
          caption:
            "The model answers from screened data. Signed-in users can run it on AWS Bedrock; demo users stay on free models.",
          route: ["harbor", "pilot", "model"],
          carries: "Screened data",
        },
        {
          label: "Receipt",
          title: "The receipt says what checked it",
          caption: "Pilot shows which screen and model handled the request, and labels mocks as mocks.",
          route: ["model", "pilot"],
          outcome: "ok",
        },
      ],
    },
    {
      id: "auto-trade",
      label: "Automatic trade",
      tone: "success",
      takeaway: "Routine trades run automatically without the signing key ever leaving AWS.",
      steps: [
        {
          label: "Ask",
          title: "You ask for a small trade",
          caption: "Pilot sends Harbor an exact request.",
          route: ["pilot", "harbor"],
        },
        {
          label: "Rules",
          title: "Harbor's rules decide",
          caption:
            "Network, permissions, token, simulation, slippage and spending limits must all pass. AWS plays no part in this decision.",
          route: ["harbor"],
          outcome: "ok",
        },
        {
          label: "Sign",
          title: "KMS signs; the key never leaves",
          caption:
            "Harbor sends only the bytes to sign, then checks the signature itself. If KMS fails, the trade stops; there's no backup key.",
          route: ["harbor", "kms", "harbor"],
          carries: "Bytes to sign",
        },
        {
          label: "Confirm",
          title: "The ledger confirms it",
          caption: "A trade only counts once XRPL Testnet validates it.",
          route: ["harbor", "xrpl"],
          outcome: "ok",
        },
        {
          label: "Receipt",
          title: "You see who signed",
          caption: "The receipt shows the signer, so you know the KMS-held key made this trade.",
          route: ["xrpl", "harbor", "pilot"],
        },
      ],
    },
    {
      id: "approval-revoke",
      label: "Needs you, or revoke",
      tone: "approval",
      takeaway: "AWS adds protection, never authority: bigger moves still come to you.",
      steps: [
        {
          label: "Bigger",
          title: "Bigger trades come back to you",
          caption:
            "Over your auto limit, or a type you didn't delegate? Harbor asks you to sign in your own wallet. AWS never sees your key.",
          route: ["harbor", "pilot", "you"],
          outcome: "wait",
        },
        {
          label: "Watch",
          title: "Someone else uses the permission",
          caption:
            "If Harbor's watcher sees its delegated permission used for a trade Harbor didn't make, it suspends the link immediately.",
          route: ["xrpl", "harbor"],
          outcome: "stop",
        },
        {
          label: "Revoke",
          title: "You remove the permission",
          caption: "Harbor prepares the revoke and you sign it. The ledger has the final word.",
          route: ["you", "pilot", "harbor", "xrpl"],
          outcome: "stop",
        },
        {
          label: "Retire",
          title: "The old key is retired",
          caption: "Once the ledger confirms the revoke, Harbor retires the exact KMS key that link used.",
          route: ["harbor", "kms"],
        },
      ],
    },
  ],
};

const quicknode: IntegrationStory = {
  title: "A faster line to the ledger, with a watchdog on Harbor's keys.",
  lede:
    "QuickNode is how Harbor talks to the XRP Ledger: it carries requests, reports transactions the moment they're confirmed, and watches the accounts Harbor controls. If one of Harbor's keys is used outside Harbor, Harbor freezes it.",
  glance: {
    adds: "Ledger access, instant confirmations and a watchdog.",
    control: "QuickNode carries and reports. Harbor decides; you revoke.",
    status: "Built and mock-tested. Live account activation pending.",
  },
  idea: {
    without:
      "Pilot can't show which node answered, waits for confirmations by checking again and again, and wouldn't notice if a Harbor key were used somewhere else.",
    with:
      "Every answer says which route served it. Confirmations arrive as soon as the ledger validates. A watchdog compares ledger activity with what Harbor actually did.",
    never:
      "QuickNode never decides or signs, and its keys never reach your browser. A freeze only stops Harbor; only your signature removes a permission everywhere.",
  },
  actors: [
    { id: "pilot", label: "Pilot", role: "Your request", icon: "pilot", x: 10, y: 46 },
    { id: "you", label: "Your wallet", role: "Signs a revoke", icon: "wallet", x: 22, y: 82 },
    { id: "harbor", label: "Harbor", role: "Decides and signs", icon: "harbor", x: 38, y: 46 },
    { id: "quicknode", label: "QuickNode", role: "Carries and watches", icon: "radio", x: 66, y: 14 },
    { id: "backup", label: "Backup node", role: "Labelled fallback", icon: "server", x: 66, y: 80 },
    { id: "xrpl", label: "XRP Ledger", role: "Validates", icon: "ledger", x: 90, y: 46 },
  ],
  flows: [
    {
      id: "supported-route",
      label: "Normal route",
      tone: "success",
      takeaway: "Faster confirmations, and every answer says which route it came from.",
      steps: [
        {
          label: "Ask",
          title: "You ask Pilot to trade",
          caption: "Pilot sends Harbor an exact request. QuickNode details never reach your browser.",
          route: ["pilot", "harbor"],
        },
        {
          label: "Decide",
          title: "Harbor decides",
          caption: "Harbor builds the transaction, checks your limits, then runs it, asks you or blocks it. QuickNode has no say.",
          route: ["harbor"],
          outcome: "ok",
        },
        {
          label: "Send",
          title: "QuickNode carries it",
          caption: "Supported requests go through QuickNode, which delivers the signed transaction to the ledger.",
          route: ["harbor", "quicknode", "xrpl"],
          carries: "Signed transaction",
        },
        {
          label: "Confirm",
          title: "Confirmation arrives right away",
          caption:
            "When the ledger validates it, QuickNode tells Harbor. Harbor checks the message is genuine and matches it to the trade it sent.",
          route: ["xrpl", "quicknode", "harbor"],
          outcome: "ok",
        },
        {
          label: "Show",
          title: "Pilot shows where it came from",
          caption: "The receipt names the route (QuickNode, or mock today) and how fast the confirmation came.",
          route: ["harbor", "pilot"],
        },
      ],
    },
    {
      id: "visible-fallback",
      label: "Backup route",
      tone: "degraded",
      takeaway: "If QuickNode stumbles, Pilot keeps working in the open and never sends a trade twice.",
      steps: [
        {
          label: "Ask",
          title: "You ask for ledger data",
          caption: "Pilot asks Harbor for current prices or balances.",
          route: ["pilot", "harbor"],
        },
        {
          label: "Miss",
          title: "QuickNode can't answer",
          caption: "The method may not be supported, or the service may be down.",
          route: ["harbor", "quicknode"],
          outcome: "wait",
        },
        {
          label: "Fallback",
          title: "A backup node answers, labelled",
          caption: "Harbor switches to a public node and the receipt says “fallback”, so it's never hidden.",
          route: ["harbor", "backup", "xrpl"],
          outcome: "ok",
        },
        {
          label: "No resend",
          title: "A trade is never sent twice",
          caption:
            "If QuickNode is rate-limited while sending a trade, Harbor doesn't resend it elsewhere. It checks the ledger instead.",
          route: ["harbor"],
          outcome: "stop",
        },
      ],
    },
    {
      id: "watchdog-freeze",
      label: "Watchdog freeze",
      tone: "blocked",
      takeaway: "If Harbor's key is ever used elsewhere, Harbor stops itself and hands you the revoke.",
      steps: [
        {
          label: "Spot",
          title: "The watchdog spots activity",
          caption: "QuickNode flags a transaction on an account Harbor watches.",
          route: ["xrpl", "quicknode", "harbor"],
        },
        {
          label: "Check",
          title: "Harbor checks whose it was",
          caption: "Was it Harbor's own trade, your own action, or Harbor's key used somewhere else?",
          route: ["harbor"],
        },
        {
          label: "Freeze",
          title: "Harbor freezes its own key",
          caption: "If the key was used elsewhere, Harbor stops using it and blocks the next trade before it's sent. Pilot shows a short warning.",
          route: ["harbor", "pilot"],
          outcome: "stop",
        },
        {
          label: "Revoke",
          title: "Only you can remove it everywhere",
          caption: "A freeze stops Harbor. To remove the permission on the ledger, you review and sign a revoke.",
          route: ["pilot", "you"],
          outcome: "wait",
        },
      ],
    },
  ],
};

const ledger: IntegrationStory = {
  title: "Routine trades run on their own. Anything bigger asks your Ledger.",
  lede:
    "Pilot treats a Ledger hardware wallet as the owner's final say. Small trades inside your limits run automatically through Harbor's limited key. Granting or removing permissions, and anything over your limits, goes to the Ledger for you to approve.",
  glance: {
    adds: "A hardware-wallet approval step for anything outside your limits.",
    control: "Only the Ledger can grant, revoke or approve exceptions.",
    status: "Runs Ledger's real XRP app in the Speculos emulator.",
  },
  idea: {
    without: "Either you approve every single trade, or the agent gets your key. Neither works.",
    with:
      "Harbor gets a separate, limited key for routine trades. Everything else goes to the Ledger, which shows you the transaction and signs only after you confirm.",
    never:
      "The Ledger only signs, it never sends. Pilot checks the signature, and that nothing was changed, before Harbor submits it.",
  },
  actors: [
    { id: "you", label: "You", role: "Ask and approve", icon: "user", x: 10, y: 46 },
    { id: "pilot", label: "Pilot", role: "Builds it exactly", icon: "pilot", x: 34, y: 46 },
    { id: "device", label: "Ledger", role: "Simulated in Speculos", icon: "device", x: 50, y: 82 },
    { id: "harbor", label: "Harbor", role: "Checks your limits", icon: "harbor", x: 62, y: 46 },
    { id: "delegate", label: "Harbor's key", role: "Routine trades only", icon: "key", x: 76, y: 14 },
    { id: "xrpl", label: "XRPL Testnet", role: "Validates", icon: "ledger", x: 90, y: 46 },
  ],
  flows: [
    {
      id: "delegate-path",
      label: "Routine trade",
      tone: "success",
      takeaway: "Small trades inside your limits happen without bothering you.",
      steps: [
        {
          label: "Ask",
          title: "You ask for a trade",
          caption: "The AI can suggest it, but it can't sign or change permissions.",
          route: ["you", "pilot"],
        },
        {
          label: "Exact",
          title: "Pilot makes it exact",
          caption: "Pilot turns the request into an exact XRPL transaction you could check field by field.",
          route: ["pilot", "harbor"],
          carries: "Exact transaction",
        },
        {
          label: "Check",
          title: "It's inside your limits",
          caption: "Harbor checks the permissions you granted, the token, slippage and spending limits. This one passes.",
          route: ["harbor"],
          outcome: "ok",
        },
        {
          label: "Run",
          title: "Harbor's limited key signs",
          caption:
            "A separate key that can only do what you granted (seven actions by default) signs and submits it. Your Ledger isn't needed.",
          route: ["harbor", "delegate", "xrpl"],
          outcome: "ok",
        },
      ],
    },
    {
      id: "speculos-approval",
      label: "Ledger approval",
      tone: "approval",
      takeaway: "Anything bigger waits for your yes on the Ledger.",
      steps: [
        {
          label: "Over",
          title: "This one needs you",
          caption: "It's over your limit, so Harbor sends it back for your approval.",
          route: ["harbor", "pilot"],
          outcome: "wait",
        },
        {
          label: "Review",
          title: "You check it on the Ledger",
          caption: "The Ledger shows the transaction. Here it's the Speculos emulator running Ledger's real XRP app 2.8.2.",
          route: ["pilot", "device"],
          carries: "Transaction to review",
        },
        {
          label: "Verify",
          title: "Pilot checks the signature",
          caption: "Pilot confirms it's your account, nothing was changed, and the signature is valid.",
          route: ["device", "pilot"],
          outcome: "ok",
        },
        {
          label: "Send",
          title: "Harbor sends the exact transaction",
          caption: "The Ledger signs only. Harbor submits exactly what you approved, and the ledger has the final word.",
          route: ["pilot", "harbor", "xrpl"],
          outcome: "ok",
        },
      ],
    },
    {
      id: "reject-expire-revoke",
      label: "Reject or revoke",
      tone: "blocked",
      takeaway: "Your no is final, and you can switch automation off at any time.",
      steps: [
        {
          label: "Reject",
          title: "You say no on the Ledger",
          caption: "Nothing is signed and nothing is sent.",
          route: ["device", "pilot"],
          outcome: "stop",
        },
        {
          label: "Expire",
          title: "Expired means rebuild",
          caption: "If an approval waits too long, Pilot builds it again from your request instead of reusing the old one.",
          route: ["pilot", "harbor"],
          outcome: "wait",
        },
        {
          label: "Revoke",
          title: "You switch automation off",
          caption: "Removing Harbor's permissions is signed on the Ledger too. Once confirmed, Harbor's key can do nothing.",
          route: ["pilot", "device", "pilot", "harbor", "xrpl"],
          outcome: "stop",
        },
      ],
    },
  ],
};

export const integrationStories: Record<IntegrationSlug, IntegrationStory> = {
  mastercard,
  aws,
  quicknode,
  ledger,
};
