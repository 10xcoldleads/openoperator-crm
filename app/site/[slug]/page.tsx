import PublicSite from "./PublicSite";
export default async function SiteHome({ params }: { params: Promise<{ slug: string }> }) { const { slug } = await params; return <PublicSite slug={slug} path="/"/>; }
