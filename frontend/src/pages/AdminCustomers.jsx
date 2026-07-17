import { useUsers } from "../hooks/useUsers";
import "./AdminTables.css";

export default function AdminCustomers() {
  const { users, loading, error, retry } = useUsers();

  return (
    <section className="admin-page">
      <div className="admin-page-header">
        <div>
          <h1>Customers</h1>
          <p>Live customers from user-service.</p>
        </div>
      </div>

      <div className="table-card">
        {loading && <p>Loading customers...</p>}

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
                <th>Name</th>
                <th>Email</th>
                <th>Joined</th>
              </tr>
            </thead>

            <tbody>
              {users.map((user) => (
                <tr key={user.id}>
                  <td>{user.name}</td>
                  <td>{user.email}</td>
                  <td>{new Date(user.created_at).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}