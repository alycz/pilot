"use client";

import { useEffect, useState } from "react";

/** Height of the sticky landing nav plus breathing room, in px. */
const NAV_OFFSET = 72;
const REVEAL_SHIFT_PX = 10;
const REVEAL_MS = 520;
const STAGGER_MS = 60;
const STAGGER_CAP = 8;

function prefersReducedMotion(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

/** Scrolls to an in-page section, offset for the sticky nav, and moves focus to its heading. */
export function scrollToSection(id: string): void {
  const target = document.getElementById(id);
  if (!target) return;
  const reduced = prefersReducedMotion();
  const top = target.getBoundingClientRect().top + window.scrollY - NAV_OFFSET + 8;
  window.scrollTo({ top: Math.max(0, top), behavior: reduced ? "auto" : "smooth" });
  history.replaceState(null, "", `#${id}`);
  const heading = document.getElementById(`${id}-title`) ?? target;
  if (!heading.hasAttribute("tabindex")) heading.setAttribute("tabindex", "-1");
  heading.focus({ preventScroll: true });
}

/**
 * Progressive enhancement for the landing page:
 * - in-page anchor links scroll smoothly instead of jumping;
 * - blocks marked `data-reveal` fade and rise in once as they enter the viewport;
 *   children of `data-reveal-stagger` reveal one after another.
 * Nothing is hidden before this mounts, and nothing animates under reduced motion.
 */
export function LandingMotion() {
  // The page should stop at the footer: disable the elastic overscroll that
  // reveals blank background past the end (most visible in Safari).
  useEffect(() => {
    const root = document.documentElement;
    const body = document.body;
    const previous = [root.style.overscrollBehaviorY, body.style.overscrollBehaviorY];
    root.style.overscrollBehaviorY = "none";
    body.style.overscrollBehaviorY = "none";
    return () => {
      root.style.overscrollBehaviorY = previous[0];
      body.style.overscrollBehaviorY = previous[1];
    };
  }, []);

  useEffect(() => {
    const onClick = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
      const anchor = (event.target as Element | null)?.closest?.("a[href^='#']");
      if (!(anchor instanceof HTMLAnchorElement)) return;
      const id = anchor.getAttribute("href")?.slice(1);
      if (!id || id === "landing-main" || !document.getElementById(id)) return;
      event.preventDefault();
      anchor.closest("details")?.removeAttribute("open");
      scrollToSection(id);
    };
    document.addEventListener("click", onClick);
    return () => document.removeEventListener("click", onClick);
  }, []);

  useEffect(() => {
    if (prefersReducedMotion() || typeof IntersectionObserver === "undefined") return;

    const targets: HTMLElement[] = [];
    document.querySelectorAll<HTMLElement>("[data-reveal]").forEach((element) => targets.push(element));
    document.querySelectorAll<HTMLElement>("[data-reveal-stagger]").forEach((group) => {
      Array.from(group.children).forEach((child, index) => {
        if (child instanceof HTMLElement) {
          child.dataset.revealDelay = String(Math.min(index, STAGGER_CAP) * STAGGER_MS);
          targets.push(child);
        }
      });
    });

    const show = (element: HTMLElement) => {
      element.style.opacity = "1";
      element.style.transform = "none";
    };

    // Only hide what is still below the fold, so nothing visible ever blinks.
    const pending = targets.filter((element) => element.getBoundingClientRect().top > window.innerHeight * 0.92);
    for (const element of pending) {
      const delay = Number(element.dataset.revealDelay ?? 0);
      element.style.opacity = "0";
      element.style.transform = `translateY(${REVEAL_SHIFT_PX}px)`;
      element.style.transition = `opacity ${REVEAL_MS}ms cubic-bezier(0.22, 1, 0.36, 1) ${delay}ms, transform ${REVEAL_MS}ms cubic-bezier(0.22, 1, 0.36, 1) ${delay}ms`;
      element.style.willChange = "opacity, transform";
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (!entry.isIntersecting) continue;
          const element = entry.target as HTMLElement;
          show(element);
          observer.unobserve(element);
          window.setTimeout(() => {
            element.style.willChange = "";
          }, REVEAL_MS + Number(element.dataset.revealDelay ?? 0) + 50);
        }
      },
      { rootMargin: "0px 0px -8% 0px", threshold: 0.05 },
    );
    pending.forEach((element) => observer.observe(element));

    const revealAll = () => pending.forEach(show);
    window.addEventListener("beforeprint", revealAll);
    return () => {
      observer.disconnect();
      window.removeEventListener("beforeprint", revealAll);
      revealAll();
    };
  }, []);

  return null;
}

/** Tracks which of the given section ids is currently under the nav. */
export function useActiveSection(ids: readonly string[]): string | undefined {
  const [active, setActive] = useState<string>();
  useEffect(() => {
    let frame = 0;
    const update = () => {
      frame = 0;
      let current: string | undefined;
      for (const id of ids) {
        const element = document.getElementById(id);
        if (!element) continue;
        const rect = element.getBoundingClientRect();
        if (rect.top <= NAV_OFFSET + 40 && rect.bottom > NAV_OFFSET + 40) current = id;
      }
      setActive(current);
    };
    const onScroll = () => {
      if (!frame) frame = window.requestAnimationFrame(update);
    };
    update();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll);
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [ids]);
  return active;
}
