import { useCallback, useEffect, useState } from "react";
import { getSystemHealth } from "../api/healthApi";

export function useHealth() {
  const [services, setServices] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadHealth = useCallback(async () => {
    try {
      setLoading(true);
      setError("");

      const data = await getSystemHealth();
      setServices(data);
    } catch (err) {
      setError(
        err?.response?.data?.error ||
          err.message ||
          "Unable to load system health"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadHealth();
  }, [loadHealth]);

  return {
    services,
    loading,
    error,
    retry: loadHealth,
  };
}