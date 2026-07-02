import { useCallback, useEffect, useState } from "react";
import { getPayments } from "../api/paymentApi";

export function usePayments() {
  const [payments, setPayments] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadPayments = useCallback(async () => {
    try {
      setLoading(true);
      setError("");

      const data = await getPayments();
      setPayments(data);
    } catch (err) {
      setError(
        err?.response?.data?.error ||
          err.message ||
          "Unable to load payments"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadPayments();
  }, [loadPayments]);

  return {
    payments,
    loading,
    error,
    retry: loadPayments,
  };
}