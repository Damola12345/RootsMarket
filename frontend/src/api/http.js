import axios from "axios";

/**
 * Shared HTTP client for all frontend API calls.
 */
export const http = axios.create({
  timeout: 8000,
  headers: {
    "Content-Type": "application/json",
  },
});

export const API_URLS = {
  users: import.meta.env.VITE_USER_SERVICE_URL || "http://localhost:3001",
  products: import.meta.env.VITE_PRODUCT_SERVICE_URL || "http://localhost:3002",
  orders: import.meta.env.VITE_ORDER_SERVICE_URL || "http://localhost:3003",
  payments: import.meta.env.VITE_PAYMENT_SERVICE_URL || "http://localhost:3004",
  notifications:
    import.meta.env.VITE_NOTIFICATION_SERVICE_URL || "http://localhost:3005",
};