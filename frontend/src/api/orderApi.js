import { http, API_URLS } from "./http";

export async function getOrders() {
  const { data } = await http.get(`${API_URLS.orders}/orders`);
  return data;
}

export async function createOrder(payload) {
  const { data } = await http.post(`${API_URLS.orders}/orders`, payload);
  return data;
}