import { useState } from "react";

import Header from "../components/Header";
import ProductCard from "../components/ProductCard";
import Cart from "../components/Cart";

import garriImage from "../assets/garri.jpg";
import eluboImage from "../assets/elubo.jpeg";
import eluboIsuImage from "../assets/elubo-isu.jpeg";
import palmOilImage from "../assets/palm-oil.jpeg";
import honeyImage from "../assets/honey.jpg";
import oriImage from "../assets/ori.jpeg";

import "./Store.css";

const mockProducts = [
  {
    id: "garri",
    name: "Garri",
    price: 5000,
    stock: 100,
    image: garriImage,
    description: "Premium quality garri, perfect for everyday meals.",
  },
  {
    id: "elubo",
    name: "Elubo",
    price: 6000,
    stock: 100,
    image: eluboImage,
    description: "Finely ground yam flour for smooth amala.",
  },
  {
    id: "elubo-isu",
    name: "Elubo Isu",
    price: 7000,
    stock: 80,
    image: eluboIsuImage,
    description: "Unground yam flour source for traditional preparation.",
  },
  {
    id: "palm-oil",
    name: "Palm Oil",
    price: 8000,
    stock: 100,
    image: palmOilImage,
    description: "Pure red palm oil, naturally rich and nutritious.",
  },
  {
    id: "honey",
    name: "Honey",
    price: 12000,
    stock: 50,
    image: honeyImage,
    description: "Pure natural honey sourced from trusted producers.",
  },
  {
    id: "ori",
    name: "Ori (Shea Butter)",
    price: 4000,
    stock: 120,
    image: oriImage,
    description: "Natural shea butter for skin, hair, and home use.",
  },
];

export default function Store() {
  const [cartItems, setCartItems] = useState([]);

  function addToCart(product) {
    setCartItems((currentItems) => {
      const existingItem = currentItems.find((item) => item.id === product.id);

      if (existingItem) {
        return currentItems.map((item) =>
          item.id === product.id
            ? { ...item, quantity: item.quantity + 1 }
            : item
        );
      }

      return [...currentItems, { ...product, quantity: 1 }];
    });
  }

  function removeFromCart(productId) {
    setCartItems((currentItems) =>
      currentItems.filter((item) => item.id !== productId)
    );
  }

  function checkout() {
    alert("Checkout page coming next.");
  }

  const cartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <div>
      <Header cartCount={cartCount} />

      <main className="store-layout">
        <section className="store-content">
          <section className="hero">
            <div className="hero-copy">
              <p className="hero-kicker">Pure. Natural. Trusted.</p>

              <h2>Traditional Nigerian Food Products</h2>

              <p className="hero-text">
                Inspired by a family business, RootsMarket brings fresh Garri,
                Elubo, Elubo Isu, Palm Oil, Honey, and Ori to everyday homes.
              </p>

              <div className="hero-actions">
                <button>Shop Now</button>
                <span>Freshly sourced from trusted local producers.</span>
              </div>
            </div>

            <div className="hero-images">
              <img src={garriImage} alt="Garri" className="hero-main-image" />

              <div className="hero-small-images">
                <img src={palmOilImage} alt="Palm Oil" />
                <img src={oriImage} alt="Ori Shea Butter" />
              </div>
            </div>
          </section>

          <section className="product-section">
            <div className="section-heading">
              <h2>Shop Our Products</h2>
              <p>Fresh traditional products from trusted local sources.</p>
            </div>

            <div className="product-grid">
              {mockProducts.map((product) => (
                <ProductCard
                  key={product.id}
                  product={product}
                  onAddToCart={addToCart}
                />
              ))}
            </div>
          </section>
        </section>

        <Cart
          items={cartItems}
          onRemoveItem={removeFromCart}
          onCheckout={checkout}
        />
      </main>
    </div>
  );
}