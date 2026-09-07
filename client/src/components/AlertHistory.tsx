import { format, isValid } from "date-fns";
import type { Alert } from "@shared/schema";
import { AlertTriangle, CheckCircle, Clock } from "lucide-react";
import { motion } from "framer-motion";

interface AlertHistoryProps {
  alerts: Alert[];
}

// timestamp is a Unix epoch in seconds. Numbers may also arrive as numeric
// strings over JSON, so coerce defensively and return a Date (possibly invalid).
function parseTimestamp(timestamp: Alert["timestamp"]): Date {
  return new Date(Number(timestamp) * 1000);
}

export function AlertHistory({ alerts }: AlertHistoryProps) {
  // Sort by timestamp descending (newest first)
  const sortedAlerts = [...alerts].sort(
    (a, b) => parseTimestamp(b.timestamp).getTime() - parseTimestamp(a.timestamp).getTime()
  );

  if (alerts.length === 0) {
    return (
      <div className="bg-card rounded-2xl p-12 border border-dashed border-border text-center">
        <div className="mx-auto w-16 h-16 bg-muted rounded-full flex items-center justify-center mb-4">
          <Clock className="w-8 h-8 text-muted-foreground" />
        </div>
        <h3 className="text-lg font-semibold text-foreground">No Activity Recorded</h3>
        <p className="text-muted-foreground">The system hasn't detected any events yet.</p>
      </div>
    );
  }

  return (
    <div className="bg-card rounded-2xl shadow-sm border border-border/50 overflow-hidden">
      <div className="px-6 py-4 border-b border-border bg-muted/30 flex justify-between items-center">
        <h3 className="font-display font-bold text-lg text-foreground">Activity Log</h3>
        <span className="text-xs font-medium px-2 py-1 bg-primary/10 text-primary rounded-full">
          {alerts.length} Events
        </span>
      </div>
      
      <div className="divide-y divide-border">
        {sortedAlerts.map((alert, index) => (
          <motion.div
            key={alert.id ?? `${alert.timestamp}-${index}`}
            initial={{ opacity: 0, x: -20 }}
            animate={{ opacity: 1, x: 0 }}
            transition={{ delay: index * 0.05 }}
            className="p-4 md:p-6 hover:bg-muted/40 transition-colors flex items-start gap-4"
          >
            <div className={`
              mt-1 w-10 h-10 rounded-full flex items-center justify-center shrink-0
              ${alert.status === 'CHILD_ONLY' 
                ? 'bg-red-100 text-red-600 dark:bg-red-900/30 dark:text-red-400' 
                : 'bg-emerald-100 text-emerald-600 dark:bg-emerald-900/30 dark:text-emerald-400'}
            `}>
              {alert.status === 'CHILD_ONLY' ? (
                <AlertTriangle className="w-5 h-5" />
              ) : (
                <CheckCircle className="w-5 h-5" />
              )}
            </div>
            
            <div className="flex-1 min-w-0">
              <div className="flex flex-col md:flex-row md:items-center justify-between gap-1 mb-1">
                <p className="font-semibold text-foreground truncate">
                  {alert.status === 'CHILD_ONLY' ? 'Safety Alert Triggered' : 'System Check'}
                </p>
                <time className="text-xs text-muted-foreground font-mono">
                  {isValid(parseTimestamp(alert.timestamp))
                    ? format(parseTimestamp(alert.timestamp), "MMM d, yyyy • HH:mm:ss")
                    : "Unknown time"}
                </time>
              </div>
              <p className="text-sm text-muted-foreground leading-relaxed">
                {alert.message}
              </p>
            </div>
          </motion.div>
        ))}
      </div>
    </div>
  );
}
