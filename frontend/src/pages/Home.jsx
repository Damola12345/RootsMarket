import { Link } from "react-router-dom";

import Header from "../components/Header";

import garriImage from "../assets/garri.jpg";
import eluboImage from "../assets/elubo.jpeg";
import honeyImage from "../assets/honey.jpg";
import palmOilImage from "../assets/palm-oil.jpeg";

import "./Home.css";

export default function Home({ cartCount }) {
  return (
    <div>
      <Header cartCount={cartCount} />

      <main className="home-page">
        <section className="home-hero">
          <div>
            <p className="home-kicker">Pure. Natural. Trusted.</p>
            <h2>Traditional Nigerian Food Products</h2>
            <p>
              Inspired by a family business, RootsMarket brings fresh Garri,
              Elubo, Palm Oil, Honey, and Ori to everyday homes.
            </p>

            <div className="home-actions">
              <Link to="/store">Shop Products</Link>
              <span>Freshly sourced from trusted local producers.</span>
            </div>
          </div>

          <div className="home-hero-images">
            <img src={garriImage} alt="Garri" className="home-main-image" />
            <img src={palmOilImage} alt="Palm Oil" />
          </div>
        </section>

        <section className="why-section">
          <article>
            <h3>Fresh Products</h3>
            <p>Quality traditional food products for everyday meals.</p>
          </article>

          <article>
            <h3>Family Inspired</h3>
            <p>Built around a real family business story.</p>
          </article>

          <article>
            <h3>Trusted Service</h3>
            <p>Reliable ordering, secure payments, and a seamless shopping experience.</p>
          </article>
        </section>

        <section className="featured-section">
          <div className="section-title">
            <h2>Featured Products</h2>
            <Link to="/store">View all products →</Link>
          </div>

          <div className="featured-grid">
            <article>
              <img src={garriImage} alt="Garri" />
              <h3>Garri</h3>
              <p>₦5,000</p>
            </article>

            <article>
              <img src={eluboImage} alt="Elubo" />
              <h3>Elubo</h3>
              <p>₦6,000</p>
            </article>

            <article>
              <img src={honeyImage} alt="Honey" />
              <h3>Honey</h3>
              <p>₦12,000</p>
            </article>
          </div>
        </section>
      </main>
    </div>
  );
}