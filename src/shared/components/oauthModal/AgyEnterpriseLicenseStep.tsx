"use client";

import { useCallback, useEffect, useState } from "react";
import Button from "../Button";

type License = {
  licenseId: string;
  projectId: string;
  location: string;
  userTier: string;
  tierDisplayName?: string;
  supported: boolean;
};
export type AgyEnterpriseSetup = { setupId: string; expiresAt: number };

export async function agyEnterpriseSetupAction(
  action: string,
  setupId: string,
  extra: Record<string, string> = {}
) {
  const response = await fetch(
    `/api/oauth/agy-enterprise/${action}${action === "licenses" ? `?setupId=${encodeURIComponent(setupId)}` : ""}`,
    {
      method: action === "licenses" ? "GET" : "POST",
      ...(action === "licenses"
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ setupId, ...extra }),
          }),
    }
  );
  const data = await response.json();
  if (!response.ok)
    throw Object.assign(
      new Error(
        typeof data.error === "string"
          ? data.error
          : "Enterprise setup failed. Retry or sign in again."
      ),
      { status: response.status }
    );
  return data;
}

export default function AgyEnterpriseLicenseStep({
  setup,
  onSaved,
  onSignInAgain,
}: {
  setup: AgyEnterpriseSetup;
  onSaved: () => void;
  onSignInAgain: () => void;
}) {
  const [licenses, setLicenses] = useState<License[]>([]);
  const [selected, setSelected] = useState("");
  const [email, setEmail] = useState("");
  const [project, setProject] = useState("");
  const [location, setLocation] = useState("us");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [expired, setExpired] = useState(() => Date.now() >= setup.expiresAt);
  const acceptLicenses = useCallback((entries: License[]) => {
    setLicenses(entries);
    const supported = entries.filter((entry) => entry.supported);
    if (supported.length === 1) setSelected(supported[0].licenseId);
  }, []);
  const discover = useCallback(async () => {
    setBusy(true);
    setError("");
    try {
      const data = await agyEnterpriseSetupAction("licenses", setup.setupId);
      setEmail(data.email);
      acceptLicenses(data.licenses);
      if (data.discoveryError) setError(data.discoveryError);
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 410) setExpired(true);
      setError(error instanceof Error ? error.message : "License discovery failed");
    } finally {
      setBusy(false);
    }
  }, [setup.setupId, acceptLicenses]);
  useEffect(() => {
    void Promise.resolve().then(discover);
  }, [discover]);
  useEffect(() => {
    const timer = setTimeout(() => setExpired(true), Math.max(0, setup.expiresAt - Date.now()));
    return () => clearTimeout(timer);
  }, [setup.expiresAt]);
  const submit = async (action: "verify-project" | "finalize") => {
    setBusy(true);
    setError("");
    try {
      const data = await agyEnterpriseSetupAction(
        action,
        setup.setupId,
        action === "finalize" ? { licenseId: selected } : { projectId: project.trim(), location }
      );
      if (data.status === "completed") onSaved();
      else {
        acceptLicenses(data.licenses);
        setSelected(data.verifiedLicenseId);
      }
    } catch (error) {
      if (error instanceof Error && "status" in error && error.status === 410) setExpired(true);
      setError(error instanceof Error ? error.message : "Enterprise setup failed");
    } finally {
      setBusy(false);
    }
  };
  if (expired)
    return (
      <div role="alert">
        <p>Enterprise setup expired. Sign in again.</p>
        <Button onClick={onSignInAgain}>Sign in again</Button>
      </div>
    );
  return (
    <div className="flex flex-col gap-3" aria-busy={busy}>
      <p>
        Select an Enterprise license for {email || "your Google account"}. Nothing is saved until
        you click Save.
      </p>
      {error && (
        <p role="alert" className="text-red-500">
          {error}
        </p>
      )}
      <fieldset disabled={busy} className="flex flex-col gap-2">
        <legend>Enterprise licenses</legend>
        {licenses.map((license) => (
          <label key={license.licenseId} className="flex items-start gap-2">
            <input
              type="radio"
              name="agy-enterprise-license"
              value={license.licenseId}
              checked={selected === license.licenseId}
              disabled={!license.supported}
              onChange={() => setSelected(license.licenseId)}
            />
            <span>
              {license.projectId} · {license.location} ·{" "}
              {license.tierDisplayName || license.userTier}
              {!license.supported && " — unsupported location; US and EU only"}
            </span>
          </label>
        ))}
        {!licenses.length && !busy && (
          <p>No licenses found. Retry discovery or verify a project below.</p>
        )}
      </fieldset>
      <Button variant="secondary" disabled={busy} onClick={discover}>
        Retry discovery
      </Button>
      <label className="flex flex-col gap-1">
        Custom Google Cloud project ID
        <input
          className="rounded border border-border p-2"
          value={project}
          disabled={busy}
          onChange={(event) => setProject(event.target.value)}
          placeholder="my-enterprise-project"
        />
      </label>
      <label className="flex flex-col gap-1">
        License region
        <select
          aria-label="License region"
          className="rounded border border-border p-2"
          value={location}
          disabled={busy}
          onChange={(event) => setLocation(event.target.value)}
        >
          <option value="us">US</option>
          <option value="eu">EU</option>
        </select>
      </label>
      <p className="text-sm text-text-muted">
        Verify project requests a license assignment in the selected region. Closing this setup
        cannot undo that assignment.
      </p>
      <Button
        variant="secondary"
        disabled={busy || !email || !project.trim()}
        onClick={() => submit("verify-project")}
      >
        Verify project
      </Button>
      <Button
        disabled={
          busy ||
          !selected ||
          !licenses.some((license) => license.licenseId === selected && license.supported)
        }
        onClick={() => submit("finalize")}
      >
        {busy ? "Working…" : "Save"}
      </Button>
      <p className="text-sm text-text-muted">
        Text chat supports discovered models and custom experience IDs. Model availability depends
        on your license. Tool calls and images are not supported.
      </p>
    </div>
  );
}
