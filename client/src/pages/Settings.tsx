import { useState, useEffect } from "react";
import { useLocation } from "wouter";
import { useQuery } from "@tanstack/react-query";
import {
  Shield, ArrowLeft, User, Phone, MapPin, Users, Plus, Trash2,
  Loader2, Check, KeyRound, Cpu, Copy, UserCheck,
} from "lucide-react";
import { Switch } from "@/components/ui/switch";
import {
  getAccount, updateName, updateContacts, updateLocation, updateTeensMature,
  requestPhoneChange, verifyPhoneChange, type Account,
} from "@/lib/auth";
import { queryClient } from "@/lib/queryClient";
import { AUTH_QUERY_KEY } from "@/hooks/use-auth";

const ACCOUNT_KEY = ["/account"];
const MAX_CONTACTS = 5;
const SAVED = "Saved";

export default function Settings() {
  const [, setLocation] = useLocation();
  const { data: account, isLoading } = useQuery<Account>({
    queryKey: ACCOUNT_KEY,
    queryFn: getAccount,
    retry: false,
  });

  if (isLoading || !account) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-blue-50">
        <Loader2 className="w-8 h-8 text-blue-400 animate-spin" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-gradient-to-b from-blue-50 to-blue-100 font-sans pb-16">
      <header className="sticky top-0 z-10 bg-white/80 backdrop-blur-md border-b border-blue-100">
        <div className="max-w-2xl mx-auto px-4 h-16 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <div className="w-9 h-9 rounded-full bg-blue-400 flex items-center justify-center">
              <Shield className="w-5 h-5 text-white" />
            </div>
            <span className="font-bold text-lg text-slate-800">Settings</span>
          </div>
          <button
            onClick={() => setLocation("/")}
            className="flex items-center gap-1 text-sm text-blue-500 hover:text-blue-600"
          >
            <ArrowLeft className="w-4 h-4" /> Back to dashboard
          </button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-8 space-y-6">
        <NameSection account={account} />
        <PhoneSection account={account} />
        <MaturitySection account={account} />
        <LocationSection account={account} />
        <ContactsSection account={account} />
        <DeviceKeySection account={account} />
      </main>
    </div>
  );
}

function refresh() {
  queryClient.invalidateQueries({ queryKey: ACCOUNT_KEY });
}

function Card({ icon, title, children }: { icon: React.ReactNode; title: string; children: React.ReactNode }) {
  return (
    <section className="bg-white rounded-3xl shadow-sm p-6">
      <div className="flex items-center gap-2 mb-5">
        <div className="text-blue-400">{icon}</div>
        <h2 className="font-bold text-lg text-slate-800">{title}</h2>
      </div>
      {children}
    </section>
  );
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 outline-none focus:border-blue-400 transition-colors ${props.className || ""}`}
    />
  );
}

function PrimaryButton({ busy, children, ...rest }: { busy?: boolean } & React.ButtonHTMLAttributes<HTMLButtonElement>) {
  return (
    <button
      {...rest}
      disabled={busy || rest.disabled}
      className="flex items-center justify-center gap-2 bg-blue-400 hover:bg-blue-500 disabled:opacity-60 text-white font-semibold px-5 py-2.5 rounded-2xl transition-colors"
    >
      {busy && <Loader2 className="w-4 h-4 animate-spin" />}
      {children}
    </button>
  );
}

function StatusMsg({ text, ok }: { text: string; ok?: boolean }) {
  if (!text) return null;
  return (
    <p className={`text-sm ${ok ? "text-emerald-600" : "text-red-500"}`}>{text}</p>
  );
}

function MaturitySection({ account }: { account: Account }) {
  const [value, setValue] = useState(account.teens_mature);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function toggle(next: boolean) {
    setValue(next);
    setBusy(true);
    setMsg("");
    try {
      await updateTeensMature(next);
      refresh();
      setMsg(SAVED);
    } catch (e) {
      setValue(!next); // revert on failure
      setMsg(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card icon={<UserCheck className="w-5 h-5" />} title="Teen (13–20) as a child's guardian">
      <div className="flex items-center justify-between gap-4">
        <p className="text-slate-500 text-sm flex-1">
          A teen (13–20) can always be alone — that never triggers an alert. This toggle only
          decides whether they count as a <b>guardian</b> for a young child (0–12): when on, a
          child with a teen is safe; when off, only an adult (21+) can supervise, so a child alone
          with a teen triggers an alert.
        </p>
        <Switch checked={value} onCheckedChange={toggle} disabled={busy} />
      </div>
      <div className="mt-2"><StatusMsg text={msg} ok={msg === SAVED} /></div>
      <p className="mt-2 text-xs text-slate-400">Changes apply within a few seconds (no restart needed).</p>
    </Card>
  );
}

function DeviceKeySection({ account }: { account: Account }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(account.device_key);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      /* clipboard unavailable */
    }
  }

  return (
    <Card icon={<Cpu className="w-5 h-5" />} title="Device key (camera)">
      <p className="text-slate-500 text-sm mb-4">
        Paste this key into the camera script (DEVICE_KEY) so its alerts reach only your account.
      </p>
      <div className="flex gap-2 items-center">
        <code className="flex-1 bg-slate-50 border border-slate-200 rounded-2xl px-4 py-3 text-slate-700 tracking-wider select-all">
          {account.device_key || "—"}
        </code>
        <button
          onClick={copy}
          className="shrink-0 flex items-center gap-1.5 bg-blue-400 hover:bg-blue-500 text-white font-semibold px-4 py-3 rounded-2xl transition-colors"
        >
          {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />}
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
    </Card>
  );
}

function NameSection({ account }: { account: Account }) {
  const [name, setName] = useState(account.name);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  async function save() {
    setBusy(true); setMsg("");
    try {
      await updateName(name.trim());
      queryClient.setQueryData(AUTH_QUERY_KEY, (u: any) => (u ? { ...u, name: name.trim() } : u));
      refresh();
      setMsg(SAVED);
    } catch (e) {
      setMsg(e instanceof Error ? e.message : "Something went wrong");
    } finally { setBusy(false); }
  }

  return (
    <Card icon={<User className="w-5 h-5" />} title="Parent name">
      <div className="flex gap-3">
        <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Full name" />
        <PrimaryButton busy={busy} onClick={save} disabled={!name.trim() || name === account.name}>
          Save
        </PrimaryButton>
      </div>
      <div className="mt-2"><StatusMsg text={msg} ok={msg === SAVED} /></div>
    </Card>
  );
}

function PhoneSection({ account }: { account: Account }) {
  const [step, setStep] = useState<"idle" | "phone" | "code">("idle");
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const UPDATED = "Number updated";

  async function sendCode() {
    setBusy(true); setMsg("");
    try {
      await requestPhoneChange(phone.trim());
      setStep("code");
    } catch (e) { setMsg(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }

  async function verify() {
    setBusy(true); setMsg("");
    try {
      await verifyPhoneChange(phone.trim(), code.trim());
      queryClient.setQueryData(AUTH_QUERY_KEY, (u: any) => (u ? { ...u, phone: phone.trim() } : u));
      refresh();
      setStep("idle"); setPhone(""); setCode("");
      setMsg(UPDATED);
    } catch (e) { setMsg(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }

  return (
    <Card icon={<Phone className="w-5 h-5" />} title="Phone number">
      <p className="text-slate-500 mb-4">{account.phone}</p>

      {step === "idle" && (
        <button onClick={() => { setStep("phone"); setMsg(""); }} className="text-blue-500 font-medium hover:text-blue-600">
          Change phone number
        </button>
      )}

      {step === "phone" && (
        <div className="flex gap-3">
          <Input value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="050-0000000" type="tel" />
          <PrimaryButton busy={busy} onClick={sendCode} disabled={!phone.trim()}>Send code</PrimaryButton>
        </div>
      )}

      {step === "code" && (
        <div className="flex gap-3">
          <Input value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} placeholder="Verification code" maxLength={6} className="text-center tracking-widest" />
          <PrimaryButton busy={busy} onClick={verify} disabled={code.length < 4}>
            <KeyRound className="w-4 h-4" /> Confirm
          </PrimaryButton>
        </div>
      )}

      <div className="mt-2"><StatusMsg text={msg} ok={msg === UPDATED} /></div>
    </Card>
  );
}

function LocationSection({ account }: { account: Account }) {
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");
  const SAVED_LOC = "Location saved";

  function share() {
    setMsg(""); setBusy(true);
    if (!navigator.geolocation) {
      setMsg("This browser doesn't support geolocation"); setBusy(false); return;
    }
    navigator.geolocation.getCurrentPosition(
      async (pos) => {
        try {
          await updateLocation(pos.coords.latitude, pos.coords.longitude);
          refresh();
          setMsg(SAVED_LOC);
        } catch (e) { setMsg(e instanceof Error ? e.message : "Something went wrong"); }
        finally { setBusy(false); }
      },
      () => { setMsg("Couldn't get location — permission required"); setBusy(false); },
      { enableHighAccuracy: true, timeout: 10000 },
    );
  }

  const loc = account.location;
  return (
    <Card icon={<MapPin className="w-5 h-5" />} title="Vehicle / device location">
      <p className="text-slate-500 text-sm mb-4">
        Share the location of the device the camera is installed on. It will be sent to your
        emergency contacts when an alert escalates.
      </p>
      {loc && (
        <a
          href={`https://maps.google.com/?q=${loc.lat},${loc.lng}`}
          target="_blank" rel="noreferrer"
          className="inline-flex items-center gap-1 text-blue-500 hover:text-blue-600 text-sm mb-4"
        >
          <MapPin className="w-4 h-4" /> View saved location on map
        </a>
      )}
      <div>
        <PrimaryButton busy={busy} onClick={share}>
          <MapPin className="w-4 h-4" /> {loc ? "Update location" : "Share location"}
        </PrimaryButton>
      </div>
      <div className="mt-2"><StatusMsg text={msg} ok={msg === SAVED_LOC} /></div>
    </Card>
  );
}

function ContactsSection({ account }: { account: Account }) {
  const [contacts, setContacts] = useState<string[]>(
    account.emergency_contacts.length ? account.emergency_contacts : [""],
  );
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState("");

  useEffect(() => {
    setContacts(account.emergency_contacts.length ? account.emergency_contacts : [""]);
  }, [account.emergency_contacts]);

  function setAt(i: number, val: string) {
    setContacts((c) => c.map((x, idx) => (idx === i ? val : x)));
  }
  function add() {
    if (contacts.length < MAX_CONTACTS) setContacts((c) => [...c, ""]);
  }
  function remove(i: number) {
    setContacts((c) => c.filter((_, idx) => idx !== i));
  }

  async function save() {
    setBusy(true); setMsg("");
    try {
      const cleaned = contacts.map((c) => c.trim()).filter(Boolean);
      const saved = await updateContacts(cleaned);
      setContacts(saved.length ? saved : [""]);
      refresh();
      setMsg(SAVED);
    } catch (e) { setMsg(e instanceof Error ? e.message : "Something went wrong"); }
    finally { setBusy(false); }
  }

  return (
    <Card icon={<Users className="w-5 h-5" />} title={`Emergency contacts (up to ${MAX_CONTACTS})`}>
      <p className="text-slate-500 text-sm mb-4">
        If you don't respond to an alert within 2 minutes, these contacts get an SMS.
      </p>
      <div className="space-y-3">
        {contacts.map((c, i) => (
          <div key={i} className="flex gap-2 items-center">
            <Input
              value={c}
              onChange={(e) => setAt(i, e.target.value)}
              placeholder="050-0000000"
              type="tel"
            />
            <button
              onClick={() => remove(i)}
              className="shrink-0 w-10 h-10 flex items-center justify-center rounded-xl text-red-400 hover:bg-red-50"
              title="Remove"
            >
              <Trash2 className="w-5 h-5" />
            </button>
          </div>
        ))}
      </div>

      <div className="flex items-center justify-between mt-4">
        <button
          onClick={add}
          disabled={contacts.length >= MAX_CONTACTS}
          className="flex items-center gap-1 text-blue-500 hover:text-blue-600 disabled:opacity-40 text-sm font-medium"
        >
          <Plus className="w-4 h-4" /> Add contact
        </button>
        <PrimaryButton busy={busy} onClick={save}>
          <Check className="w-4 h-4" /> Save
        </PrimaryButton>
      </div>
      <div className="mt-2"><StatusMsg text={msg} ok={msg === SAVED} /></div>
    </Card>
  );
}
