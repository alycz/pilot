import { permanentRedirect } from "next/navigation";

/**
 * The "how it works" explainer lives on the landing page as the animated
 * learning loop. Old links and bookmarks land there.
 */
export default function HowItWorksPage() {
  permanentRedirect("/#learning");
}
