import axios from "axios";

/**
 * RootsMarket API Client
 *
 * Central place for all frontend → backend communication.
 * Uses Vite environment variables so URLs can change between:
 * local development, Docker, Kubernetes, staging, and production.
 */

const api = axios.create({
  timeout: 5000,
});

const SERVICES = {
  users: import.meta.env.VITE_USER_SERVICE_URL,
  products: import.meta.env.VITE_PRODUCT_SERVICE_URL,
  orders: import.meta.env.VITE_ORDER_SERVICE_URL,
  payments: import.meta.env.VITE_PAYMENT_SERVICE_URL,
  notifications: import.meta.env.VITE_NOTIFICATION_SERVICE_URL,
};

// Users
export const getUsers = async () => {
  const { data } = await api.get(`${SERVICES.users}/users`);
  return data;
};

export const createUser = async (payload) => {
  const { data } = await api.post(`${SERVICES.users}/users`, payload);
  return data;
};

// Products
export const getProducts = async () => {
  const { data } = await api.get(`${SERVICES.products}/products`);
  return data;
};

// Orders
export const getOrders = async () => {
  const { data } = await api.get(`${SERVICES.orders}/orders`);
  return data;
};

export const createOrder = async (payload) => {
  const { data } = await api.post(`${SERVICES.orders}/orders`, payload);
  return data;
};

// Payments
export const getPayments = async () => {
  const { data } = await api.get(`${SERVICES.payments}/payments`);
  return data;
};

// Health
export const getHealth = async () => {
  const serviceEntries = Object.entries(SERVICES);

  const results = await Promise.allSettled(
    serviceEntries.map(async ([name, url]) => {
      const { data } = await api.get(`${url}/health`);

      return {
        name,
        ...data,
      };
    })
  );

  return results.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }

    return {
      name: serviceEntries[index][0],
      status: "unhealthy",
    };
  });
};