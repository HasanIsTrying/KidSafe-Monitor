import { AlertTriangle, ShieldCheck, Activity } from "lucide-react";
import { motion, AnimatePresence } from "framer-motion";

type StatusType = "CHILD_ONLY" | "SAFE" | "UNKNOWN";

interface StatusBannerProps {
  status: StatusType;
  lastUpdated?: number;
  /** The parent responded. The warning stays — only the camera can clear it —
   *  but it stops screaming for attention that has already been given. */
  acknowledged?: boolean;
}

export function StatusBanner({ status, lastUpdated, acknowledged }: StatusBannerProps) {
  const isDanger = status === "CHILD_ONLY";
  const isSafe = status === "SAFE";

  return (
    <div className="w-full mb-8">
      <AnimatePresence mode="wait">
        {isDanger ? (
          <motion.div
            key="danger"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className={`
              relative overflow-hidden rounded-2xl
              bg-gradient-to-br from-red-600 to-red-700
              text-white shadow-2xl shadow-red-500/30
              border border-red-500/50 p-8 md:p-12
              ${acknowledged ? "" : "animate-pulse-red"}
            `}
          >
            <div className="absolute top-0 right-0 -mt-10 -mr-10 opacity-10">
              <AlertTriangle size={300} />
            </div>
            
            <div className="relative z-10 flex flex-col items-center justify-center text-center space-y-4">
              <div className="p-4 bg-white/10 rounded-full backdrop-blur-sm border border-white/20">
                <AlertTriangle
                  className={`w-16 h-16 md:w-20 md:h-20 text-white ${acknowledged ? "" : "animate-bounce"}`}
                />
              </div>

              <h1 className="text-4xl md:text-6xl font-display font-black uppercase tracking-widest drop-shadow-md">
                Warning
              </h1>
              <p className="text-xl md:text-3xl font-bold bg-black/20 px-6 py-2 rounded-lg backdrop-blur-sm">
                Child Detected Alone
              </p>
              {acknowledged && (
                <p className="flex items-center gap-2 text-white/90 bg-black/25 px-4 py-1.5 rounded-full text-sm md:text-base">
                  <ShieldCheck className="w-4 h-4" />
                  Acknowledged — you said you're nearby
                </p>
              )}
              <p className="text-white/80 font-mono text-sm pt-4">
                System Time: {lastUpdated ? new Date(lastUpdated * 1000).toLocaleTimeString() : "--:--:--"}
              </p>
            </div>
          </motion.div>
        ) : (
          <motion.div
            key="safe"
            initial={{ opacity: 0, y: -20 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95 }}
            className={`
              relative overflow-hidden rounded-2xl
              bg-gradient-to-br from-emerald-500 to-emerald-600
              text-white shadow-xl shadow-emerald-500/20
              border border-emerald-400/30 p-8 md:p-12
              ${isSafe ? 'animate-pulse-green' : ''}
            `}
          >
            <div className="absolute top-0 right-0 -mt-10 -mr-10 opacity-10">
              <ShieldCheck size={300} />
            </div>

            <div className="relative z-10 flex flex-col items-center justify-center text-center space-y-4">
              <div className="p-4 bg-white/10 rounded-full backdrop-blur-sm border border-white/20">
                {status === "UNKNOWN" ? (
                  <Activity className="w-16 h-16 text-white/90 animate-spin-slow" />
                ) : (
                  <ShieldCheck className="w-16 h-16 text-white" />
                )}
              </div>
              
              <h1 className="text-3xl md:text-5xl font-display font-bold uppercase tracking-wide">
                System Status
              </h1>
              <p className="text-xl md:text-2xl font-medium opacity-90">
                {status === "UNKNOWN" ? "Waiting for signal..." : "Area Secured • Safe"}
              </p>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
