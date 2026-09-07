import { useState } from "react";
import { useLocation, Link, Redirect } from "wouter";
import { useQuery } from "@tanstack/react-query";
import { Shield, User, Phone, KeyRound, Loader2, PlayCircle } from "lucide-react";
import { requestCode, verifyCode, demoAvailable, demoLogin } from "@/lib/auth";
import { useAuth, AUTH_QUERY_KEY } from "@/hooks/use-auth";
import { queryClient } from "@/lib/queryClient";

type Mode = "register" | "login";

const copy = {
  register: {
    title: "Parent Sign Up",
    subtitle: "Create a new account",
    submit: "Sign Up",
    switchText: "Already have an account? Log in",
    switchTo: "/login",
  },
  login: {
    title: "Parent Login",
    subtitle: "Log in to your account",
    submit: "Log In",
    switchText: "Don't have an account? Sign up",
    switchTo: "/register",
  },
} as const;

export default function AuthPage({ mode }: { mode: Mode }) {
  const t = copy[mode];
  const [, setLocation] = useLocation();
  const { isAuthenticated, isLoading: authLoading } = useAuth();

  const [step, setStep] = useState<"details" | "code">("details");
  const [name, setName] = useState("");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // Already logged in - go to the dashboard.
  if (!authLoading && isAuthenticated) {
    return <Redirect to="/" />;
  }

  async function handleSendCode(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      await requestCode(name.trim(), phone.trim());
      setStep("code");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  // Offered only when the server can't do real SMS auth (a fresh clone), or
  // when DEMO_MODE is forced on.
  const { data: demoOffered } = useQuery({
    queryKey: ["/auth/demo-status"],
    queryFn: demoAvailable,
    staleTime: Infinity,
  });

  async function handleDemo() {
    setError("");
    setBusy(true);
    try {
      const user = await demoLogin();
      queryClient.setQueryData(AUTH_QUERY_KEY, user);
      setLocation("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Demo login is unavailable");
    } finally {
      setBusy(false);
    }
  }

  async function handleVerify(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const user = await verifyCode(name.trim(), phone.trim(), code.trim());
      queryClient.setQueryData(AUTH_QUERY_KEY, user);
      setLocation("/");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div
      className="min-h-screen flex flex-col items-center justify-center bg-gradient-to-b from-blue-50 to-blue-100 px-4 py-10 font-sans"
    >
      {/* Logo */}
      <div className="flex flex-col items-center mb-8">
        <div className="w-24 h-24 rounded-full bg-blue-400 flex items-center justify-center shadow-lg shadow-blue-300/50">
          <Shield className="w-12 h-12 text-white" strokeWidth={2.2} />
        </div>
        <h1 className="mt-5 text-4xl font-extrabold text-blue-500">KidSafe</h1>
        <p className="mt-2 text-slate-500">Smart protection for your children</p>
      </div>

      {/* Card */}
      <div className="w-full max-w-md bg-white rounded-3xl shadow-xl p-8">
        <h2 className="text-3xl font-bold text-center text-slate-800">{t.title}</h2>
        <p className="text-center text-slate-400 mt-1 mb-8">
          {step === "details" ? t.subtitle : `Enter the code sent to ${phone}`}
        </p>

        {error && (
          <div className="mb-5 rounded-xl bg-red-50 border border-red-200 text-red-600 text-sm px-4 py-3 text-center">
            {error}
          </div>
        )}

        {step === "details" ? (
          <form onSubmit={handleSendCode} className="space-y-5">
            <Field label="Full Name">
              <User className="w-5 h-5 text-slate-400" />
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Parent name"
                required
                className="flex-1 bg-transparent outline-none text-slate-700 placeholder:text-slate-400"
              />
            </Field>

            <Field label="Phone Number">
              <Phone className="w-5 h-5 text-slate-400" />
              <input
                type="tel"
                value={phone}
                onChange={(e) => setPhone(e.target.value)}
                placeholder="050-0000000"
                required
                className="flex-1 bg-transparent outline-none text-slate-700 placeholder:text-slate-400"
              />
            </Field>

            <SubmitButton busy={busy}>{busy ? "Sending code..." : t.submit}</SubmitButton>
          </form>
        ) : (
          <form onSubmit={handleVerify} className="space-y-5">
            <Field label="Verification Code">
              <KeyRound className="w-5 h-5 text-slate-400" />
              <input
                type="text"
                inputMode="numeric"
                value={code}
                onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
                placeholder="------"
                maxLength={6}
                required
                className="flex-1 bg-transparent outline-none text-slate-700 placeholder:text-slate-400 text-center tracking-[0.5em] text-lg"
              />
            </Field>

            <SubmitButton busy={busy}>{busy ? "Verifying..." : "Confirm"}</SubmitButton>

            <button
              type="button"
              onClick={() => {
                setStep("details");
                setCode("");
                setError("");
              }}
              className="w-full text-sm text-slate-400 hover:text-slate-600 transition-colors"
            >
              Back / change number
            </button>
          </form>
        )}

        {step === "details" && (
          <div className="mt-6 text-center">
            <Link
              href={t.switchTo}
              className="text-blue-500 font-medium hover:text-blue-600 transition-colors"
            >
              {t.switchText}
            </Link>
          </div>
        )}

        {step === "details" && demoOffered && (
          <div className="mt-6 pt-6 border-t border-slate-100">
            <button
              type="button"
              onClick={handleDemo}
              disabled={busy}
              className="w-full flex items-center justify-center gap-2 bg-slate-800 hover:bg-slate-900 disabled:opacity-60 text-white font-semibold py-3.5 rounded-2xl transition-colors"
            >
              <PlayCircle className="w-5 h-5" />
              Try the demo — no phone needed
            </button>
            <p className="mt-3 text-xs text-slate-400 text-center">
              Opens a shared demo account so you can explore the dashboard and
              simulate a detection. No SMS is ever sent.
            </p>
          </div>
        )}
      </div>

      <p className="mt-8 text-xs text-slate-400 text-center">
        Smart system to prevent children from being left in cars
      </p>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <label className="block text-slate-700 font-semibold mb-2">{label}</label>
      <div className="flex items-center gap-3 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3.5 focus-within:border-blue-400 transition-colors">
        {children}
      </div>
    </div>
  );
}

function SubmitButton({ busy, children }: { busy: boolean; children: React.ReactNode }) {
  return (
    <button
      type="submit"
      disabled={busy}
      className="w-full flex items-center justify-center gap-2 bg-blue-400 hover:bg-blue-500 disabled:opacity-60 text-white font-semibold py-3.5 rounded-2xl shadow-md shadow-blue-300/40 transition-colors"
    >
      {busy && <Loader2 className="w-5 h-5 animate-spin" />}
      {children}
    </button>
  );
}
