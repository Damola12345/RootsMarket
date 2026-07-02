import { useNavigate } from "react-router-dom";

import Header from "../components/Header";
import ProductCard from "../components/ProductCard";
import Cart from "../components/Cart";

import { useProducts } from "../hooks/useProducts";

import "./Store.css";

export default function Store({ cartItems, addToCart, removeFromCart }) {
  const navigate = useNavigate();
  const { products, loading, error, retry } = useProducts();

  const cartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);

  return (
    <div>
      <Header cartCount={cartCount} />

      <main className="store-layout">
        <section className="store-content">
          <section className="store-intro">
            <p>RootsMarket Store</p>
            <h2>Shop Traditional Products</h2>
            <span>Browse fresh products and add them to your cart.</span>
          </section>

          <section className="product-section">
            <div className="section-heading">
              <h2>Shop Our Products</h2>
              <p>Fresh traditional products from trusted local sources.</p>
            </div>

            {loading && (
              <div className="state-card">
                <p>Loading products...</p>
              </div>
            )}

            {!loading && error && (
              <div className="state-card error-card">
                <p>{error}</p>
                <button onClick={retry}>Retry</button>
              </div>
            )}

            {!loading && !error && (
              <div className="product-grid">
                {products.map((product) => (
                  <ProductCard
                    key={product.id}
                    product={product}
                    onAddToCart={addToCart}
                  />
                ))}
              </div>
            )}
          </section>
        </section>

        <Cart
          items={cartItems}
          onRemoveItem={removeFromCart}
          onCheckout={() => navigate("/checkout")}
        />
      </main>
    </div>
  );
}