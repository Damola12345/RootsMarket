import { http, API_URLS } from "./http";

export async function getUsers() {
  const { data } = await http.get(`${API_URLS.users}/users`);
  return data;
}

export async function createUser(payload) {
  const { data } = await http.post(`${API_URLS.users}/users`, payload);
  return data;
}