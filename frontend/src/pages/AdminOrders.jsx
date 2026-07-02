import { useOrders } from "../hooks/useOrders";
import { formatNaira } from "../utils/currency";
import "./AdminTables.css";

export default function AdminOrders() {
  const { orders, loading, error, retry } = useOrders();

  return (
    <section className="admin-page">
      <div className="admin-page-header">
        <div>
          <h1>Orders</h1>
          <p>Live customer orders from order-service.</p>
        </div>
      </div>

      <div className="table-card">
        {loading && <p>Loading orders...</p>}

        {!loading && error && (
          <div>
            <p>{error}</p>
            <button onClick={retry}>Retry</button>
          </div>
        )}

        {!loading && !error && (
          <table className="admin-table full">
            <thead>
              <tr>
                <th>Order ID</th>
                <th>Customer</th>
                <th>Email</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Date</th>
              </tr>
            </thead>

            <tbody>
              {orders.map((order) => (
                <tr key={order.id}>
                  <td>#{order.id.slice(0, 8)}</td>
                  <td>{order.customer_name}</td>
                  <td>{order.customer_email}</td>
                  <td>{formatNaira(order.total_amount)}</td>
                  <td>
                    <span className="paid-badge">{order.status}</span>
                  </td>
                  <td>{new Date(order.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}