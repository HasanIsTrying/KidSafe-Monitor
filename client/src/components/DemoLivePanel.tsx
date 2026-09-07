import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  AlertTriangle, ShieldCheck, Activity, BellRing, MessageSquare,
  UserCheck, Clock,
} from "lucide-react";
import { getPendingAlert, acknowledgeAlert, type PendingAlert } from "@/lib/auth";
import { useAlerts } from "@/hooks/use-alerts";
import { queryClient } from "@/lib/queryClient";

const PENDING_KEY = ["/alerts/pending"];

/**
 * A compact live view of everything the dashboard would show, sat next to the
 * camera preview so the whole chain is visible at once: what the detector
 * decided, the alert it raised, the countdown to escalation, and the SMS that
 * goes out at the end of it.
 *
 * Polls once a second (the dashboard uses three) so the countdown ticks
 * smoothly rather than jumping.
 */
export function DemoLivePanel() {
  const [acking, setAcking] = useState(false);
  const { data: alerts } = useAlerts();
  const { data: pending } = useQuery<PendingAlert>({
    queryKey: PENDING_KEY,
    queryFn: getPendingAlert,
    refetchInterval: 1000,
  });

  const latest = alerts && alerts.length > 0
    ? [...alerts].sort((a, b) => Number(b.timestamp) - Number(a.timestamp))[0]
    : null;
  const status = (latest?.status as "CHILD_ONLY" | "SAFE" | undefined) ?? "UNKNOWN";

  const isPending = !!pending?.pending;
  const acknowledged = !!pending?.acknowledged;
  const escalated = !!pending?.escalated;
  const total = pending?.escalates_after ?? 120;
  const remaining = Math.max(0, total - (pending?.age ?? 0));
  const progress = total > 0 ? Math.min(1, (pending?.age ?? 0) / total) : 0;

  async function handleAck() {
    setAcking(true);
    try {
      await acknowledgeAlert();
      queryClient.invalidateQueries({ queryKey: PENDING_KEY });
    } finally {
      setAcking(false);
    }
  }

  return (
    <div className="space-y-4">
      <p className="text-xs font-semibold uppercase tracking-wider text-slate-400">
        Live dashboard
      </p>

      {/* ---- Status ---- */}
      <div
        className={`rounded-2xl p-5 text-white ${
          status === "CHILD_ONLY"
            ? `bg-gradient-to-br from-red-600 to-red-700 ${acknowledged ? "" : "animate-pulse"}`
            : status === "SAFE"
              ? "bg-gradient-to-br from-emerald-500 to-emerald-600"
              : "bg-gradient-to-br from-slate-400 to-slate-500"
        }`}
      >
        <div className="flex items-center gap-3">
          {status === "CHILD_ONLY" ? (
            <AlertTriangle className="w-8 h-8 shrink-0" />
          ) : status === "SAFE" ? (
            <ShieldCheck className="w-8 h-8 shrink-0" />
          ) : (
            <Activity className="w-8 h-8 shrink-0" />
          )}
          <div>
            <p className="font-black text-lg uppercase tracking-wide">
              {status === "CHILD_ONLY" ? "Warning" : status === "SAFE" ? "Safe" : "Waiting"}
            </p>
            <p className="text-sm text-white/85">
              {status === "CHILD_ONLY"
                ? "Child detected alone"
                : status === "SAFE"
                  ? "A supervising adult is present"
                  : "No decision yet — hold a face to the camera"}
            </p>
          </div>
        </div>
        {acknowledged && status === "CHILD_ONLY" && (
          <p className="mt-3 flex items-center gap-1.5 bg-black/25 rounded-full px-3 py-1 text-xs w-fit">
            <ShieldCheck className="w-3.5 h-3.5" /> Acknowledged — you said you're nearby
          </p>
        )}
      </div>

      {/* ---- Countdown to escalation ---- */}
      {isPending && !acknowledged && !escalated && (
        <div className="rounded-2xl bg-amber-50 border border-amber-300 p-4">
          <div className="flex items-center gap-2 mb-2">
            <Clock className="w-5 h-5 text-amber-500 shrink-0" />
            <p className="font-bold text-amber-800 text-sm">
              Emergency contacts in {remaining}s
            </p>
          </div>
          <div className="h-2 w-full rounded-full bg-amber-200 overflow-hidden">
            <div
              className="h-full bg-amber-500 transition-[width] duration-1000 ease-linear"
              style={{ width: `${progress * 100}%` }}
            />
          </div>
          <p className="mt-2 text-xs text-amber-700">
            Acknowledge and nobody is contacted. Ignore it and the SMS below goes out.
          </p>
          <button
            onClick={handleAck}
            disabled={acking}
            className="mt-3 w-full flex items-center justify-center gap-2 bg-amber-500 hover:bg-amber-600 disabled:opacity-60 text-white font-semibold py-2.5 rounded-xl transition-colors"
          >
            <BellRing className="w-4 h-4" /> I'm nearby / Acknowledge
          </button>
        </div>
      )}

      {isPending && acknowledged && (
        <div className="rounded-2xl bg-sky-50 border border-sky-300 p-4 flex items-start gap-2">
          <UserCheck className="w-5 h-5 text-sky-500 shrink-0 mt-0.5" />
          <p className="text-sm text-sky-800">
            Escalation cancelled. The warning clears when an adult is detected.
          </p>
        </div>
      )}

      {/* ---- The SMS ---- */}
      {pending?.escalation_sms && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4">
          <div className="flex items-center gap-2 mb-1">
            <MessageSquare className="w-4 h-4 text-slate-400" />
            <p className="font-bold text-sm text-slate-800">
              {pending.escalation_sms.demo ? "SMS that would be sent" : "SMS sent"}
            </p>
          </div>
          <p className="text-xs text-slate-500 mb-2">
            To: {pending.escalation_sms.to.join(", ") || "no contacts"}
          </p>
          <div className="rounded-2xl rounded-bl-sm bg-emerald-500 text-white px-3 py-2 text-xs leading-relaxed break-words">
            {pending.escalation_sms.message}
          </div>
          {pending.escalation_sms.demo && (
            <p className="mt-2 text-xs text-slate-400">
              Nothing was actually sent — this is the demo account.
            </p>
          )}
        </div>
      )}

      {/* ---- Detection log ---- */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4">
        <p className="font-bold text-sm text-slate-800 mb-2">Detection log</p>
        {alerts && alerts.length > 0 ? (
          <ul className="space-y-1.5">
            {alerts.slice(0, 5).map((a) => (
              <li key={a.id} className="flex items-center gap-2 text-xs">
                <span
                  className={`w-2 h-2 rounded-full shrink-0 ${
                    a.status === "CHILD_ONLY" ? "bg-red-500" : "bg-emerald-500"
                  }`}
                />
                <span className="text-slate-600 flex-1 truncate">{a.message}</span>
                <span className="text-slate-400 shrink-0">
                  {new Date(Number(a.timestamp) * 1000).toLocaleTimeString()}
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <p className="text-xs text-slate-400">Nothing detected yet.</p>
        )}
      </div>
    </div>
  );
}
