import { usePayments } from "../hooks/usePayments";
import { formatNaira } from "../utils/currency";
import "./AdminTables.css";

export default function AdminPayments() {
  const { payments, loading, error, retry } = usePayments();

  return (
    <section className="admin-page">
      <div className="admin-page-header">
        <div>
          <h1>Payments</h1>
          <p>Live payment records from payment-service.</p>
        </div>
      </div>

      <div className="table-card">
        {loading && <p>Loading payments...</p>}

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
                <th>Payment ID</th>
                <th>Order ID</th>
                <th>Customer</th>
                <th>Email</th>
                <th>Amount</th>
                <th>Status</th>
                <th>Date</th>
              </tr>
            </thead>

            <tbody>
              {payments.map((payment) => (
                <tr key={payment.id}>
                  <td>#{payment.id.slice(0, 8)}</td>
                  <td>#{payment.order_id.slice(0, 8)}</td>
                  <td>{payment.customer_name}</td>
                  <td>{payment.customer_email}</td>
                  <td>{formatNaira(payment.amount)}</td>
                  <td>
                    <span className="paid-badge">{payment.status}</span>
                  </td>
                  <td>{new Date(payment.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}