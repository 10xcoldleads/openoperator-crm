"use client";

import { useEffect, useState } from "react";

type Component =
  | { id: string; type: "hero"; eyebrow: string; heading: string; body: string; cta_label: string; cta_href: string }
  | { id: string; type: "text"; heading: string; body: string }
  | { id: string; type: "features"; heading: string; items: Array<{ title: string; body: string }> }
  | { id: string; type: "cta"; heading: string; body: string; cta_label: string; cta_href: string };
type Site = { slug: string; version: number; navigation: Array<{ path: string; title: string }>; page: { id: string; path: string; title: string; description: string; components: Component[] }; theme: { background: string; surface: string; text: string; accent: string; font: string } };

function publicHref(slug: string, href: string) {
  if (href === "/") return `/site/${slug}`;
  if (href.startsWith("/") && !href.startsWith("//")) return `/site/${slug}${href}`;
  return href;
}

export default function PublicSite({ slug, path }: { slug: string; path: string }) {
  const [site, setSite] = useState<Site | null>(null); const [error, setError] = useState("");
  useEffect(() => { let cancelled = false; void fetch(`/v1/public/sites/${encodeURIComponent(slug)}?path=${encodeURIComponent(path)}`, { credentials: "omit" }).then(async (response) => {
    const body = await response.json() as { site?: Site; error?: string }; if (!cancelled) { if (!response.ok || !body.site) setError(body.error || "This page is not available."); else setSite(body.site); }
  }).catch(() => { if (!cancelled) setError("This page could not be loaded."); }); return () => { cancelled = true; }; }, [slug, path]);
  useEffect(() => { if (!site) return; document.title = site.page.title; let description = document.querySelector('meta[name="description"]') as HTMLMetaElement | null; const created = !description; if (!description) { description = document.createElement("meta"); description.name = "description"; document.head.appendChild(description); } description.content = site.page.description; return () => { if (created) description?.remove(); }; }, [site]);
  if (error) return <main className="published-site-error"><h1>Page unavailable.</h1><p>{error}</p></main>;
  if (!site) return <main className="published-site-loading">Loading published site…</main>;
  const style = { "--site-background": site.theme.background, "--site-surface": site.theme.surface, "--site-text": site.theme.text, "--site-accent": site.theme.accent, "--site-font": site.theme.font === "serif" ? "Georgia,serif" : site.theme.font === "mono" ? "ui-monospace,monospace" : "system-ui,sans-serif" } as React.CSSProperties;
  return <main className="published-site" style={style}><header><a href={`/site/${site.slug}`}>OPENOPERATOR SITE</a><nav aria-label="Site navigation">{site.navigation.map((item) => <a key={item.path} aria-current={item.path === site.page.path ? "page" : undefined} href={publicHref(site.slug, item.path)}>{item.title}</a>)}</nav><small>V{site.version}</small></header><article>{site.page.components.map((component) => <SiteComponent key={component.id} slug={site.slug} component={component}/>)}</article><footer>Hosted on OpenOperator · Custom domains are not active</footer></main>;
}

function SiteComponent({ slug, component }: { slug: string; component: Component }) {
  if (component.type === "hero") return <section id={component.id} className="published-hero"><p>{component.eyebrow}</p><h1>{component.heading}</h1><div>{component.body}</div>{component.cta_label && <a href={publicHref(slug, component.cta_href)}>{component.cta_label} <span>→</span></a>}</section>;
  if (component.type === "text") return <section id={component.id} className="published-text"><h2>{component.heading}</h2><p>{component.body}</p></section>;
  if (component.type === "features") return <section id={component.id} className="published-features"><h2>{component.heading}</h2><div>{component.items.map((item, index) => <article key={`${item.title}:${index}`}><small>{String(index + 1).padStart(2, "0")}</small><h3>{item.title}</h3><p>{item.body}</p></article>)}</div></section>;
  return <section id={component.id} className="published-cta"><div><h2>{component.heading}</h2><p>{component.body}</p></div>{component.cta_label && <a href={publicHref(slug, component.cta_href)}>{component.cta_label} <span>→</span></a>}</section>;
}
