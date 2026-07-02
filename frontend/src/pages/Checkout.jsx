import { useState } from "react";
import { Link, useNavigate } from "react-router-dom";

import Header from "../components/Header";
import { createUser, getUsers } from "../api/userApi";
import { createOrder } from "../api/orderApi";
import { formatNaira } from "../utils/currency";

import "./Checkout.css";

export default function Checkout({ cartItems, clearCart }) {
  const navigate = useNavigate();

  const [customer, setCustomer] = useState({
    name: "",
    email: "",
    phone: "",
    address: "",
  });

  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState("");

  const cartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);

  const total = cartItems.reduce(
    (sum, item) => sum + Number(item.price) * item.quantity,
    0
  );

  function handleChange(event) {
    setCustomer({
      ...customer,
      [event.target.name]: event.target.value,
    });
  }

  async function findOrCreateUser() {
    try {
      return await createUser({
        name: customer.name,
        email: customer.email,
      });
    } catch (err) {
      if (err?.response?.status !== 409) {
        throw err;
      }

      const users = await getUsers();
      const existingUser = users.find((user) => user.email === customer.email);

      if (!existingUser) {
        throw new Error("Customer email already exists but user was not found");
      }

      return existingUser;
    }
  }

  async function handleSubmit(event) {
    event.preventDefault();

    if (cartItems.length === 0) {
      setError("Your cart is empty.");
      return;
    }

    try {
      setSubmitting(true);
      setError("");

      const user = await findOrCreateUser();

      const orderPayload = {
        userId: user.id,
        items: cartItems.map((item) => ({
          productId: item.id,
          quantity: item.quantity,
        })),
      };

      const order = await createOrder(orderPayload);

      clearCart();

      navigate("/my-orders", {
        state: {
          createdOrderId: order.id,
        },
      });
    } catch (err) {
      setError(
        err?.response?.data?.error ||
          err.message ||
          "Unable to place order. Please try again."
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <div>
      <Header cartCount={cartCount} />

      <main className="checkout-page">
        <section className="checkout-card">
          <div>
            <Link to="/" className="back-link">
              ← Back to store
            </Link>

            <h2>Checkout</h2>
            <p>Enter customer details to place your order.</p>
          </div>

          {error && <p className="checkout-error">{error}</p>}

          <form onSubmit={handleSubmit} className="checkout-form">
            <label>
              Full Name
              <input
                name="name"
                value={customer.name}
                onChange={handleChange}
                required
              />
            </label>

            <label>
              Email
              <input
                name="email"
                type="email"
                value={customer.email}
                onChange={handleChange}
                required
              />
            </label>

            <label>
              Phone
              <input
                name="phone"
                value={customer.phone}
                onChange={handleChange}
                required
              />
            </label>

            <label>
              Delivery Address
              <textarea
                name="address"
                value={customer.address}
                onChange={handleChange}
                required
              />
            </label>

            <button disabled={submitting || cartItems.length === 0}>
              {submitting ? "Placing Order..." : "Place Order"}
            </button>
          </form>
        </section>

        <aside className="order-summary">
          <h3>Order Summary</h3>

          {cartItems.length === 0 ? (
            <p>No items in cart.</p>
          ) : (
            cartItems.map((item) => (
              <div key={item.id} className="summary-item">
                <span>
                  {item.name} × {item.quantity}
                </span>
                <strong>
                  {formatNaira(Number(item.price) * item.quantity)}
                </strong>
              </div>
            ))
          )}

          <div className="summary-total">
            <span>Total</span>
            <strong>{formatNaira(total)}</strong>
          </div>
        </aside>
      </main>
    </div>
  );
}