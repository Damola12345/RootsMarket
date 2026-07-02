import { http, API_URLS } from "./http";

export async function getPayments() {
  const { data } = await http.get(`${API_URLS.payments}/payments`);
  return data;
}