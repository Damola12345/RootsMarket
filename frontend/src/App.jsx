import { useState } from "react";
import { BrowserRouter, Routes, Route } from "react-router-dom";

import Home from "./pages/Home";
import Store from "./pages/Store";
import Checkout from "./pages/Checkout";
import MyOrders from "./pages/MyOrders";

import AdminLayout from "./components/AdminLayout";
import AdminDashboard from "./pages/AdminDashboard";
import AdminProducts from "./pages/AdminProducts";
import AdminCustomers from "./pages/AdminCustomers";
import AdminOrders from "./pages/AdminOrders";
import AdminPayments from "./pages/AdminPayments";
import SystemHealth from "./pages/SystemHealth";

import "./App.css";

function AppRoutes() {
  const [cartItems, setCartItems] = useState([]);

  const cartCount = cartItems.reduce((sum, item) => sum + item.quantity, 0);

  function addToCart(product) {
    setCartItems((currentItems) => {
      const existingItem = currentItems.find((item) => item.id === product.id);

      if (existingItem) {
        return currentItems.map((item) =>
          item.id === product.id
            ? { ...item, quantity: item.quantity + 1 }
            : item
        );
      }

      return [...currentItems, { ...product, quantity: 1 }];
    });
  }

  function removeFromCart(productId) {
    setCartItems((currentItems) =>
      currentItems.filter((item) => item.id !== productId)
    );
  }

  function clearCart() {
    setCartItems([]);
  }

  return (
    <Routes>
      <Route path="/" element={<Home cartCount={cartCount} />} />

      <Route
        path="/store"
        element={
          <Store
            cartItems={cartItems}
            addToCart={addToCart}
            removeFromCart={removeFromCart}
          />
        }
      />

      <Route
        path="/checkout"
        element={<Checkout cartItems={cartItems} clearCart={clearCart} />}
      />

      <Route path="/my-orders" element={<MyOrders />} />

      <Route path="/admin" element={<AdminLayout />}>
        <Route index element={<AdminDashboard />} />
        <Route path="products" element={<AdminProducts />} />
        <Route path="customers" element={<AdminCustomers />} />
        <Route path="orders" element={<AdminOrders />} />
        <Route path="payments" element={<AdminPayments />} />
        <Route path="health" element={<SystemHealth />} />
      </Route>
    </Routes>
  );
}

export default function App() {
  return (
    <BrowserRouter>
      <AppRoutes />
    </BrowserRouter>
  );
}