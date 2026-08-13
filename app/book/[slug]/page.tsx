import PublicBooking from "./PublicBooking";

export default async function BookingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = await params;
  return <PublicBooking slug={slug} />;
}
