import { useCallback, useEffect, useState } from "react";
import { getProducts } from "../api/productApi";
import { getProductImage } from "../utils/productImages";

/**
 * Loads products from product-service.
 * Handles loading, error, retry, and image enrichment.
 */
export function useProducts() {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  const loadProducts = useCallback(async () => {
    try {
      setLoading(true);
      setError("");

      const data = await getProducts();

      const enrichedProducts = data.map((product) => ({
        ...product,
        image: getProductImage(product.name),
        description:
          product.description ||
          `${product.name} sourced from trusted local producers.`,
      }));

      setProducts(enrichedProducts);
    } catch (err) {
      setError(
        err?.response?.data?.error ||
          err.message ||
          "Unable to load products"
      );
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadProducts();
  }, [loadProducts]);

  return {
    products,
    loading,
    error,
    retry: loadProducts,
  };
}