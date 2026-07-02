import { http, API_URLS } from "./http";

const services = [
  ["User Service", API_URLS.users],
  ["Product Service", API_URLS.products],
  ["Order Service", API_URLS.orders],
  ["Payment Service", API_URLS.payments],
  ["Notification Service", API_URLS.notifications],
];

export async function getSystemHealth() {
  const results = await Promise.allSettled(
    services.map(async ([name, url]) => {
      const { data } = await http.get(`${url}/health`);

      return {
        name,
        url: `${url}/health`,
        status: data.status,
        service: data.service,
        dependencies: data.dependencies || {},
        checkedAt: new Date().toISOString(),
      };
    })
  );

  return results.map((result, index) => {
    if (result.status === "fulfilled") {
      return result.value;
    }

    return {
      name: services[index][0],
      url: `${services[index][1]}/health`,
      status: "unhealthy",
      service: services[index][0],
      dependencies: {},
      checkedAt: new Date().toISOString(),
    };
  });
}