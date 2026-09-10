import type { Metadata } from "next";
import { getTranslations } from "next-intl/server";
import PartnerNav from "@/components/landing/PartnerNav";
import PartnerHero from "@/components/landing/PartnerHero";
import Metrics from "@/components/landing/Metrics";
import PartnerWhy from "@/components/landing/PartnerWhy";
import Streams from "@/components/landing/Streams";
import ContributionTiers from "@/components/landing/ContributionTiers";
import PartnerLine from "@/components/landing/PartnerLine";
import Partners from "@/components/landing/Partners";
import DeckDownload from "@/components/landing/DeckDownload";
import Band from "@/components/landing/Band";
import Footer from "@/components/landing/Footer";
import ScrollReveal from "@/components/ScrollReveal";

export async function generateMetadata({
  params,
}: PageProps<"/[locale]/partners">): Promise<Metadata> {
  const { locale } = await params;
  const t = await getTranslations({ locale, namespace: "PartnerMetadata" });
  const title = t("title");
  const description = t("description");

  return {
    title,
    description,
    openGraph: { title, description, type: "website" },
    twitter: { card: "summary_large_image", title, description },
  };
}

export default function PartnersPage() {
  return (
    <>
      <PartnerNav />
      <PartnerHero />
      <Metrics />
      <PartnerWhy />
      <Streams />
      <ContributionTiers />
      <PartnerLine />
      <Partners />
      <DeckDownload />
      <Band />
      <Footer />
      <ScrollReveal />
    </>
  );
}
