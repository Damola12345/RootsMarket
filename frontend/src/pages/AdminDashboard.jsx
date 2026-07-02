import "./AdminDashboard.css";

const stats = [
  { label: "Total Orders", value: "12", change: "+20%" },
  { label: "Revenue", value: "₦60,000", change: "+18%" },
  { label: "Customers", value: "5", change: "+12%" },
  { label: "Products", value: "6", change: "+0%" },
  { label: "Payments", value: "12", change: "+20%" },
];

const recentOrders = [
  { id: "a44aeae7", date: "Jun 30, 2026", amount: "₦5,000", status: "Paid" },
  { id: "699f6d25", date: "Jun 30, 2026", amount: "₦10,000", status: "Paid" },
  { id: "8c2d1a99", date: "Jun 29, 2026", amount: "₦7,500", status: "Paid" },
  { id: "f1dc23b4", date: "Jun 28, 2026", amount: "₦2,500", status: "Paid" },
];

export default function AdminDashboard() {
  return (
    <section className="admin-page">
      <div className="admin-page-header">
        <div>
          <h1>Dashboard</h1>
          <p>Overview of RootsMarket operations.</p>
        </div>

        <span className="date-pill">Jun 24, 2026 - Jun 30, 2026</span>
      </div>

      <div className="stats-grid">
        {stats.map((stat) => (
          <article key={stat.label} className="stat-card">
            <p>{stat.label}</p>
            <h2>{stat.value}</h2>
            <span>{stat.change} vs last 7 days</span>
          </article>
        ))}
      </div>

      <div className="dashboard-grid">
        <section className="admin-panel large-panel">
          <h2>Orders Over Time</h2>

          <div className="fake-line-chart">
            <div style={{ height: "25%" }}></div>
            <div style={{ height: "45%" }}></div>
            <div style={{ height: "80%" }}></div>
            <div style={{ height: "50%" }}></div>
            <div style={{ height: "58%" }}></div>
            <div style={{ height: "68%" }}></div>
            <div style={{ height: "76%" }}></div>
          </div>

          <div className="chart-labels">
            <span>Jun 24</span>
            <span>Jun 25</span>
            <span>Jun 26</span>
            <span>Jun 27</span>
            <span>Jun 28</span>
            <span>Jun 29</span>
            <span>Jun 30</span>
          </div>
        </section>

        <section className="admin-panel">
          <h2>Orders by Status</h2>

          <div className="status-chart">
            <div className="donut"></div>

            <div className="status-list">
              <p>
                <span className="green-dot"></span> Paid — 80%
              </p>
              <p>
                <span className="yellow-dot"></span> Pending — 13%
              </p>
              <p>
                <span className="red-dot"></span> Cancelled — 7%
              </p>
            </div>
          </div>
        </section>

        <section className="admin-panel">
          <h2>Recent Orders</h2>

          <table className="admin-table">
            <tbody>
              {recentOrders.map((order) => (
                <tr key={order.id}>
                  <td>#{order.id}</td>
                  <td>{order.date}</td>
                  <td>{order.amount}</td>
                  <td>
                    <span className="paid-badge">{order.status}</span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      </div>
    </section>
  );
}