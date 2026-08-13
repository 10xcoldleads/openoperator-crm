import PublicSite from "../PublicSite";
export default async function SitePage({ params }: { params: Promise<{ slug: string; path: string[] }> }) { const { slug, path } = await params; return <PublicSite slug={slug} path={`/${path.join("/")}`}/>; }
