// Phone-OTP auth client. Session token is kept in localStorage and is valid
// for one year (the server enforces the real expiry).

const TOKEN_KEY = "kidsafe_token";

// Sent on every API call so ngrok-free serves the request instead of its
// "browser warning" interstitial (which would break JSON responses).
const COMMON_HEADERS = { "ngrok-skip-browser-warning": "true" };

export interface AuthUser {
  name: string;
  phone: string;
  expires_at: number;
  demo?: boolean;
}

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

function setToken(token: string) {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken() {
  localStorage.removeItem(TOKEN_KEY);
}

async function readError(res: Response, fallback: string): Promise<string> {
  try {
    const data = await res.json();
    return data?.message || fallback;
  } catch {
    return fallback;
  }
}

// Step 1: send an SMS code to the parent's phone.
export async function requestCode(name: string, phone: string): Promise<void> {
  const res = await fetch("/auth/request-code", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...COMMON_HEADERS },
    body: JSON.stringify({ name, phone }),
  });
  if (!res.ok) throw new Error(await readError(res, "Failed to send the code"));
}

// Step 2: verify the code; on success the session token is stored.
export async function verifyCode(
  name: string,
  phone: string,
  code: string,
): Promise<AuthUser> {
  const res = await fetch("/auth/verify", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...COMMON_HEADERS },
    body: JSON.stringify({ name, phone, code }),
  });
  if (!res.ok) throw new Error(await readError(res, "Invalid or expired code"));
  const data = await res.json();
  setToken(data.token);
  return { name: data.name, phone: data.phone, expires_at: data.expires_at };
}

// Is the one-click demo login offered by this server? (Public — no token.)
export async function demoAvailable(): Promise<boolean> {
  try {
    const res = await fetch("/auth/demo-status", { headers: { ...COMMON_HEADERS } });
    if (!res.ok) return false;
    return !!(await res.json()).enabled;
  } catch {
    return false; // treat an unreachable server as "no demo"
  }
}

// Log into the shared demo account — no phone, no SMS code.
export async function demoLogin(): Promise<AuthUser> {
  const res = await fetch("/auth/demo", {
    method: "POST",
    headers: { "Content-Type": "application/json", ...COMMON_HEADERS },
  });
  if (!res.ok) throw new Error(await readError(res, "Demo login is unavailable"));
  const data = await res.json();
  setToken(data.token);
  return { name: data.name, phone: data.phone, expires_at: data.expires_at, demo: true };
}

// Classify one cropped face into an age band, using the same model the camera
// detector runs. Returns null when the server has no ML packages installed.
export async function classifyFaceAge(imageBase64: string): Promise<string | null> {
  try {
    const res = await authFetch("/demo/age", {
      method: "POST",
      body: JSON.stringify({ image: imageBase64 }),
    });
    const data = await res.json();
    return data.available ? (data.label as string) : null;
  } catch {
    return null;
  }
}

// Simulate a detection on the demo account (stands in for the camera script).
export async function triggerDemoAlert(status: "CHILD_ONLY" | "SAFE"): Promise<void> {
  await authFetch("/demo/alert", { method: "POST", body: JSON.stringify({ status }) });
}

// Returns the logged-in parent, or null if no valid session.
export async function fetchMe(): Promise<AuthUser | null> {
  const token = getToken();
  if (!token) return null;
  const res = await fetch("/auth/me", {
    headers: { Authorization: `Bearer ${token}`, ...COMMON_HEADERS },
  });
  if (res.status === 401) {
    clearToken();
    return null;
  }
  if (!res.ok) throw new Error("Connection error");
  return res.json();
}

// fetch wrapper that attaches the Bearer token and throws on errors.
export async function authFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const token = getToken();
  const res = await fetch(url, {
    ...init,
    headers: {
      ...COMMON_HEADERS,
      ...(init.body ? { "Content-Type": "application/json" } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(init.headers || {}),
    },
  });
  if (res.status === 401) {
    clearToken();
    throw new Error("Session expired");
  }
  if (!res.ok) throw new Error(await readError(res, "Something went wrong"));
  return res;
}

export interface DeviceLocation {
  lat: number;
  lng: number;
  updated_at: number;
}

export interface Account {
  name: string;
  phone: string;
  emergency_contacts: string[];
  location: DeviceLocation | null;
  device_key: string;
  teens_mature: boolean;
  expires_at: number;
  demo?: boolean;
}

export async function getAccount(): Promise<Account> {
  return (await authFetch("/account")).json();
}

export async function updateName(name: string): Promise<void> {
  await authFetch("/account/name", { method: "POST", body: JSON.stringify({ name }) });
}

export async function updateContacts(contacts: string[]): Promise<string[]> {
  const res = await authFetch("/account/contacts", {
    method: "POST",
    body: JSON.stringify({ contacts }),
  });
  return (await res.json()).emergency_contacts;
}

export async function updateTeensMature(value: boolean): Promise<void> {
  await authFetch("/account/teens-mature", {
    method: "POST",
    body: JSON.stringify({ value }),
  });
}

export async function updateLocation(lat: number, lng: number): Promise<void> {
  await authFetch("/account/location", {
    method: "POST",
    body: JSON.stringify({ lat, lng }),
  });
}

export async function requestPhoneChange(phone: string): Promise<void> {
  await authFetch("/account/phone/request", {
    method: "POST",
    body: JSON.stringify({ phone }),
  });
}

export async function verifyPhoneChange(phone: string, code: string): Promise<string> {
  const res = await authFetch("/account/phone/verify", {
    method: "POST",
    body: JSON.stringify({ phone, code }),
  });
  return (await res.json()).phone;
}

// The SMS sent (or, on the demo account, that *would* be sent) to the
// emergency contacts when an alert goes unacknowledged.
export interface EscalationSms {
  to: string[];
  message: string;
  sent: boolean;
  demo: boolean;
}

export interface PendingAlert {
  pending: boolean;
  /** The parent pressed "I'm nearby" — escalation is off, but the emergency
   *  stays open until the camera reports an adult. */
  acknowledged?: boolean;
  id?: number;
  message?: string;
  age?: number;
  escalated?: boolean;
  escalates_after?: number;
  escalation_sms?: EscalationSms | null;
}

export async function getPendingAlert(): Promise<PendingAlert> {
  const token = getToken();
  const res = await fetch("/alerts/pending", {
    headers: token ? { Authorization: `Bearer ${token}`, ...COMMON_HEADERS } : { ...COMMON_HEADERS },
  });
  if (!res.ok) return { pending: false };
  return res.json();
}

export async function acknowledgeAlert(): Promise<void> {
  await authFetch("/alerts/ack", { method: "POST" });
}

export interface CameraInfo {
  index: number;
  name: string;
}

export interface CameraState {
  cameras: CameraInfo[];
  running: boolean;
  index: number | null;
}

export async function listCameras(): Promise<CameraState> {
  return (await authFetch("/cameras")).json();
}

export async function startCamera(index: number): Promise<void> {
  await authFetch("/camera/start", { method: "POST", body: JSON.stringify({ index }) });
}

export async function stopCamera(): Promise<void> {
  await authFetch("/camera/stop", { method: "POST" });
}

export async function cameraStatus(): Promise<{ running: boolean; index: number | null }> {
  return (await authFetch("/camera/status")).json();
}

export async function logout(): Promise<void> {
  const token = getToken();
  if (token) {
    try {
      await fetch("/auth/logout", {
        method: "POST",
        headers: { Authorization: `Bearer ${token}`, ...COMMON_HEADERS },
      });
    } catch {
      // ignore network errors on logout
    }
  }
  clearToken();
}
