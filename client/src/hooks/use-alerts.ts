import { useQuery } from "@tanstack/react-query";
import { api } from "@shared/routes";
import { authFetch } from "@/lib/auth";

// Poll every 2 seconds
const POLL_INTERVAL = 2000;

export function useAlerts() {
  return useQuery({
    queryKey: [api.alerts.list.path],
    queryFn: async () => {
      // Alerts are per-account, so the request must be authenticated.
      const res = await authFetch(api.alerts.list.path);
      // Validate with Zod schema from shared routes
      return api.alerts.list.responses[200].parse(await res.json());
    },
    refetchInterval: POLL_INTERVAL,
    refetchIntervalInBackground: true,
  });
}
