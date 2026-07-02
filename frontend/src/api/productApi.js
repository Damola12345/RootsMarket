import { http, API_URLS } from "./http";

/**
 * Fetch products from product-service.
 */
export async function getProducts() {
  const { data } = await http.get(`${API_URLS.products}/products`);
  return data;
}