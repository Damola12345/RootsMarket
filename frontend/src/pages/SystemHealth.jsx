import { useHealth } from "../hooks/useHealth";
import "./AdminTables.css";

function formatDependencies(dependencies) {
  const entries = Object.entries(dependencies || {});

  if (entries.length === 0) {
    return "No dependency data";
  }

  return entries
    .map(([name, status]) => `${name}: ${status}`)
    .join(", ");
}

export default function SystemHealth() {
  const { services, loading, error, retry } = useHealth();

  return (
    <section className="admin-page">
      <div className="admin-page-header">
        <div>
          <h1>System Health</h1>
          <p>Live health checks from RootsMarket services.</p>
        </div>

        <button onClick={retry}>Refresh</button>
      </div>

      <div className="table-card">
        {loading && <p>Checking service health...</p>}

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
                <th>Service</th>
                <th>Endpoint</th>
                <th>Status</th>
                <th>Dependencies</th>
                <th>Last Check</th>
              </tr>
            </thead>

            <tbody>
              {services.map((service) => (
                <tr key={service.name}>
                  <td>{service.name}</td>
                  <td>{service.url}</td>
                  <td>
                    <span
                      className={
                        service.status === "healthy"
                          ? "paid-badge"
                          : "unhealthy-badge"
                      }
                    >
                      {service.status}
                    </span>
                  </td>
                  <td>{formatDependencies(service.dependencies)}</td>
                  <td>{new Date(service.checkedAt).toLocaleTimeString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}