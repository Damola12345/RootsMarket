import { Link, NavLink, Outlet } from "react-router-dom";
import "./AdminLayout.css";

export default function AdminLayout() {
  return (
    <div className="admin-shell">
      <aside className="admin-sidebar">
        <Link to="/" className="admin-logo">
          RootsMarket
        </Link>

        <nav className="admin-nav">
          <NavLink to="/admin" end>
            Dashboard
          </NavLink>
          <NavLink to="/admin/products">Products</NavLink>
          <NavLink to="/admin/customers">Customers</NavLink>
          <NavLink to="/admin/orders">Orders</NavLink>
          <NavLink to="/admin/payments">Payments</NavLink>
          <NavLink to="/admin/health">System Health</NavLink>
        </nav>

        <Link to="/" className="store-link">
          ← Back to Store
        </Link>
      </aside>

      <main className="admin-main">
        <Outlet />
      </main>
    </div>
  );
}