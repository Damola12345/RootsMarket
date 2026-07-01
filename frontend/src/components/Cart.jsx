import "./Cart.css";

export default function Cart({ items, onRemoveItem, onCheckout }) {
  const total = items.reduce(
    (sum, item) => sum + Number(item.price) * item.quantity,
    0
  );

  return (
    <aside className="cart">
      <h2>Your Cart</h2>

      {items.length === 0 ? (
        <p className="empty-cart">No items yet.</p>
      ) : (
        <>
          {items.map((item) => (
            <div key={item.id} className="cart-item">
              <div>
                <strong>{item.name}</strong>
                <p>
                  Qty {item.quantity} × ₦{Number(item.price).toLocaleString()}
                </p>
              </div>

              <button onClick={() => onRemoveItem(item.id)}>Remove</button>
            </div>
          ))}

          <div className="cart-total">
            <span>Total</span>
            <strong>₦{total.toLocaleString()}</strong>
          </div>

          <button className="checkout-button" onClick={onCheckout}>
            Checkout
          </button>
        </>
      )}
    </aside>
  );
}