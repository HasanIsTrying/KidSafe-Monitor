import { useEffect, useRef, useState } from "react";
import { Loader2, VideoOff, ScanFace } from "lucide-react";
import { classifyFaceAge, triggerDemoAlert } from "@/lib/auth";

/**
 * Shows what the detector sees, for the demo account.
 *
 * The real detector runs on the machine the camera is wired to and opens a
 * native window there — no use to someone trying the demo over the web. So this
 * previews the *visitor's own* webcam in the browser and draws the same overlay
 * the real one draws: a box per face.
 *
 * Face detection is genuinely running here (MediaPipe, the same library the
 * Python detector uses, in its WebAssembly build). Age classification is not:
 * that model runs on the host. Boxes are therefore labelled honestly rather
 * than showing a made-up age band.
 */

// Loaded at runtime rather than bundled: several MB of WASM that only the demo
// needs, and the app must still work when it can't be fetched.
const MP_VERSION = "0.10.18";
const MP_MODULE = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const MP_WASM = `${MP_MODULE}/wasm`;
const MP_MODEL =
  "https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite";

type Box = { x: number; y: number; w: number; h: number };
type FrameStatus = "Child" | "Adult" | "None";

// Decision parameters, matching run_age_detection.py exactly.
const WINDOW_SECONDS = 10;
const CHILD_RATIO_THRESHOLD = 0.7;
const MIN_SAMPLES = 5;
const REPEAT_ALERT_SECONDS = 10;

/**
 * The same rule the Python detector applies to one frame:
 * a young child with no qualifying supervisor is what raises an alert. A teen
 * alone is always fine; a teen only *supervises* when teens_mature is on.
 */
function classifyFrame(labels: string[], teensMature: boolean): FrameStatus {
  const child = labels.some((l) => l.startsWith("Child"));
  const teen = labels.some((l) => l.startsWith("Teenager"));
  const adult = labels.some((l) => /^(Adult|Middle Age|Aged)/.test(l));
  const supervisor = adult || (teen && teensMature);

  if (child && !supervisor) return "Child";
  if (supervisor || teen) return "Adult";
  return "None";
}

export function DemoCameraPreview({
  onClose,
  teensMature = false,
  onAlert,
}: {
  onClose: () => void;
  teensMature?: boolean;
  /** Called when the windowed decision changes, so the page can react. */
  onAlert?: (status: "CHILD_ONLY" | "SAFE") => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [status, setStatus] = useState<"starting" | "live" | "error">("starting");
  const [error, setError] = useState("");
  const [faceCount, setFaceCount] = useState(0);
  // Face detection is a bonus: the feed is useful on its own if it won't load.
  const [detectionOn, setDetectionOn] = useState(false);
  // Age labels come from the server's copy of the real model; null while we
  // haven't heard back, false once we know it isn't available.
  const [ageAvailable, setAgeAvailable] = useState<boolean | null>(null);
  // The first classification loads the age model on the server, which takes
  // up to a minute. Every one after it is near-instant.
  const [modelWarming, setModelWarming] = useState(false);
  // A ref, not the state above: the classification loop's closure would
  // otherwise keep reading the value captured when the effect first ran.
  const gotAgeRef = useRef(false);
  // Latest boxes, shared between the draw loop and the classification timer.
  const boxesRef = useRef<Box[]>([]);
  const labelsRef = useRef<string[]>([]);
  // Rolling decision window, mirroring the Python detector's.
  const windowRef = useRef<{ status: FrameStatus; t: number }[]>([]);
  const lastPostedRef = useRef<{ status: string | null; at: number }>({ status: null, at: 0 });
  const [decision, setDecision] = useState<"CHILD_ONLY" | "SAFE" | "UNKNOWN">("UNKNOWN");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let detector: any = null;
    let frame = 0;
    let stopped = false;

    async function start() {
      try {
        stream = await navigator.mediaDevices.getUserMedia({
          video: { facingMode: "user" },
          audio: false,
        });
      } catch (e) {
        setStatus("error");
        setError(
          e instanceof DOMException && e.name === "NotAllowedError"
            ? "Camera permission was denied. Allow it in your browser and try again."
            : "No camera available in this browser.",
        );
        return;
      }
      if (stopped) {
        stream.getTracks().forEach((t) => t.stop());
        return;
      }

      const video = videoRef.current;
      if (!video) return;
      video.srcObject = stream;
      await video.play().catch(() => {});
      setStatus("live");

      // Best-effort: the preview still works without it.
      try {
        const vision = await import(/* @vite-ignore */ MP_MODULE);
        const fileset = await vision.FilesetResolver.forVisionTasks(MP_WASM);
        detector = await vision.FaceDetector.createFromOptions(fileset, {
          baseOptions: { modelAssetPath: MP_MODEL },
          runningMode: "VIDEO",
        });
        if (!stopped) setDetectionOn(true);
      } catch {
        detector = null; // feed-only
      }

      const draw = () => {
        if (stopped) return;
        frame = requestAnimationFrame(draw);

        const canvas = canvasRef.current;
        if (!canvas || !video.videoWidth) return;
        if (canvas.width !== video.videoWidth) {
          canvas.width = video.videoWidth;
          canvas.height = video.videoHeight;
        }
        const ctx = canvas.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, canvas.width, canvas.height);

        let boxes: Box[] = [];
        if (detector) {
          try {
            const result = detector.detectForVideo(video, performance.now());
            boxes = (result?.detections ?? []).map((d: any) => ({
              x: d.boundingBox.originX,
              y: d.boundingBox.originY,
              w: d.boundingBox.width,
              h: d.boundingBox.height,
            }));
          } catch {
            /* a dropped frame is not worth reporting */
          }
        }
        setFaceCount(boxes.length);
        boxesRef.current = boxes;

        // The video is mirrored for a natural selfie view. Mirror the box
        // COORDINATES to match, rather than the canvas itself — flipping the
        // canvas would flip the label text along with it.
        ctx.lineWidth = Math.max(2, canvas.width / 250);
        ctx.strokeStyle = "#22c55e";
        ctx.font = `${Math.max(14, canvas.width / 36)}px system-ui, sans-serif`;
        ctx.textBaseline = "bottom";

        boxes.forEach((b, i) => {
          const x = canvas.width - (b.x + b.w); // mirrored
          ctx.strokeRect(x, b.y, b.w, b.h);

          const label = labelsRef.current[i] || "Face detected";
          const padding = 6;
          const textWidth = ctx.measureText(label).width;
          const lineHeight = Math.max(14, canvas.width / 36) + padding;
          const labelY = b.y > lineHeight ? b.y - padding : b.y + b.h + lineHeight;

          // A filled plate behind the text keeps it readable over any scene.
          ctx.fillStyle = "rgba(34, 197, 94, 0.85)";
          ctx.fillRect(x, labelY - lineHeight, textWidth + padding * 2, lineHeight);
          ctx.fillStyle = "#ffffff";
          ctx.fillText(label, x + padding, labelY - padding / 2);
        });
      };
      draw();
    }

    start();
    return () => {
      stopped = true;
      cancelAnimationFrame(frame);
      detector?.close?.();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, []);

  // Age classification runs on the server (the browser has no age model), so
  // it's throttled to a couple of times a second rather than per frame.
  useEffect(() => {
    if (!detectionOn || status !== "live") return;
    let cancelled = false;
    // setInterval doesn't wait for an async callback, so a slow round trip
    // would stack overlapping cycles — badly on the very first call, which
    // loads the model server-side and can take a minute. One at a time.
    let busy = false;
    const crop = document.createElement("canvas");

    const timer = setInterval(async () => {
      const video = videoRef.current;
      const boxes = boxesRef.current;
      if (cancelled || busy || !video || !video.videoWidth || boxes.length === 0) return;
      busy = true;
      try {
        await runCycle(video, boxes);
      } finally {
        busy = false;
      }
    }, 700);

    async function runCycle(video: HTMLVideoElement, boxes: Box[]) {

      const labels: string[] = [];
      for (const b of boxes.slice(0, 4)) { // cap the work per cycle
        // Pad the crop: the age model wants a bit more than the tight box.
        const pad = b.w * 0.2;
        const sx = Math.max(0, b.x - pad);
        const sy = Math.max(0, b.y - pad);
        const sw = Math.min(video.videoWidth - sx, b.w + pad * 2);
        const sh = Math.min(video.videoHeight - sy, b.h + pad * 2);
        if (sw < 24 || sh < 24) continue;

        crop.width = 224;
        crop.height = 224;
        const cctx = crop.getContext("2d");
        if (!cctx) continue;
        cctx.drawImage(video, sx, sy, sw, sh, 0, 0, 224, 224);

        if (!gotAgeRef.current) setModelWarming(true);
        const label = await classifyFaceAge(crop.toDataURL("image/jpeg", 0.8));
        if (cancelled) return;
        if (label === null) {
          setAgeAvailable(false);
          setModelWarming(false);
          return; // no model on the server; stop asking
        }
        gotAgeRef.current = true;
        setModelWarming(false);
        setAgeAvailable(true);
        labels.push(label);
      }
      if (cancelled) return;
      labelsRef.current = labels;

      // ---- the same windowed decision the Python detector makes ----
      const now = Date.now();
      windowRef.current.push({ status: classifyFrame(labels, teensMature), t: now });
      windowRef.current = windowRef.current.filter(
        (s) => now - s.t <= WINDOW_SECONDS * 1000,
      );

      const samples = windowRef.current;
      if (samples.length <= MIN_SAMPLES) return;

      const childRatio =
        samples.filter((s) => s.status === "Child").length / samples.length;
      const anyAdult = samples.some((s) => s.status === "Adult");

      let next: "CHILD_ONLY" | "SAFE" | "UNKNOWN" = "UNKNOWN";
      if (childRatio >= CHILD_RATIO_THRESHOLD && !anyAdult) next = "CHILD_ONLY";
      else if (anyAdult) next = "SAFE";
      setDecision(next);
      if (next === "UNKNOWN") return;

      // Posted the way the detector posts: CHILD_ONLY repeats while it lasts,
      // SAFE only on transition. Same endpoint the Simulate buttons use, so it
      // drives the real banner, push and escalation.
      const last = lastPostedRef.current;
      const shouldPost =
        next === "CHILD_ONLY"
          ? last.status !== "CHILD_ONLY" || now - last.at >= REPEAT_ALERT_SECONDS * 1000
          : last.status !== "SAFE";
      if (!shouldPost) return;

      lastPostedRef.current = { status: next, at: now };
      try {
        await triggerDemoAlert(next);
        onAlert?.(next);
      } catch {
        /* the dashboard's own polling will catch up */
      }
    }

    return () => {
      cancelled = true;
      clearInterval(timer);
    };
  }, [detectionOn, status, teensMature, onAlert]);

  return (
    <section className="bg-white rounded-3xl shadow-sm p-6 space-y-4">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <ScanFace className="w-5 h-5 text-blue-400" />
          <h2 className="font-bold text-lg text-slate-800">What the detector sees</h2>
        </div>
        <button onClick={onClose} className="text-sm text-blue-500 hover:text-blue-600">
          Close preview
        </button>
      </div>

      <div className="relative rounded-2xl overflow-hidden bg-slate-900 aspect-video">
        {/* Mirrored, like the real detector's selfie view. */}
        <video
          ref={videoRef}
          playsInline
          muted
          className="w-full h-full object-cover scale-x-[-1]"
        />
        {/* NOT mirrored: the box coordinates are mirrored when drawn instead,
            so the labels stay readable. */}
        <canvas
          ref={canvasRef}
          className="absolute inset-0 w-full h-full object-cover pointer-events-none"
        />

        {status === "starting" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-300 gap-2">
            <Loader2 className="w-8 h-8 animate-spin" />
            <p className="text-sm">Waiting for camera permission...</p>
          </div>
        )}
        {status === "error" && (
          <div className="absolute inset-0 flex flex-col items-center justify-center text-slate-300 gap-2 px-6 text-center">
            <VideoOff className="w-8 h-8" />
            <p className="text-sm">{error}</p>
          </div>
        )}

        {status === "live" && (
          <div className="absolute top-3 left-3 flex items-center gap-2 bg-black/60 text-white text-xs px-3 py-1.5 rounded-full">
            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
            {detectionOn ? `${faceCount} face${faceCount === 1 ? "" : "s"} detected` : "Live"}
          </div>
        )}

        {/* First run only: the server is loading the age model. */}
        {status === "live" && modelWarming && (
          <div className="absolute bottom-3 left-3 right-3 flex items-center gap-2 bg-black/70 text-white text-xs px-3 py-2 rounded-xl">
            <Loader2 className="w-4 h-4 animate-spin shrink-0" />
            <span>
              Loading the age model — about a minute, first run only. Faces are
              already being boxed; the age labels appear once it's ready.
            </span>
          </div>
        )}

        {/* The live verdict over the 10-second window. */}
        {status === "live" && ageAvailable && decision !== "UNKNOWN" && (
          <div
            className={`absolute top-3 right-3 text-xs font-bold px-3 py-1.5 rounded-full ${
              decision === "CHILD_ONLY" ? "bg-red-500 text-white" : "bg-emerald-500 text-white"
            }`}
          >
            {decision === "CHILD_ONLY" ? "CHILD ALONE" : "SAFE"}
          </div>
        )}
      </div>

      <div className="text-sm text-slate-500 space-y-2">
        <p>
          This is <b>your</b> camera, running entirely in this browser — no video
          is uploaded or recorded. In a real installation the camera is wired to
          the vehicle and the detector runs on that machine.
        </p>
        {!detectionOn && (
          <p>
            The face-detection model couldn't be loaded (it's fetched on demand
            and needs a network connection), so the feed is shown without boxes.
            The real detector draws a green box and an age band over every face.
          </p>
        )}
        {detectionOn && ageAvailable === null && (
          <p>
            <b>The first age reading takes about a minute.</b> Face boxes appear
            straight away, but the first label waits for the server to load the
            age model (longer still if it has to download it first). Every
            reading after that is instant — it only happens once per server start.
          </p>
        )}
        {detectionOn && ageAvailable === true && (
          <p>
            The whole pipeline is really running: faces found in your browser
            with MediaPipe, each classified into an age band by the very same
            model the detector uses, then the same 10-second / 70% decision. A{" "}
            <i>Child 0-12</i> with no <i>Adult 21+</i> raises a genuine alert —
            the dashboard banner, the push notification and the 20-second
            escalation all follow, exactly as they would from a real camera.
          </p>
        )}
        {detectionOn && ageAvailable === false && (
          <p>
            Faces are really being detected (MediaPipe). Age classification is
            unavailable here — it needs the detector's ML packages on the
            server (<code>python script/setup.py --venv</code>). The real system
            labels each face <i>Child 0-12</i>, <i>Teenager 13-20</i> or{" "}
            <i>Adult 21+</i>, and alerts when a child has no supervisor.
          </p>
        )}
      </div>
    </section>
  );
}
