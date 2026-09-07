import { useQuery } from "@tanstack/react-query";
import { fetchMe, type AuthUser } from "@/lib/auth";

export const AUTH_QUERY_KEY = ["/auth/me"];

export function useAuth() {
  const query = useQuery<AuthUser | null>({
    queryKey: AUTH_QUERY_KEY,
    queryFn: fetchMe,
    retry: false,
    staleTime: Infinity,
  });

  return {
    user: query.data ?? null,
    isLoading: query.isLoading,
    isAuthenticated: !!query.data,
  };
}
