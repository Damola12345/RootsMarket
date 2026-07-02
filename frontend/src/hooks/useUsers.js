import { useCallback, useEffect, useState } from "react";
import { getUsers } from "../api/userApi";

export function useUsers() {
  const [users, setUsers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadUsers = useCallback(async () => {
    try {
      setLoading(true);
      setError("");

      const data = await getUsers();
      setUsers(data);
    } catch (err) {
      setError(
        err?.response?.data?.error || err.message || "Unable to load users"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadUsers();
  }, [loadUsers]);

  return {
    users,
    loading,
    error,
    retry: loadUsers,
  };
}