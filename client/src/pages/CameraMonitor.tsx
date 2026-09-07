import { useState } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Shield, ArrowLeft, Camera, Loader2, Play, Square, RefreshCw } from "lucide-react";
import { listCameras, startCamera, stopCamera, getAccount, type CameraState, type Account } from "@/lib/auth";
import { queryClient } from "@/lib/queryClient";
import { useAuth } from "@/hooks/use-auth";
import { DemoCameraPreview } from "@/components/DemoCameraPreview";
import { DemoLivePanel } from "@/components/DemoLivePanel";

const CAMERAS_KEY = ["/cameras"];
const SAVED_CAMERA = "kidsafe_camera_index";

export default function CameraMonitor() {
  const [, setLocation] = useLocation();
  const [selected, setSelected] = useState<number>(() => {
    const v = localStorage.getItem(SAVED_CAMERA);
    return v ? Number(v) : 0;
  });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const { user } = useAuth();
  const isDemo = !!user?.demo;
  const [previewing, setPreviewing] = useState(false);

  // Poll so the "running" state stays in sync (e.g. if the window is closed).
  // Skipped for the demo, which never drives the host camera.
  const { data, isLoading } = useQuery<CameraState>({
    queryKey: CAMERAS_KEY,
    queryFn: listCameras,
    refetchInterval: 4000,
    enabled: !isDemo,
  });

  const running = data?.running ?? false;

  // The preview applies the teen-as-guardian rule, same as the real detector.
  const { data: account } = useQuery<Account>({
    queryKey: ["/account"],
    queryFn: getAccount,
    retry: false,
    enabled: isDemo,
  });

  async function handleStart() {
    // The demo never touches the host camera (the server rejects it too).
    // It previews the visitor's own webcam in the browser instead.
    if (isDemo) {
      setError("");
      setPreviewing(true);
      return;
    }
    setError(""); setBusy(true);
    try {
      localStorage.setItem(SAVED_CAMERA, String(selected));
      await startCamera(selected);
      queryClient.invalidateQueries({ queryKey: CAMERAS_KEY });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to start the camera");
    } finally { setBusy(false); }
  }

  async function handleStop() {
    setError(""); setBusy(true);
    try {
      await stopCamera();
      queryClient.invalidateQueries({ queryKey: CAMERAS_KEY });
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally { setBusy(false); }
  }

  // The preview puts the camera and the live dashboard side by side, which
  // needs more room than the plain camera controls do.
  const wide = isDemo && previewing ? "max-w-6xl" : "max-w-2xl";

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-blue-100 font-sans pb-16">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-md border-b border-blue-100">
        <div className={`${wide} mx-auto px-4 h-16 flex items-center justify-between`}>
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-full bg-blue-400 flex items-center justify-center">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-lg text-slate-800">Monitoring Camera</span>
          </div>
          <button onClick={() => setLocation("/")} className="flex items-center gap-1 text-sm text-blue-500 hover:text-blue-600">
            <ArrowLeft className="w-4 h-4" /> Back to dashboard
          </button>
        </div>
      </header>

      <main className={`${wide} mx-auto px-4 py-8 space-y-6 transition-[max-width]`}>
        {error && (
          <div className="rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm px-4 py-3 text-center">{error}</div>
        )}

        {/* Demo: live preview of the visitor's own camera */}
        {/* Camera on the left, the live dashboard beside it, so the whole
            chain — detection, alert, countdown, SMS — is visible at once. */}
        {isDemo && previewing && (
          <div className="grid grid-cols-1 lg:grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)] gap-6 items-start">
            <DemoCameraPreview
              onClose={() => setPreviewing(false)}
              teensMature={!!account?.teens_mature}
            />
            <DemoLivePanel />
          </div>
        )}

        {/* Status */}
        <section className="bg-white rounded-3xl shadow-sm p-6 flex items-center gap-4">
          <div className={`w-12 h-12 rounded-full flex items-center justify-center ${running || previewing ? "bg-emerald-100 text-emerald-600" : "bg-slate-100 text-slate-400"}`}>
            <Camera className="w-6 h-6" />
          </div>
          <div className="flex-1">
            <p className="font-bold text-slate-800">
              {isDemo ? (previewing ? "Preview running" : "Demo camera") : running ? "Camera active" : "Camera off"}
            </p>
            <p className="text-sm text-slate-500">
              {isDemo
                ? "The demo previews your own webcam in the browser. It can't start the real detector, which runs on the machine the vehicle camera is wired to."
                : running
                  ? "Age detection running — alerts are sent to your account."
                  : "Pick a camera and start monitoring."}
            </p>
          </div>
          {(running || previewing) && <span className="w-3 h-3 rounded-full bg-emerald-500 animate-pulse" />}
        </section>

        {/* Camera picker */}
        <section className="bg-white rounded-3xl shadow-sm p-6">
          <div className="flex items-center justify-between mb-3">
            <label className="font-semibold text-slate-700">
              {isDemo ? "Camera" : "Select camera"}
            </label>
            {!isDemo && (
              <button
                onClick={() => queryClient.invalidateQueries({ queryKey: CAMERAS_KEY })}
                className="flex items-center gap-1 text-sm text-blue-500 hover:text-blue-600"
              >
                <RefreshCw className="w-4 h-4" /> Refresh
              </button>
            )}
          </div>

          {isDemo ? (
            <p className="text-sm text-slate-500">
              Your browser will ask permission to use your webcam. Nothing is
              uploaded or recorded — the preview runs entirely on your device.
            </p>
          ) : isLoading ? (
            <div className="flex items-center gap-2 text-slate-400"><Loader2 className="w-5 h-5 animate-spin" /> Loading cameras...</div>
          ) : (
            <select
              value={selected}
              onChange={(e) => setSelected(Number(e.target.value))}
              disabled={running}
              className="w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 outline-none focus:border-blue-400 disabled:opacity-60"
            >
              {(data?.cameras ?? []).map((c) => (
                <option key={c.index} value={c.index}>{c.name} (#{c.index})</option>
              ))}
            </select>
          )}

          <div className="mt-5">
            {!running && !(isDemo && previewing) ? (
              <button
                onClick={handleStart}
                disabled={busy}
                className="w-full flex items-center justify-center gap-2 bg-emerald-500 hover:bg-emerald-600 disabled:opacity-60 text-white font-semibold py-4 rounded-2xl shadow-md transition-colors"
              >
                {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Play className="w-5 h-5" />}
                Start camera
              </button>
            ) : (
              <button
                onClick={isDemo ? () => setPreviewing(false) : handleStop}
                disabled={busy}
                className="w-full flex items-center justify-center gap-2 bg-red-500 hover:bg-red-600 disabled:opacity-60 text-white font-semibold py-4 rounded-2xl shadow-md transition-colors"
              >
                {busy ? <Loader2 className="w-5 h-5 animate-spin" /> : <Square className="w-5 h-5" />}
                Stop camera
              </button>
            )}
          </div>
        </section>

        <p className="text-center text-sm text-slate-500">
          {isDemo
            ? "In a real installation the detector opens its own window on the machine the camera is connected to, and posts alerts to this dashboard."
            : 'The camera window (with age detection) opens on the screen. Press ESC in that window, or "Stop camera" here, to exit.'}
        </p>
      </main>
    </div>
  );
}
