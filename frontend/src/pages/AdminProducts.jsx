import { useProducts } from "../hooks/useProducts";
import { formatNaira } from "../utils/currency";
import "./AdminTables.css";

export default function AdminProducts() {
  const { products, loading, error, retry } = useProducts();

  return (
    <section className="admin-page">
      <div className="admin-page-header">
        <div>
          <h1>Products</h1>
          <p>Live product catalog from product-service.</p>
        </div>
      </div>

      <div className="table-card">
        {loading && <p>Loading products...</p>}

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
                <th>Product</th>
                <th>Category</th>
                <th>Price</th>
                <th>Stock</th>
              </tr>
            </thead>

            <tbody>
              {products.map((product) => (
                <tr key={product.id}>
                  <td className="product-cell">
                    <img src={product.image} alt={product.name} />
                    <span>{product.name}</span>
                  </td>
                  <td>Traditional Food</td>
                  <td>{formatNaira(product.price)}</td>
                  <td>{product.stock}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
    </section>
  );
}