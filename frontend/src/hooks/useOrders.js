import { useCallback, useEffect, useState } from "react";
import { getOrders } from "../api/orderApi";

export function useOrders() {
  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadOrders = useCallback(async () => {
    try {
      setLoading(true);
      setError("");

      const data = await getOrders();
      setOrders(data);
    } catch (err) {
      setError(
        err?.response?.data?.error || err.message || "Unable to load orders"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadOrders();
  }, [loadOrders]);

  return {
    orders,
    loading,
    error,
    retry: loadOrders,
  };
}