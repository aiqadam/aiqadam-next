import Nav from "@/components/landing/Nav";
import Hero from "@/components/landing/Hero";
import Metrics from "@/components/landing/Metrics";
import Creed from "@/components/landing/Creed";
import MapSection from "@/components/landing/MapSection";
import Events from "@/components/landing/Events";
import Streams from "@/components/landing/Streams";
import Doors from "@/components/landing/Doors";
import Team from "@/components/landing/Team";
import Partners from "@/components/landing/Partners";
import Band from "@/components/landing/Band";
import Footer from "@/components/landing/Footer";
import ScrollReveal from "@/components/ScrollReveal";

export default function Home() {
  return (
    <>
      <Nav />
      <Hero />
      <Metrics />
      <Creed />
      <MapSection />
      <Events />
      <Streams />
      <Doors />
      <Team />
      <Partners />
      <Band />
      <Footer />
      <ScrollReveal />
    </>
  );
}
