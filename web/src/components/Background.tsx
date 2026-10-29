import { useEffect, useState } from "react";

const motionQuery = "(prefers-reduced-motion: reduce)";
const backgroundPath = `${import.meta.env.BASE_URL}bg/`;

export function Background() {
  const [reducedMotion, setReducedMotion] = useState(() => window.matchMedia(motionQuery).matches);

  useEffect(() => {
    const preference = window.matchMedia(motionQuery);
    const update = () => setReducedMotion(preference.matches);
    update();
    preference.addEventListener("change", update);
    return () => preference.removeEventListener("change", update);
  }, []);

  return (
    <div className="background" aria-hidden="true">
      {reducedMotion ? (
        <img src={`${backgroundPath}torii-poster.jpg`} alt="" />
      ) : (
        <video autoPlay muted loop playsInline aria-hidden="true" poster={`${backgroundPath}torii-poster.jpg`}>
          <source src={`${backgroundPath}torii.webm`} type="video/webm" />
          <source src={`${backgroundPath}torii.mp4`} type="video/mp4" />
        </video>
      )}
    </div>
  );
}
