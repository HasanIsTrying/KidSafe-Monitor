import { useEffect, useRef, useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { useAlerts } from "@/hooks/use-alerts";
import { useAuth, AUTH_QUERY_KEY } from "@/hooks/use-auth";
import { StatusBanner } from "@/components/StatusBanner";
import { AlertHistory } from "@/components/AlertHistory";
import {
  logout, getPendingAlert, acknowledgeAlert, getAccount, updateLocation,
  triggerDemoAlert, type PendingAlert, type Account, type EscalationSms,
} from "@/lib/auth";
import { queryClient } from "@/lib/queryClient";
import {
  Shield, RefreshCw, LogOut, Settings as SettingsIcon, BellRing, Camera,
  MessageSquare, PlayCircle, UserCheck, MapPin,
} from "lucide-react";

const ACCOUNT_KEY = ["/account"];
const PENDING_KEY = ["/alerts/pending"];

function formatDelay(seconds?: number): string {
  if (!seconds) return "2 minutes";
  if (seconds < 60) return `${seconds} seconds`;
  const minutes = Math.round(seconds / 60);
  return minutes === 1 ? "1 minute" : `${minutes} minutes`;
}

/** Renders the escalation SMS as a phone message bubble. On the demo account
 *  nothing was actually sent, so this is the only place the text is visible. */
function SmsPreview({ sms }: { sms: EscalationSms }) {
  return (
    <section className="rounded-2xl border border-border bg-card p-5">
      <div className="flex items-center gap-2 mb-1">
        <MessageSquare className="w-5 h-5 text-muted-foreground" />
        <h3 className="font-bold text-foreground">
          {sms.demo ? "Demo — the text message that would be sent" : "Message sent to your emergency contacts"}
        </h3>
      </div>
      <p className="text-sm text-muted-foreground mb-4">
        {sms.demo
          ? "Nothing was actually sent. On a configured system this SMS goes to every emergency contact."
          : sms.sent
            ? "Delivered via SMS."
            : "The SMS gateway did not confirm delivery."}
      </p>

      <div className="text-xs text-muted-foreground mb-2">
        To: {sms.to.length ? sms.to.join(", ") : "no contacts configured"}
      </div>

      {/* The message bubble */}
      <div className="max-w-md rounded-2xl rounded-bl-sm bg-emerald-500 text-white px-4 py-3 text-sm leading-relaxed whitespace-pre-wrap break-words">
        {sms.message}
      </div>

      {sms.demo && (
        <p className="mt-3 text-xs text-muted-foreground">
          The map link points at the vehicle's saved location. If none was set,
          the dashboard captures the current position automatically.
        </p>
      )}
    </section>
  );
}

export default function Dashboard() {
  const { data: alerts, isLoading, error, refetch } = useAlerts();
  const { user } = useAuth();
  const [, setLocation] = useLocation();

  const [demoBusy, setDemoBusy] = useState(false);

  // Poll for an alert awaiting the parent's response.
  const { data: pending } = useQuery<PendingAlert>({
    queryKey: PENDING_KEY,
    queryFn: getPendingAlert,
    refetchInterval: 3000,
  });

  const { data: account } = useQuery<Account>({
    queryKey: ACCOUNT_KEY,
    queryFn: getAccount,
    retry: false,
  });

  // The escalation SMS carries a map link to the vehicle, so an account with no
  // location saved sends a far less useful alert. If none is configured yet,
  // capture the browser's position once, silently — Settings still has a manual
  // button for changing it later, or if permission is refused here.
  const locationRequested = useRef(false);
  useEffect(() => {
    if (!account || account.location || locationRequested.current) return;
    // Never for the demo account: it's shared, so one visitor's real position
    // would be shown to the next. It ships with a fixed landmark instead, and
    // the server refuses location writes for it regardless.
    if (account.demo) return;
    if (!navigator.geolocation) return;
    locationRequested.current = true;
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          await updateLocation(pos.coords.latitude, pos.coords.longitude);
          queryClient.invalidateQueries({ queryKey: ACCOUNT_KEY });
        } catch {
          /* best effort — never block the dashboard on this */
        }
      },
      () => {
        /* permission denied or unavailable; Settings has the manual control */
      },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, [account]);

  // ...and again the moment an alert opens. The escalation SMS is only as good
  // as the map link in it, so this is the point where a missing location
  // actually costs something. Runs once per alert, and only when none is saved
  // — a location the parent set at the vehicle is deliberate and more accurate
  // than wherever the phone happens to be now, so it is never overwritten.
  const locatedForAlert = useRef<number | null>(null);
  useEffect(() => {
    if (!pending?.pending || !account || account.demo || account.location) return;
    if (!navigator.geolocation) return;
    const alertId = pending.id ?? 0;
    if (locatedForAlert.current === alertId) return;
    locatedForAlert.current = alertId;
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          await updateLocation(pos.coords.latitude, pos.coords.longitude);
          queryClient.invalidateQueries({ queryKey: ACCOUNT_KEY });
        } catch {
          /* best effort — the alert itself must never be blocked on this */
        }
      },
      () => {},
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }, [pending?.pending, pending?.id, account]);

  async function simulate(status: "CHILD_ONLY" | "SAFE") {
    setDemoBusy(true);
    try {
      await triggerDemoAlert(status);
      queryClient.invalidateQueries({ queryKey: PENDING_KEY });
      refetch();
    } catch {
      /* surfaced by the alert list's own error state */
    } finally {
      setDemoBusy(false);
    }
  }

  // Subscribe this device to push and tag it with the parent's phone, so the
  // server can target alerts to the right account.
  useEffect(() => {
    if (!user) return;
    const w = window as any;
    w.OneSignalDeferred = w.OneSignalDeferred || [];
    w.OneSignalDeferred.push(async (OneSignal: any) => {
      try {
        await OneSignal.login(user.phone);
        await OneSignal.Notifications.requestPermission();
      } catch {
        /* push opt-in is best-effort */
      }
    });
  }, [user]);

  const handleLogout = async () => {
    const w = window as any;
    w.OneSignalDeferred = w.OneSignalDeferred || [];
    w.OneSignalDeferred.push(async (OneSignal: any) => {
      try { await OneSignal.logout(); } catch { /* ignore */ }
    });
    await logout();
    queryClient.setQueryData(AUTH_QUERY_KEY, null);
    setLocation("/login");
  };

  const handleAck = async () => {
    await acknowledgeAlert();
    queryClient.invalidateQueries({ queryKey: PENDING_KEY });
  };

  // Determine current status based on the MOST RECENT alert
  // If no alerts, default to UNKNOWN or SAFE depending on preference
  const latestAlert = alerts && alerts.length > 0 
    ? alerts.sort((a, b) => Number(b.timestamp) - Number(a.timestamp))[0]
    : null;

  const currentStatus = latestAlert?.status as "CHILD_ONLY" | "SAFE" | undefined ?? "UNKNOWN";
  
  // Use latest alert time or null
  const lastUpdated = latestAlert ? Number(latestAlert.timestamp) : undefined;

  if (error) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-background p-4">
        <div className="max-w-md w-full text-center space-y-4">
          <div className="w-16 h-16 bg-red-100 text-red-500 rounded-full flex items-center justify-center mx-auto">
            <Shield className="w-8 h-8" />
          </div>
          <h1 className="text-2xl font-bold text-foreground">Connection Lost</h1>
          <p className="text-muted-foreground">Unable to connect to the safety monitoring server.</p>
          <button 
            onClick={() => refetch()}
            className="px-6 py-2 bg-primary text-primary-foreground rounded-lg font-medium hover:bg-primary/90 transition-colors"
          >
            Retry Connection
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background text-foreground font-sans">
      {/* Header */}
      <header className="border-b border-border bg-card/50 backdrop-blur-md sticky top-0 z-50">
        <div className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="bg-primary/10 p-2 rounded-lg">
              <Shield className="w-6 h-6 text-primary" />
            </div>
            <span className="font-display font-bold text-xl tracking-tight">KidSafe<span className="text-primary">Alert</span></span>
          </div>
          
          <div className="flex items-center gap-3">
            <div className="flex items-center gap-3 text-sm text-muted-foreground bg-muted/50 px-3 py-1.5 rounded-full border border-border/50">
              <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse" />
              <span className="hidden sm:inline">System Active • Monitoring</span>
              <span className="sm:hidden">Active</span>
            </div>

            {user && (
              <span className="hidden md:inline text-sm font-medium text-foreground">
                {user.name}
              </span>
            )}

            <button
              onClick={() => setLocation("/camera")}
              title="Monitoring camera"
              className="flex items-center gap-1.5 text-sm font-medium text-white bg-blue-500 hover:bg-blue-600 px-3 py-1.5 rounded-full transition-colors"
            >
              <Camera className="w-4 h-4" />
              <span className="hidden sm:inline">Camera</span>
            </button>

            <button
              onClick={() => setLocation("/settings")}
              title="Settings"
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted px-3 py-1.5 rounded-full border border-border/50 transition-colors"
            >
              <SettingsIcon className="w-4 h-4" />
              <span className="hidden sm:inline">Settings</span>
            </button>

            <button
              onClick={handleLogout}
              title="Log out"
              className="flex items-center gap-1.5 text-sm text-muted-foreground hover:text-foreground bg-muted/50 hover:bg-muted px-3 py-1.5 rounded-full border border-border/50 transition-colors"
            >
              <LogOut className="w-4 h-4" />
              <span className="hidden sm:inline">Log out</span>
            </button>
          </div>
        </div>
      </header>

      {/* Main Content */}
      <main className="max-w-5xl mx-auto px-4 sm:px-6 lg:px-8 py-8 md:py-12 space-y-8">
        
        {/* Connection Loader (Only on initial load) */}
        {isLoading && !alerts ? (
          <div className="flex flex-col items-center justify-center py-20 animate-pulse">
            <RefreshCw className="w-10 h-10 text-muted-foreground animate-spin mb-4" />
            <p className="text-muted-foreground font-medium">Connecting to monitoring system...</p>
          </div>
        ) : (
          <>
            {/* Demo account — stands in for the camera, which a public
                checkout doesn't have. */}
            {user?.demo && (
              <section className="rounded-2xl bg-slate-800 text-white p-5 space-y-4">
                <div className="flex items-start gap-3">
                  <PlayCircle className="w-6 h-6 text-slate-300 shrink-0 mt-0.5" />
                  <div>
                    <p className="font-bold">Demo mode</p>
                    <p className="text-sm text-slate-300">
                      You're signed into a shared demo account. There's no camera
                      here, so use these buttons to simulate what it would detect.
                      No SMS is ever sent to anyone.
                    </p>
                  </div>
                </div>
                <div className="flex flex-col sm:flex-row gap-3">
                  <button
                    onClick={() => simulate("CHILD_ONLY")}
                    disabled={demoBusy}
                    className="flex-1 flex items-center justify-center gap-2 bg-red-500 hover:bg-red-600 disabled:opacity-60 font-semibold py-3 rounded-xl transition-colors"
                  >
                    <BellRing className="w-4 h-4" /> Simulate: child left alone
                  </button>
                  <button
                    onClick={() => simulate("SAFE")}
                    disabled={demoBusy}
                    className="flex-1 flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 font-semibold py-3 rounded-xl transition-colors"
                  >
                    <UserCheck className="w-4 h-4" /> Simulate: adult returns
                  </button>
                </div>
                <p className="flex items-center gap-1.5 text-xs text-slate-400">
                  <MapPin className="w-3.5 h-3.5" />
                  The demo uses a fixed sample location. A real account captures
                  the vehicle's own position automatically instead.
                </p>
              </section>
            )}

            {/* Acknowledged — escalation stopped, but the child is still
                detected alone, so the alert itself stays open. */}
            {pending?.pending && pending.acknowledged && (
              <section className="rounded-2xl bg-sky-50 border border-sky-300 p-5 flex items-center gap-3">
                <UserCheck className="w-7 h-7 text-sky-500 shrink-0" />
                <div>
                  <p className="font-bold text-sky-800">You acknowledged this alert</p>
                  <p className="text-sm text-sky-700">
                    Your emergency contacts will not be notified. The warning
                    stays up until a supervising adult is detected
                    {user?.demo ? ' — press "Simulate: adult returns" to clear it.' : "."}
                  </p>
                </div>
              </section>
            )}

            {/* Pending alert — needs the parent's acknowledgement */}
            {pending?.pending && !pending.acknowledged && (
              <section
                className="rounded-2xl bg-amber-50 border border-amber-300 p-5 flex flex-col sm:flex-row sm:items-center justify-between gap-4"
              >
                <div className="flex items-center gap-3">
                  <BellRing className="w-7 h-7 text-amber-500 animate-bounce shrink-0" />
                  <div>
                    <p className="font-bold text-amber-800">Alert awaiting your response</p>
                    <p className="text-sm text-amber-700">
                      {pending.escalated
                        ? pending.escalation_sms?.demo
                          ? "Your emergency contacts would have been texted now — see the message below."
                          : "A message has been sent to your emergency contacts."
                        : `If you don't acknowledge within ${formatDelay(pending.escalates_after)}, your emergency contacts will be alerted. (${pending.age ?? 0}s)`}
                    </p>
                  </div>
                </div>
                <button
                  onClick={handleAck}
                  className="shrink-0 bg-amber-500 hover:bg-amber-600 text-white font-semibold px-6 py-2.5 rounded-xl transition-colors"
                >
                  I'm nearby / Acknowledge
                </button>
              </section>
            )}

            {/* What the emergency contacts get — a real send, or a preview of
                one on the demo account. */}
            {pending?.escalation_sms && (
              <SmsPreview sms={pending.escalation_sms} />
            )}

            {/* Status Banner */}
            <section>
              <StatusBanner
                status={currentStatus}
                lastUpdated={lastUpdated}
                acknowledged={!!pending?.acknowledged}
              />
            </section>

            {/* Alert History */}
            <section>
              <div className="flex items-end justify-between mb-4 px-1">
                <h2 className="text-2xl font-bold text-foreground">Detection Log</h2>
                <span className="text-sm text-muted-foreground">
                  Updates every 2s
                </span>
              </div>
              <AlertHistory alerts={alerts || []} />
            </section>
          </>
        )}

      </main>
      
      {/* Simple Footer */}
      <footer className="max-w-5xl mx-auto px-4 py-8 text-center text-xs text-muted-foreground">
        <p>KidSafe Alert System v1.0 • Connected to Python Computer Vision Backend</p>
      </footer>
    </div>
  );
}
