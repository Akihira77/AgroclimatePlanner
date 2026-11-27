import type { ReactNode } from "react";
import { useEffect, useState } from "react";

/**
 * Hash routing, by hand.
 *
 * Four screens and one detail segment do not justify a router dependency, and the
 * deployed app is a static bundle served next to the API — a hash path needs no
 * server rewrite rule on either side. `navigate` is the only writer; every page
 * reads `useRoute()`.
 */
export type Route = { readonly path: string; readonly segments: readonly string[] };

function readRoute(): Route {
  const raw = window.location.hash.replace(/^#/, "");
  const path = raw === "" ? "/" : raw;
  return { path, segments: path.split("/").filter((segment) => segment !== "") };
}

export function useRoute(): Route {
  const [route, setRoute] = useState(readRoute);

  useEffect(() => {
    const onChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);

  return route;
}

export function navigate(path: string): void {
  window.location.hash = path;
}

interface LinkProps {
  readonly to: string;
  readonly className?: string;
  readonly children: ReactNode;
}

export function Link({ to, className, children }: LinkProps) {
  return (
    <a
      href={`#${to}`}
      className={className}
      onClick={(event) => {
        // Let the browser handle modifier clicks; only plain navigation is ours.
        if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}
