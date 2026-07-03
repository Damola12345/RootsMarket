import { Link } from "react-router-dom";
import "./Header.css";

export default function Header({ cartCount }) {
  return (
    <header className="header">
      <Link to="/" className="brand">
        <h1>RootsMarket</h1>
        <p>Traditional food products, delivered fresh.</p>
      </Link>

      <nav>
        <Link to="/">Home</Link>
        <Link to="/store">Store</Link>
        <Link to="/my-orders">My Orders</Link>
        <Link to="/store" className="cart-button">
          Cart ({cartCount})
        </Link>
      </nav>
    </header>
  );
}