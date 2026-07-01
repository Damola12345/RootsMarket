import "./Header.css";

export default function Header({ cartCount }) {
  return (
    <header className="header">
      <div>
        <h1>RootsMarket</h1>
        <p>Traditional food products, delivered fresh.</p>
      </div>

      <nav>
        <a href="/">Store</a>
        <a href="/admin">Admin</a>
        <button className="cart-button">Cart ({cartCount})</button>
      </nav>
    </header>
  );
}