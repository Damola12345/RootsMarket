import { formatNaira } from "../utils/currency";
import "./ProductCard.css";

export default function ProductCard({ product, onAddToCart }) {
  return (
    <article className="product-card">
      <div className="product-image-wrap">
        <img src={product.image} alt={product.name} className="product-image" />
      </div>

      <div className="product-body">
        <h3>{product.name}</h3>
        <p>{product.description}</p>

        <div className="product-meta">
          <strong>{formatNaira(product.price)}</strong>
          <span>{product.stock} in stock</span>
        </div>

        <button onClick={() => onAddToCart(product)}>Add to Cart</button>
      </div>
    </article>
  );
}