import { Link } from "react-router-dom";
import Header from "../components/Header";
import { useOrders } from "../hooks/useOrders";
import { formatNaira } from "../utils/currency";
import "./MyOrders.css";

export default function MyOrders() {
  const { orders, loading, error, retry } = useOrders();

  return (
    <div>
      <Header cartCount={0} />

      <main className="orders-page">
        <div className="orders-header">
          <div>
            <h2>My Orders</h2>
            <p>Track recent RootsMarket orders.</p>
          </div>

          <Link to="/" className="continue-shopping">
            Continue Shopping
          </Link>
        </div>

        {loading && (
          <section className="empty-orders">
            <h3>Loading orders...</h3>
          </section>
        )}

        {!loading && error && (
          <section className="empty-orders">
            <h3>Unable to load orders</h3>
            <p>{error}</p>
            <button onClick={retry}>Retry</button>
          </section>
        )}

        {!loading && !error && orders.length === 0 && (
          <section className="empty-orders">
            <h3>No orders yet</h3>
            <p>Your orders will appear here after checkout.</p>
          </section>
        )}

        {!loading && !error && orders.length > 0 && (
          <section className="orders-list">
            {orders.map((order) => (
              <article key={order.id} className="order-card">
                <div className="order-top">
                  <div>
                    <p className="order-label">Order ID</p>
                    <h3>#{order.id.slice(0, 8)}</h3>
                  </div>

                  <span className="status-badge">{order.status}</span>
                </div>

                <p>
                  Customer: <strong>{order.customer_name}</strong>
                </p>

                <div className="order-total">
                  <span>Total</span>
                  <strong>{formatNaira(order.total_amount)}</strong>
                </div>
              </article>
            ))}
          </section>
        )}
      </main>
    </div>
  );
}